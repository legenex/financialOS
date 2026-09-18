/**
 * Financial accounts and the rules that decide whose money a single transaction is.
 *
 * Ownership rules:
 * - `legalEntityId` (who holds the account) and `economicOwnerEntityId` (whose money it is)
 *   are independent and both nullable. NULL means "not confirmed", never "the owner".
 * - `ownershipConfirmed` may only be true when both sides are set.
 * - Account-level ownership can be overridden per transaction by an
 *   `account_ownership_rules` row (card last four, card id, description pattern,
 *   counterparty). Rules are applied in ascending `priority`, first match wins.
 */
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { normaliseText } from '@financialos/domain';
import {
  accountOwnershipRules,
  accounts,
  OWNERSHIP_RULE_MATCH_KINDS,
  type AccountCreatedFrom,
  type AccountKindValue,
  type LiquidityClassValue,
} from '../schema/accounts';
import { InvalidError, mapErrors, pickDefined, required, type DbOrTx } from './_util';

export type AccountRow = typeof accounts.$inferSelect;
export type AccountOwnershipRuleRow = typeof accountOwnershipRules.$inferSelect;
export type OwnershipRuleMatchKind = (typeof OWNERSHIP_RULE_MATCH_KINDS)[number];

export interface CreateAccountInput {
  name: string;
  kind: AccountKindValue;
  liquidityClass: LiquidityClassValue;
  createdFrom: AccountCreatedFrom;
  /** NULL for multi-currency accounts. */
  currency?: string | null;
  institutionId?: string | null;
  legalEntityId?: string | null;
  economicOwnerEntityId?: string | null;
  ownershipConfirmed?: boolean;
  includeInSafeToSpend?: boolean;
  /** At most four digits, at most 32 characters. Full account numbers are never stored. */
  maskedIdentifier?: string | null;
  notes?: string | null;
  provenance?: Record<string, unknown>;
  connectionId?: string | null;
  openedOn?: string | null;
  bootstrapKey?: string | null;
}

function checkOwnership(input: { legalEntityId?: string | null; economicOwnerEntityId?: string | null; ownershipConfirmed?: boolean }): void {
  if (!input.ownershipConfirmed) return;
  if (!input.legalEntityId || !input.economicOwnerEntityId) {
    throw new InvalidError('Ownership can only be confirmed when both the legal entity and the economic owner are known');
  }
}

export async function createAccount(db: DbOrTx, input: CreateAccountInput): Promise<AccountRow> {
  checkOwnership(input);
  return mapErrors('create account', async () => {
    const [row] = await db
      .insert(accounts)
      .values({
        name: input.name,
        kind: input.kind,
        liquidityClass: input.liquidityClass,
        createdFrom: input.createdFrom,
        currency: input.currency ?? null,
        institutionId: input.institutionId ?? null,
        legalEntityId: input.legalEntityId ?? null,
        economicOwnerEntityId: input.economicOwnerEntityId ?? null,
        ownershipConfirmed: input.ownershipConfirmed ?? false,
        includeInSafeToSpend: input.includeInSafeToSpend ?? false,
        maskedIdentifier: input.maskedIdentifier ?? null,
        notes: input.notes ?? null,
        provenance: input.provenance ?? {},
        connectionId: input.connectionId ?? null,
        openedOn: input.openedOn ?? null,
        bootstrapKey: input.bootstrapKey ?? null,
      })
      .returning();
    return required(row, 'account');
  });
}

export type UpdateAccountInput = Partial<Omit<CreateAccountInput, 'bootstrapKey' | 'createdFrom'>>;

export async function updateAccount(db: DbOrTx, id: string, patch: UpdateAccountInput): Promise<AccountRow> {
  const values = pickDefined(patch);
  if (Object.keys(values).length === 0) return required(await getAccount(db, id), 'account');
  if (patch.ownershipConfirmed) {
    const current = required(await getAccount(db, id), 'account');
    checkOwnership({
      legalEntityId: patch.legalEntityId !== undefined ? patch.legalEntityId : current.legalEntityId,
      economicOwnerEntityId: patch.economicOwnerEntityId !== undefined ? patch.economicOwnerEntityId : current.economicOwnerEntityId,
      ownershipConfirmed: true,
    });
  }
  return mapErrors('update account', async () => {
    const [row] = await db.update(accounts).set(values).where(eq(accounts.id, id)).returning();
    return required(row, 'account');
  });
}

