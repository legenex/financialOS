/**
 * The per-entity chart of accounts.
 *
 * Codes are deterministic so that get-or-create is idempotent and concurrent workers
 * converge on the same ledger account:
 *
 *   3000            opening balance equity        (equity, multi-currency)
 *   1999            suspense                      (asset, multi-currency)
 *   1900-<CUR>      FX clearing for one currency  (asset, that currency)
 *   1300-<entity>   intercompany due from         (asset, multi-currency)
 *   2300-<entity>   intercompany due to           (liability, multi-currency)
 *   2100-<arr>      third-party clearing          (liability; per currency when given)
 *   1000-<account>  the ledger mirror of a real account
 *
 * `currency = NULL` means the ledger account may carry lines in several currencies. Each
 * currency still balances on its own inside every entry (the trading-account method).
 */
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { chartOf, type LedgerAccount as DomainLedgerAccount, type LedgerChart, type LedgerSystemRole } from '@financialos/domain';
import { ledgerAccounts, type LedgerAccountSubtype, type LedgerAccountType } from '../schema/ledger';
import { accounts } from '../schema/accounts';
import { InvalidError, mapErrors, required, tx, type DbOrTx } from './_util';

export type LedgerAccountRow = typeof ledgerAccounts.$inferSelect;

export const OPENING_BALANCE_EQUITY_CODE = '3000';
export const SUSPENSE_CODE = '1999';
export const OWNER_EQUITY_CODE = '3100';

export function fxClearingCode(currency: string): string {
  return `1900-${currency}`;
}
export function intercompanyDueFromCode(counterpartyEntityId: string): string {
  return `1300-${counterpartyEntityId}`;
}
export function intercompanyDueToCode(counterpartyEntityId: string): string {
  return `2300-${counterpartyEntityId}`;
}
export function thirdPartyClearingCode(arrangementId: string, currency?: string | null): string {
  return currency ? `2100-${arrangementId}-${currency}` : `2100-${arrangementId}`;
}
export function accountMirrorCode(accountId: string): string {
  return `1000-${accountId}`;
}

/** Maps the DB subtype to the system role the domain ledger builders expect. */
export function systemRoleOf(subtype: LedgerAccountSubtype): LedgerSystemRole | null {
  switch (subtype) {
    case 'fx_clearing':
      return 'fx_clearing';
    case 'opening_balance_equity':
      return 'opening_balance_equity';
    case 'third_party_clearing':
      return 'third_party_clearing';
    case 'intercompany_due_to':
    case 'intercompany_due_from':
      return 'intercompany_due';
    case 'suspense':
      return 'suspense';
    default:
      return null;
  }
}

export function toDomainLedgerAccount(row: LedgerAccountRow): DomainLedgerAccount {
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    type: row.type,
    subtype: row.subtype,
    currency: row.currency,
    systemRole: systemRoleOf(row.subtype),
    accountId: row.accountId,
  };
}

export interface LedgerAccountInput {
  entityId: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  subtype: LedgerAccountSubtype;
  currency?: string | null;
  accountId?: string | null;
  counterpartyEntityId?: string | null;
  arrangementId?: string | null;
  categoryId?: string | null;
  system?: boolean;
}

/**
 * Returns the ledger account with this (entity, code), creating it when absent. Safe under
 * concurrency: the insert is an upsert on the unique (entity, code) key.
 */
export async function getOrCreate(db: DbOrTx, input: LedgerAccountInput): Promise<{ row: LedgerAccountRow; created: boolean }> {
  return mapErrors('get or create ledger account', async () => {
    const inserted = await db
      .insert(ledgerAccounts)
      .values({
        entityId: input.entityId,
        code: input.code,
        name: input.name,
        type: input.type,
        subtype: input.subtype,
        currency: input.currency ?? null,
        accountId: input.accountId ?? null,
        counterpartyEntityId: input.counterpartyEntityId ?? null,
        arrangementId: input.arrangementId ?? null,
        categoryId: input.categoryId ?? null,
        system: input.system ?? false,
      })
      .onConflictDoNothing({ target: [ledgerAccounts.entityId, ledgerAccounts.code] })
      .returning();
    if (inserted[0]) return { row: inserted[0], created: true };
    const [existing] = await db
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.entityId, input.entityId), eq(ledgerAccounts.code, input.code)))
      .limit(1);
    return { row: required(existing, 'ledger account'), created: false };
  });
}

export async function getById(db: DbOrTx, id: string): Promise<LedgerAccountRow | undefined> {
  const [row] = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, id)).limit(1);
  return row;
}

export async function getByCode(db: DbOrTx, entityId: string, code: string): Promise<LedgerAccountRow | undefined> {
  const [row] = await db
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.entityId, entityId), eq(ledgerAccounts.code, code)))
    .limit(1);
  return row;
}