/**
 * Sets the legal holder and/or economic owner. Passing `null` clears a side back to
 * "unconfirmed"; omitting a side leaves it untouched.
 */
export async function setAccountOwnership(
  db: DbOrTx,
  id: string,
  input: { legalEntityId?: string | null; economicOwnerEntityId?: string | null; confirmed?: boolean },
): Promise<AccountRow> {
  const patch: UpdateAccountInput = {};
  if (input.legalEntityId !== undefined) patch.legalEntityId = input.legalEntityId;
  if (input.economicOwnerEntityId !== undefined) patch.economicOwnerEntityId = input.economicOwnerEntityId;
  if (input.confirmed !== undefined) patch.ownershipConfirmed = input.confirmed;
  return updateAccount(db, id, patch);
}

export async function closeAccount(db: DbOrTx, id: string, closedOn: string): Promise<AccountRow> {
  const [row] = await db.update(accounts).set({ status: 'closed', closedOn }).where(eq(accounts.id, id)).returning();
  return required(row, 'account');
}

export async function reopenAccount(db: DbOrTx, id: string): Promise<AccountRow> {
  const [row] = await db.update(accounts).set({ status: 'active', closedOn: null }).where(eq(accounts.id, id)).returning();
  return required(row, 'account');
}

export async function getAccount(db: DbOrTx, id: string): Promise<AccountRow | undefined> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  return row;
}

export async function getAccountByBootstrapKey(db: DbOrTx, key: string): Promise<AccountRow | undefined> {
  const [row] = await db.select().from(accounts).where(eq(accounts.bootstrapKey, key)).limit(1);
  return row;
}

export interface AccountQuery {
  legalEntityId?: string;
  economicOwnerEntityId?: string;
  kind?: AccountKindValue | AccountKindValue[];
  liquidityClass?: LiquidityClassValue | LiquidityClassValue[];
  status?: 'active' | 'closed';
  connectionId?: string;
  includeInSafeToSpend?: boolean;
}

export async function listAccounts(db: DbOrTx, query: AccountQuery = {}): Promise<AccountRow[]> {
  const conditions: SQL[] = [];
  if (query.legalEntityId) conditions.push(eq(accounts.legalEntityId, query.legalEntityId));
  if (query.economicOwnerEntityId) conditions.push(eq(accounts.economicOwnerEntityId, query.economicOwnerEntityId));
  if (query.kind) conditions.push(inArray(accounts.kind, Array.isArray(query.kind) ? query.kind : [query.kind]));
  if (query.liquidityClass) {
    conditions.push(inArray(accounts.liquidityClass, Array.isArray(query.liquidityClass) ? query.liquidityClass : [query.liquidityClass]));
  }
  if (query.status) conditions.push(eq(accounts.status, query.status));
  if (query.connectionId) conditions.push(eq(accounts.connectionId, query.connectionId));
  if (query.includeInSafeToSpend !== undefined) conditions.push(eq(accounts.includeInSafeToSpend, query.includeInSafeToSpend));
  return db
    .select()
    .from(accounts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(accounts.name));
}

// ---------------------------------------------------------------------------------------
// Account ownership rules
// ---------------------------------------------------------------------------------------

export interface OwnershipRuleInput {
  accountId: string;
  matchKind: OwnershipRuleMatchKind;
  /** Four digits for `card_last4`; a free pattern for the other kinds. */
  pattern: string;
  economicOwnerEntityId: string;
  priority?: number;
  notes?: string | null;
  createdBy?: string;
}