export interface LedgerAccountQuery {
  entityId?: string | string[];
  subtype?: LedgerAccountSubtype | LedgerAccountSubtype[];
  accountId?: string;
  includeInactive?: boolean;
}

export async function list(db: DbOrTx, query: LedgerAccountQuery = {}): Promise<LedgerAccountRow[]> {
  const conditions: SQL[] = [];
  if (query.entityId) conditions.push(inArray(ledgerAccounts.entityId, Array.isArray(query.entityId) ? query.entityId : [query.entityId]));
  if (query.subtype) conditions.push(inArray(ledgerAccounts.subtype, Array.isArray(query.subtype) ? query.subtype : [query.subtype]));
  if (query.accountId) conditions.push(eq(ledgerAccounts.accountId, query.accountId));
  if (!query.includeInactive) conditions.push(eq(ledgerAccounts.active, true));
  return db
    .select()
    .from(ledgerAccounts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(ledgerAccounts.entityId), asc(ledgerAccounts.code));
}

/** A domain `LedgerChart` for validating and building entries. */
export async function getChart(db: DbOrTx, query: LedgerAccountQuery = {}): Promise<LedgerChart> {
  const rows = await list(db, query);
  return chartOf(rows.map(toDomainLedgerAccount));
}

export async function deactivate(db: DbOrTx, id: string): Promise<LedgerAccountRow> {
  const [row] = await db.update(ledgerAccounts).set({ active: false }).where(eq(ledgerAccounts.id, id)).returning();
  return required(row, 'ledger account');
}

// ---------------------------------------------------------------------------------------
// System accounts
// ---------------------------------------------------------------------------------------

export async function openingBalanceEquity(db: DbOrTx, entityId: string): Promise<LedgerAccountRow> {
  const { row } = await getOrCreate(db, {
    entityId,
    code: OPENING_BALANCE_EQUITY_CODE,
    name: 'Opening balance equity',
    type: 'equity',
    subtype: 'opening_balance_equity',
    currency: null,
    system: true,
  });
  return row;
}

export async function suspense(db: DbOrTx, entityId: string): Promise<LedgerAccountRow> {
  const { row } = await getOrCreate(db, {
    entityId,
    code: SUSPENSE_CODE,
    name: 'Suspense',
    type: 'asset',
    subtype: 'suspense',
    currency: null,
    system: true,
  });
  return row;
}

/** One FX clearing account per currency, so each currency balances on its own. */
export async function fxClearing(db: DbOrTx, entityId: string, currency: string): Promise<LedgerAccountRow> {
  if (!/^[A-Z0-9]{2,10}$/.test(currency)) throw new InvalidError(`Invalid currency code ${currency}`);
  const { row } = await getOrCreate(db, {
    entityId,
    code: fxClearingCode(currency),
    name: `FX clearing (${currency})`,
    type: 'asset',
    subtype: 'fx_clearing',
    currency,
    system: true,
  });
  return row;
}

export async function intercompanyDueFrom(db: DbOrTx, entityId: string, counterpartyEntityId: string): Promise<LedgerAccountRow> {
  if (entityId === counterpartyEntityId) throw new InvalidError('An entity cannot owe itself');
  const { row } = await getOrCreate(db, {
    entityId,
    code: intercompanyDueFromCode(counterpartyEntityId),
    name: 'Intercompany receivable',
    type: 'asset',
    subtype: 'intercompany_due_from',
    currency: null,
    counterpartyEntityId,
    system: true,
  });
  return row;
}

export async function intercompanyDueTo(db: DbOrTx, entityId: string, counterpartyEntityId: string): Promise<LedgerAccountRow> {
  if (entityId === counterpartyEntityId) throw new InvalidError('An entity cannot owe itself');
  const { row } = await getOrCreate(db, {
    entityId,
    code: intercompanyDueToCode(counterpartyEntityId),
    name: 'Intercompany payable',
    type: 'liability',
    subtype: 'intercompany_due_to',
    currency: null,
    counterpartyEntityId,
    system: true,
  });
  return row;
}

/** Money held for a third party is a liability of the holding entity, never income. */
export async function thirdPartyClearing(
  db: DbOrTx,
  entityId: string,
  arrangementId: string,
  currency: string | null = null,
): Promise<LedgerAccountRow> {
  const { row } = await getOrCreate(db, {
    entityId,
    code: thirdPartyClearingCode(arrangementId, currency),
    name: currency ? `Third-party clearing (${currency})` : 'Third-party clearing',
    type: 'liability',
    subtype: 'third_party_clearing',
    currency,
    arrangementId,
    system: true,
  });
  return row;
}