export async function createOwnershipRule(db: DbOrTx, input: OwnershipRuleInput): Promise<AccountOwnershipRuleRow> {
  if (input.matchKind === 'card_last4' && !/^[0-9]{4}$/.test(input.pattern)) {
    throw new InvalidError('A card_last4 rule needs exactly four digits');
  }
  if (input.matchKind === 'card_id' && input.pattern.replace(/\D/g, '').length > 4) {
    throw new InvalidError('A card_id rule must not contain more than four digits');
  }
  return mapErrors('create ownership rule', async () => {
    const [row] = await db
      .insert(accountOwnershipRules)
      .values({
        accountId: input.accountId,
        matchKind: input.matchKind,
        pattern: input.pattern,
        economicOwnerEntityId: input.economicOwnerEntityId,
        priority: input.priority ?? 100,
        notes: input.notes ?? null,
        createdBy: input.createdBy ?? 'owner',
      })
      .returning();
    return required(row, 'ownership rule');
  });
}

export async function updateOwnershipRule(
  db: DbOrTx,
  id: string,
  patch: Partial<Pick<OwnershipRuleInput, 'pattern' | 'economicOwnerEntityId' | 'priority' | 'notes'>> & { active?: boolean },
): Promise<AccountOwnershipRuleRow> {
  return mapErrors('update ownership rule', async () => {
    const [row] = await db.update(accountOwnershipRules).set(pickDefined(patch)).where(eq(accountOwnershipRules.id, id)).returning();
    return required(row, 'ownership rule');
  });
}

export async function deactivateOwnershipRule(db: DbOrTx, id: string): Promise<AccountOwnershipRuleRow> {
  return updateOwnershipRule(db, id, { active: false });
}

export async function listOwnershipRules(db: DbOrTx, accountId: string, options: { includeInactive?: boolean } = {}): Promise<AccountOwnershipRuleRow[]> {
  const conditions: SQL[] = [eq(accountOwnershipRules.accountId, accountId)];
  if (!options.includeInactive) conditions.push(eq(accountOwnershipRules.active, true));
  return db
    .select()
    .from(accountOwnershipRules)
    .where(and(...conditions))
    .orderBy(asc(accountOwnershipRules.priority), asc(accountOwnershipRules.createdAt));
}

export interface OwnershipResolution {
  economicOwnerEntityId: string | null;
  source: 'ownership_rule' | 'account' | 'unknown';
  ruleId: string | null;
  explanation: string;
}

/**
 * Decides the economic owner of one transaction on an account: the first matching active
 * rule, otherwise the account's economic owner, otherwise unknown. Unknown is never
 * resolved to the primary owner by default.
 */
export async function resolveEconomicOwner(
  db: DbOrTx,
  accountId: string,
  transaction: { description?: string | null; cardLast4?: string | null; cardId?: string | null; counterpartyName?: string | null } = {},
): Promise<OwnershipResolution> {
  const rules = await listOwnershipRules(db, accountId);
  for (const rule of rules) {
    if (ruleMatchesTransaction(rule, transaction)) {
      return {
        economicOwnerEntityId: rule.economicOwnerEntityId,
        source: 'ownership_rule',
        ruleId: rule.id,
        explanation: `Rule ${rule.matchKind} "${rule.pattern}" on this account assigns the economic owner`,
      };
    }
  }
  const account = await getAccount(db, accountId);
  if (account?.economicOwnerEntityId) {
    return {
      economicOwnerEntityId: account.economicOwnerEntityId,
      source: 'account',
      ruleId: null,
      explanation: 'No rule matched; the account-level economic owner applies',
    };
  }
  return { economicOwnerEntityId: null, source: 'unknown', ruleId: null, explanation: 'No rule matched and the account has no confirmed economic owner' };
}

function ruleMatchesTransaction(
  rule: AccountOwnershipRuleRow,
  transaction: { description?: string | null; cardLast4?: string | null; cardId?: string | null; counterpartyName?: string | null },
): boolean {
  switch (rule.matchKind) {
    case 'card_last4':
      return Boolean(transaction.cardLast4) && transaction.cardLast4 === rule.pattern;
    case 'card_id':
      return Boolean(transaction.cardId) && transaction.cardId === rule.pattern;
    case 'description_pattern':
      return Boolean(transaction.description) && normaliseText(transaction.description as string).includes(normaliseText(rule.pattern));
    case 'counterparty':
      return Boolean(transaction.counterpartyName) && normaliseText(transaction.counterpartyName as string) === normaliseText(rule.pattern);
    default:
      return false;
  }
}