/** The ledger mirror of a real account (bank, card, investment, property, loan…). */
export async function forAccount(db: DbOrTx, accountId: string, options: { entityId?: string } = {}): Promise<LedgerAccountRow> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  const found = required(account, 'account');
  const entityId = options.entityId ?? found.legalEntityId ?? found.economicOwnerEntityId;
  if (!entityId) throw new InvalidError(`Account ${accountId} has no entity; assign one before posting to its ledger account`);
  const { type, subtype } = ledgerShapeFor(found.kind, found.liquidityClass);
  const { row } = await getOrCreate(db, {
    entityId,
    code: accountMirrorCode(accountId),
    name: found.name,
    type,
    subtype,
    currency: found.currency,
    accountId,
    system: false,
  });
  return row;
}

function ledgerShapeFor(kind: string, liquidityClass: string): { type: LedgerAccountType; subtype: LedgerAccountSubtype } {
  if (liquidityClass === 'liability' || kind === 'mortgage' || kind === 'loan' || kind === 'credit_card') {
    return { type: 'liability', subtype: 'payable' };
  }
  if (kind === 'receivable' || liquidityClass === 'receivable') return { type: 'asset', subtype: 'receivable' };
  if (kind === 'clearing') return { type: 'asset', subtype: 'suspense' };
  if (['brokerage', 'crypto_wallet', 'crypto_custodial', 'private_investment', 'restricted_equity', 'pension'].includes(kind)) {
    return { type: 'asset', subtype: 'investment' };
  }
  return { type: 'asset', subtype: 'bank' };
}

/** An income or expense account for one category, created on demand. */
export async function forCategory(
  db: DbOrTx,
  entityId: string,
  category: { id: string; name: string; kind: 'expense' | 'income' | 'transfer' | 'other' },
): Promise<LedgerAccountRow> {
  const income = category.kind === 'income';
  const { row } = await getOrCreate(db, {
    entityId,
    code: `${income ? '4' : '5'}000-${category.id}`,
    name: category.name,
    type: income ? 'income' : 'expense',
    subtype: income ? 'income' : 'expense',
    currency: null,
    categoryId: category.id,
    system: false,
  });
  return row;
}

export interface EntityChart {
  openingBalanceEquity: LedgerAccountRow;
  suspense: LedgerAccountRow;
  ownerEquity: LedgerAccountRow;
  /** Keyed by currency code. */
  fxClearing: Record<string, LedgerAccountRow>;
  /** Keyed by counterparty entity id. */
  intercompanyDueFrom: Record<string, LedgerAccountRow>;
  intercompanyDueTo: Record<string, LedgerAccountRow>;
}

export interface EnsureChartOptions {
  /** FX clearing accounts to create, one per currency. */
  currencies?: readonly string[];
  /** Counterparty entities to create intercompany due to/from pairs for. */
  counterpartyEntityIds?: readonly string[];
}

/**
 * Creates (or finds) the standard chart for one entity in a single transaction: opening
 * balance equity, owner equity, suspense, an FX clearing account per requested currency and
 * an intercompany due-to/due-from pair per requested counterparty entity.
 */
export async function ensureEntityChart(db: DbOrTx, entityId: string, options: EnsureChartOptions = {}): Promise<EntityChart> {
  return tx(db, async (t) => {
    const chart: EntityChart = {
      openingBalanceEquity: await openingBalanceEquity(t, entityId),
      suspense: await suspense(t, entityId),
      ownerEquity: (
        await getOrCreate(t, {
          entityId,
          code: OWNER_EQUITY_CODE,
          name: 'Owner equity',
          type: 'equity',
          subtype: 'owner_equity',
          currency: null,
          system: true,
        })
      ).row,
      fxClearing: {},
      intercompanyDueFrom: {},
      intercompanyDueTo: {},
    };
    for (const currency of [...new Set(options.currencies ?? [])].sort()) {
      chart.fxClearing[currency] = await fxClearing(t, entityId, currency);
    }
    for (const counterparty of [...new Set(options.counterpartyEntityIds ?? [])].filter((id) => id !== entityId).sort()) {
      chart.intercompanyDueFrom[counterparty] = await intercompanyDueFrom(t, entityId, counterparty);
      chart.intercompanyDueTo[counterparty] = await intercompanyDueTo(t, entityId, counterparty);
    }
    return chart;
  });
}

/** System accounts of one entity that carry no currency restriction. */
export async function listSystemAccounts(db: DbOrTx, entityId: string): Promise<LedgerAccountRow[]> {
  return db
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.entityId, entityId), eq(ledgerAccounts.system, true), isNull(ledgerAccounts.accountId)))
    .orderBy(asc(ledgerAccounts.code));
}
