/**
 * Double-entry management ledger.
 *
 * - Every line carries a signed amount: debit positive, credit negative.
 * - Every entry balances to exactly zero per currency, and (by default) per entity per currency, so each
 *   entity's books balance on their own. Cross-entity movements go through `intercompany_due` accounts.
 * - Cross-currency movements use the trading-account method: one FX clearing line per currency.
 * - Posted entries are immutable. The only way to change one is `reverseEntry` / `correctEntry`
 *   (reversal plus replacement). Pending entries can be amended or posted.
 * - Valuation snapshots (owner-reported totals, statement closings, provider balances) are NOT journal
 *   entries. They are evidence of a balance at a time and live in `valuation.ts`. Only a verified opening
 *   position goes through `buildOpeningBalanceEntry`.
 */
import type { Money, TransactionNature } from '@financialos/contracts';
import { isValidIsoDate, type IsoDate } from '../dates';
import { impliedRate, rateDeviation } from '../fx';
import { D, dec, hasValidPrecision, money, MoneyError, toDecimalString, type Dec } from '../money';
import { splitAmount, type SplitShare } from './split';

// ---------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------

export type LedgerAccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export const LEDGER_SYSTEM_ROLES = ['fx_clearing', 'opening_balance_equity', 'third_party_clearing', 'intercompany_due', 'suspense'] as const;
export type LedgerSystemRole = (typeof LEDGER_SYSTEM_ROLES)[number];

export interface LedgerAccount {
  readonly id: string;
  readonly entityId: string;
  readonly name: string;
  readonly type: LedgerAccountType;
  /** Free-form subtype such as `cash`, `bank`, `card`, `investment_position`, `realised_gain`, `fee`, `tax`. */
  readonly subtype: string | null;
  /** Null means the account accepts lines in any currency (typical for FX clearing). */
  readonly currency: string | null;
  readonly systemRole: LedgerSystemRole | null;
  /** The real-world account this ledger account mirrors, when there is one. */
  readonly accountId?: string | null;
}

export type LedgerChart = ReadonlyMap<string, LedgerAccount>;

export type JournalEntryStatus = 'posted' | 'pending' | 'reversed';

export type JournalEntryKind =
  | 'income'
  | 'expense'
  | 'transfer'
  | 'fx_conversion'
  | 'split'
  | 'fee'
  | 'refund'
  | 'reversal'
  | 'opening_balance'
  | 'investment_trade'
  | 'dividend'
  | 'interest'
  | 'adjustment';

/** Line nature: the contract nature plus `opening_balance`, which is not a flow. */
export type JournalLineNature = TransactionNature | 'opening_balance';

export interface JournalLine {
  readonly ledgerAccountId: string;
  /** Entity whose books this line belongs to. */
  readonly entityId: string;
  /** Signed decimal string. Debit positive, credit negative. Never zero. */
  readonly amount: string;
  readonly currency: string;
  readonly counterpartyEntityId: string | null;
  readonly economicOwnerEntityId: string | null;
  readonly categoryId: string | null;
  readonly nature: JournalLineNature;
  readonly memo: string | null;
}

export interface JournalEntry {
  readonly id: string;
  readonly effectiveDate: IsoDate;
  readonly kind: JournalEntryKind;
  readonly status: JournalEntryStatus;
  readonly description: string;
  /** Set on a reversal: the entry it negates. */
  readonly reversesEntryId: string | null;
  /** Set on a reversed entry: the reversal that negates it. */
  readonly reversedByEntryId: string | null;
  /** Set on a correction's replacement: the entry it replaces. */
  readonly replacesEntryId: string | null;
  /** Set on a refund: the entry being refunded. */
  readonly refundOfEntryId: string | null;
  readonly sourceRecordIds: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly lines: readonly JournalLine[];
}

export type LedgerIssueCode =
  | 'missing_field'
  | 'too_few_lines'
  | 'invalid_date'
  | 'invalid_status'
  | 'invalid_amount'
  | 'invalid_currency'
  | 'zero_amount'
  | 'precision'
  | 'unbalanced'
  | 'unbalanced_entity'
  | 'unknown_account'
  | 'account_currency_mismatch'
  | 'account_entity_mismatch'
  | 'wrong_role'
  | 'wrong_account_type'
  | 'invalid_link'
  | 'already_reversed'
  | 'reversal_of_reversal'
  | 'not_posted'
  | 'immutable'
  | 'refund_exceeds_original'
  | 'invalid_input';

export interface LedgerIssue {
  code: LedgerIssueCode;
  message: string;
  lineIndex: number | null;
  currency?: string;
  entityId?: string;
}

export interface LedgerValidationResult {
  ok: boolean;
  issues: LedgerIssue[];
}

export class LedgerError extends MoneyError {
  override name = 'LedgerError';
  readonly issues: LedgerIssue[];
  constructor(issues: LedgerIssue[] | LedgerIssue) {
    const list = Array.isArray(issues) ? issues : [issues];
    super(list.map((i) => i.message).join('; '));
    this.issues = list;
  }
  get code(): LedgerIssueCode {
    return this.issues[0]?.code ?? 'invalid_input';
  }
}

/** Raised when code attempts to change a posted (or reversed) entry in place. */
export class ImmutableEntryError extends LedgerError {
  override name = 'ImmutableEntryError';
}

export interface ValidateOptions {
  /** When given, every line's account must exist with a compatible currency and entity. */
  chart?: LedgerChart;
  /** Require each entity's lines to balance per currency (default true). */
  perEntity?: boolean;
}

export interface BuildOptions {
  /** When given, accounts are checked for existence, currency, entity, type and system role. */
  chart?: LedgerChart;
}

/** Common header for every builder. */
export interface EntryHeader {
  id: string;
  effectiveDate: IsoDate;
  description: string;
  /** Defaults to `posted`. */
  status?: 'posted' | 'pending';
  sourceRecordIds?: readonly string[];
  metadata?: Readonly<Record<string, string>>;
}

export interface LineAttribution {
  categoryId?: string | null;
  counterpartyEntityId?: string | null;
  economicOwnerEntityId?: string | null;
  memo?: string | null;
}

// ---------------------------------------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------------------------------------

/** Builds a chart map, refusing duplicate ids. */
export function chartOf(accounts: readonly LedgerAccount[]): LedgerChart {
  const map = new Map<string, LedgerAccount>();
  for (const account of accounts) {
    if (map.has(account.id)) throw new LedgerError(issue('invalid_input', `Duplicate ledger account id ${account.id}`));
    if (account.systemRole !== null && !(LEDGER_SYSTEM_ROLES as readonly string[]).includes(account.systemRole)) {
      throw new LedgerError(issue('invalid_input', `Unknown system role ${String(account.systemRole)} on ${account.id}`));
    }
    map.set(account.id, account);
  }
  return map;
}

/** Finds the account with a system role for an entity (and currency, when the role is per currency). */
export function findSystemAccount(chart: LedgerChart, entityId: string, role: LedgerSystemRole, currency?: string): LedgerAccount | null {
  const matches = [...chart.values()].filter(
    (a) => a.entityId === entityId && a.systemRole === role && (currency === undefined || a.currency === null || a.currency === currency),
  );
  matches.sort((a, b) => {
    // Prefer a currency-specific account over a multi-currency one, then by id for determinism.
    const aSpecific = a.currency === currency ? 0 : 1;
    const bSpecific = b.currency === currency ? 0 : 1;
    return aSpecific - bSpecific || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return matches[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------

const CURRENCY_CODE = /^[A-Z0-9]{2,10}$/;
const STATUSES: readonly JournalEntryStatus[] = ['posted', 'pending', 'reversed'];

function issue(code: LedgerIssueCode, message: string, lineIndex: number | null = null, extra: Partial<LedgerIssue> = {}): LedgerIssue {
  return { code, message, lineIndex, ...extra };
}

function parseAmount(value: string): Dec | null {
  try {
    return dec(value);
  } catch {
    return null;
  }
}

/**
 * Validates an entry: at least two lines, a valid date, no zero lines, amounts within currency precision, and a
 * zero sum per currency (and per entity per currency unless `perEntity: false`).
 */
export function validateEntry(entry: JournalEntry, options: ValidateOptions = {}): LedgerValidationResult {
  const issues: LedgerIssue[] = [];
  const perEntity = options.perEntity ?? true;

  if (!entry.id || entry.id.trim() === '') issues.push(issue('missing_field', 'Entry id is required'));
  if (!isValidIsoDate(entry.effectiveDate)) issues.push(issue('invalid_date', `Invalid effective date: ${String(entry.effectiveDate)}`));
  if (!STATUSES.includes(entry.status)) issues.push(issue('invalid_status', `Invalid status: ${String(entry.status)}`));
  if (entry.lines.length < 2) issues.push(issue('too_few_lines', 'An entry needs at least two lines'));
  if (entry.kind === 'reversal' && !entry.reversesEntryId) issues.push(issue('invalid_link', 'A reversal must reference the entry it reverses'));
  if (entry.kind !== 'reversal' && entry.reversesEntryId) issues.push(issue('invalid_link', 'Only a reversal may reference a reversed entry'));
  if (entry.reversesEntryId && entry.reversesEntryId === entry.id) issues.push(issue('invalid_link', 'An entry cannot reverse itself'));
  if (entry.kind === 'refund' && !entry.refundOfEntryId) issues.push(issue('invalid_link', 'A refund must reference the original entry'));
  if (entry.status === 'reversed' && !entry.reversedByEntryId) issues.push(issue('invalid_link', 'A reversed entry must reference its reversal'));
  if (entry.status !== 'reversed' && entry.reversedByEntryId) issues.push(issue('invalid_link', 'Only a reversed entry may reference a reversal'));

  const byCurrency = new Map<string, Dec>();
  const byEntityCurrency = new Map<string, { entityId: string; currency: string; total: Dec }>();

  entry.lines.forEach((line, index) => {
    if (!line.ledgerAccountId) issues.push(issue('missing_field', `Line ${index + 1}: ledger account is required`, index));
    if (!line.entityId) issues.push(issue('missing_field', `Line ${index + 1}: entity is required`, index));
    if (typeof line.currency !== 'string' || !CURRENCY_CODE.test(line.currency)) {
      issues.push(issue('invalid_currency', `Line ${index + 1}: invalid currency ${String(line.currency)}`, index));
      return;
    }
    const amount = typeof line.amount === 'string' ? parseAmount(line.amount) : null;
    if (!amount) {
      issues.push(issue('invalid_amount', `Line ${index + 1}: invalid amount ${String(line.amount)}`, index));
      return;
    }
    if (amount.isZero()) issues.push(issue('zero_amount', `Line ${index + 1}: zero-amount lines are not allowed`, index));
    if (!hasValidPrecision({ amount: line.amount, currency: line.currency })) {
      issues.push(issue('precision', `Line ${index + 1}: ${line.amount} exceeds ${line.currency} precision`, index, { currency: line.currency }));
    }
    if (options.chart && line.ledgerAccountId) {
      const account = options.chart.get(line.ledgerAccountId);
      if (!account) {
        issues.push(issue('unknown_account', `Line ${index + 1}: unknown ledger account ${line.ledgerAccountId}`, index));
      } else {
        if (account.currency !== null && account.currency !== line.currency) {
          issues.push(
            issue('account_currency_mismatch', `Line ${index + 1}: account ${account.id} is ${account.currency}, line is ${line.currency}`, index, {
              currency: line.currency,
            }),
          );
        }
        if (account.entityId !== line.entityId) {
          issues.push(
            issue('account_entity_mismatch', `Line ${index + 1}: account ${account.id} belongs to another entity`, index, { entityId: line.entityId }),
          );
        }
      }
    }
    byCurrency.set(line.currency, (byCurrency.get(line.currency) ?? new D(0)).plus(amount));
    const key = `${line.entityId}\u0000${line.currency}`;
    const current = byEntityCurrency.get(key) ?? { entityId: line.entityId, currency: line.currency, total: new D(0) };
    current.total = current.total.plus(amount);
    byEntityCurrency.set(key, current);
  });

  for (const [currency, total] of byCurrency) {
    if (!total.isZero()) {
      issues.push(issue('unbalanced', `Entry does not balance in ${currency}: off by ${toDecimalString(total)}`, null, { currency }));
    }
  }
  if (perEntity) {
    for (const { entityId, currency, total } of byEntityCurrency.values()) {
      if (!total.isZero() && byCurrency.get(currency)?.isZero()) {
        issues.push(
          issue('unbalanced_entity', `Entity ${entityId} does not balance in ${currency}: off by ${toDecimalString(total)}`, null, {
            currency,
            entityId,
          }),
        );
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export function assertValidEntry(entry: JournalEntry, options: ValidateOptions = {}): void {
  const result = validateEntry(entry, options);
  if (!result.ok) throw new LedgerError(result.issues);
}

// ---------------------------------------------------------------------------------------------------------
// Immutability helpers
// ---------------------------------------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** True when the entry may still be changed in place (only pending entries). */
export function isMutable(entry: JournalEntry): boolean {
  return entry.status === 'pending';
}

export function assertMutable(entry: JournalEntry): void {
  if (!isMutable(entry)) {
    throw new ImmutableEntryError(
      issue('immutable', `Entry ${entry.id} is ${entry.status}; posted entries are immutable. Use reverseEntry or correctEntry.`),
    );
  }
}

// ---------------------------------------------------------------------------------------------------------
// Builder internals
// ---------------------------------------------------------------------------------------------------------

interface LineSpec extends LineAttribution {
  ledgerAccountId: string;
  entityId: string;
  amount: Dec;
  currency: string;
  nature: JournalLineNature;
}

function makeLine(spec: LineSpec): JournalLine {
  return {
    ledgerAccountId: spec.ledgerAccountId,
    entityId: spec.entityId,
    amount: toDecimalString(spec.amount),
    currency: spec.currency,
    counterpartyEntityId: spec.counterpartyEntityId ?? null,
    economicOwnerEntityId: spec.economicOwnerEntityId ?? null,
    categoryId: spec.categoryId ?? null,
    nature: spec.nature,
    memo: spec.memo ?? null,
  };
}

interface EntryLinks {
  reversesEntryId?: string | null;
  reversedByEntryId?: string | null;
  replacesEntryId?: string | null;
  refundOfEntryId?: string | null;
}

function finalize(
  header: EntryHeader,
  kind: JournalEntryKind,
  lines: readonly LineSpec[],
  options: BuildOptions,
  extra: { links?: EntryLinks; metadata?: Record<string, string>; status?: JournalEntryStatus } = {},
): JournalEntry {
  const entry: JournalEntry = {
    id: header.id,
    effectiveDate: header.effectiveDate,
    kind,
    status: extra.status ?? header.status ?? 'posted',
    description: header.description,
    reversesEntryId: extra.links?.reversesEntryId ?? null,
    reversedByEntryId: extra.links?.reversedByEntryId ?? null,
    replacesEntryId: extra.links?.replacesEntryId ?? null,
    refundOfEntryId: extra.links?.refundOfEntryId ?? null,
    sourceRecordIds: [...(header.sourceRecordIds ?? [])],
    metadata: { ...(header.metadata ?? {}), ...(extra.metadata ?? {}) },
    lines: lines.map(makeLine),
  };
  if (entry.status !== 'posted' && entry.status !== 'pending' && extra.status === undefined) {
    throw new LedgerError(issue('invalid_status', `Builders create posted or pending entries, not ${String(entry.status)}`));
  }
  assertValidEntry(entry, options.chart ? { chart: options.chart } : {});
  return deepFreeze(entry);
}

function positive(value: Money, label: string): Dec {
  const amount = parseAmount(value.amount);
  if (!amount) throw new LedgerError(issue('invalid_amount', `${label}: invalid amount ${String(value.amount)}`));
  if (!amount.greaterThan(0)) throw new LedgerError(issue('invalid_amount', `${label} must be a positive magnitude`));
  if (!hasValidPrecision(value)) throw new LedgerError(issue('precision', `${label}: ${value.amount} exceeds ${value.currency} precision`));
  return amount;
}

function sameCurrency(a: Money, b: Money, label: string): void {
  if (a.currency !== b.currency) {
    throw new LedgerError(issue('invalid_input', `${label}: currency ${b.currency} differs from ${a.currency}`));
  }
}

function requireAccount(chart: LedgerChart | undefined, id: string, expect: { role?: LedgerSystemRole; types?: LedgerAccountType[] }, label: string): void {
  if (!chart) return;
  const account = chart.get(id);
  if (!account) throw new LedgerError(issue('unknown_account', `${label}: unknown ledger account ${id}`));
  if (expect.role && account.systemRole !== expect.role) {
    throw new LedgerError(issue('wrong_role', `${label}: ${id} must have system role ${expect.role}`));
  }
  if (expect.types && !expect.types.includes(account.type)) {
    throw new LedgerError(issue('wrong_account_type', `${label}: ${id} must be of type ${expect.types.join(' or ')}`));
  }
}

function attribution(source: LineAttribution): LineAttribution {
  return {
    categoryId: source.categoryId ?? null,
    counterpartyEntityId: source.counterpartyEntityId ?? null,
    economicOwnerEntityId: source.economicOwnerEntityId ?? null,
    memo: source.memo ?? null,
  };
}

function rateString(rate: Dec): string {
  return toDecimalString(rate.toDecimalPlaces(18));
}

// ---------------------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------------------

export interface IncomeExpenseInput extends EntryHeader, LineAttribution {
  direction: 'income' | 'expense';
  entityId: string;
  /** Asset or liability account the money moved through (bank, card, cash). */
  cashLedgerAccountId: string;
  /** Income or expense account. */
  pnlLedgerAccountId: string;
  /** Positive magnitude. */
  amount: Money;
  /** Defaults to `income` for income and `consumption` for expenses. */
  nature?: TransactionNature;
}

/** Simple income (Dr cash / Cr income) or expense (Dr expense / Cr cash). */
export function buildIncomeExpenseEntry(input: IncomeExpenseInput, options: BuildOptions = {}): JournalEntry {
  const amount = positive(input.amount, 'Amount');
  requireAccount(options.chart, input.cashLedgerAccountId, { types: ['asset', 'liability'] }, 'Cash account');
  requireAccount(options.chart, input.pnlLedgerAccountId, { types: [input.direction] }, 'P&L account');
  const nature = input.nature ?? (input.direction === 'income' ? 'income' : 'consumption');
  const sign = input.direction === 'income' ? 1 : -1;
  const attr = attribution(input);
  return finalize(input, input.direction, [
    { ...attr, ledgerAccountId: input.cashLedgerAccountId, entityId: input.entityId, amount: amount.times(sign), currency: input.amount.currency, nature },
    { ...attr, ledgerAccountId: input.pnlLedgerAccountId, entityId: input.entityId, amount: amount.times(-sign), currency: input.amount.currency, nature },
  ], options);
}

export interface LedgerEndpoint {
  entityId: string;
  ledgerAccountId: string;
}

export interface IntercompanyAccounts {
  /** `intercompany_due` account in the sending entity's books. */
  fromDueLedgerAccountId: string;
  /** `intercompany_due` account in the receiving entity's books. */
  toDueLedgerAccountId: string;
}

export interface TransferInput extends EntryHeader {
  /** Positive magnitude moved. */
  amount: Money;
  from: LedgerEndpoint;
  to: LedgerEndpoint;
  /** Required when `from` and `to` belong to different entities. */
  intercompany?: IntercompanyAccounts | null;
  /** Defaults to `transfer_internal`. Use `owner_contribution`, `owner_drawing`, `intercompany`, … for cross-entity moves. */
  nature?: TransactionNature;
  economicOwnerEntityId?: string | null;
  memo?: string | null;
}

function crossEntityLines(
  amount: Dec,
  currency: string,
  from: LedgerEndpoint,
  to: LedgerEndpoint,
  intercompany: IntercompanyAccounts,
  nature: JournalLineNature,
  attr: LineAttribution,
  options: BuildOptions,
): LineSpec[] {
  requireAccount(options.chart, intercompany.fromDueLedgerAccountId, { role: 'intercompany_due' }, 'Sender intercompany account');
  requireAccount(options.chart, intercompany.toDueLedgerAccountId, { role: 'intercompany_due' }, 'Receiver intercompany account');
  const fromSide = { ...attr, counterpartyEntityId: to.entityId };
  const toSide = { ...attr, counterpartyEntityId: from.entityId };
  return [
    { ...fromSide, ledgerAccountId: intercompany.fromDueLedgerAccountId, entityId: from.entityId, amount, currency, nature },
    { ...toSide, ledgerAccountId: to.ledgerAccountId, entityId: to.entityId, amount, currency, nature },
    { ...toSide, ledgerAccountId: intercompany.toDueLedgerAccountId, entityId: to.entityId, amount: amount.negated(), currency, nature },
  ];
}

/** Same-currency transfer. Cross-entity transfers are recorded through each entity's intercompany account. */
export function buildTransferEntry(input: TransferInput, options: BuildOptions = {}): JournalEntry {
  const amount = positive(input.amount, 'Transfer amount');
  if (input.from.ledgerAccountId === input.to.ledgerAccountId) {
    throw new LedgerError(issue('invalid_input', 'A transfer needs two different ledger accounts'));
  }
  const currency = input.amount.currency;
  const nature = input.nature ?? 'transfer_internal';
  const attr: LineAttribution = { economicOwnerEntityId: input.economicOwnerEntityId ?? null, memo: input.memo ?? null };
  const crossEntity = input.from.entityId !== input.to.entityId;
  const outLine: LineSpec = {
    ...attr,
    counterpartyEntityId: crossEntity ? input.to.entityId : null,
    ledgerAccountId: input.from.ledgerAccountId,
    entityId: input.from.entityId,
    amount: amount.negated(),
    currency,
    nature,
  };
  if (!crossEntity) {
    return finalize(input, 'transfer', [outLine, { ...attr, ledgerAccountId: input.to.ledgerAccountId, entityId: input.to.entityId, amount, currency, nature }], options);
  }
  if (!input.intercompany) {
    throw new LedgerError(issue('invalid_input', 'A transfer between different entities needs intercompany due accounts'));
  }
  return finalize(input, 'transfer', [outLine, ...crossEntityLines(amount, currency, input.from, input.to, input.intercompany, nature, attr, options)], options);
}

export interface FxConversionInput extends EntryHeader {
  sold: LedgerEndpoint & { amount: Money };
  bought: LedgerEndpoint & { amount: Money };
  /** FX clearing accounts in the selling entity's books (may be the same multi-currency account). */
  fxClearing: { soldCurrencyLedgerAccountId: string; boughtCurrencyLedgerAccountId: string };
  /** Required when the bought side belongs to a different entity. Accounts are in the bought currency. */
  intercompany?: IntercompanyAccounts | null;
  /** Optional market reference; the deviation of the implied rate is recorded in metadata. */
  referenceRate?: { rate: string; source: string; asOf: IsoDate } | null;
  economicOwnerEntityId?: string | null;
  memo?: string | null;
}

/**
 * Cross-currency conversion using the trading-account method:
 * Cr source (sold ccy) / Dr FX clearing (sold ccy) / Cr FX clearing (bought ccy) / Dr target (bought ccy).
 * Each currency balances on its own. Metadata carries `impliedRate` (bought per 1 sold) and `ratePair`.
 */
export function buildFxConversionEntry(input: FxConversionInput, options: BuildOptions = {}): JournalEntry {
  const soldAmount = positive(input.sold.amount, 'Sold amount');
  const boughtAmount = positive(input.bought.amount, 'Bought amount');
  const soldCcy = input.sold.amount.currency;
  const boughtCcy = input.bought.amount.currency;
  if (soldCcy === boughtCcy) {
    throw new LedgerError(issue('invalid_input', 'A conversion needs two different currencies; use buildTransferEntry for same-currency moves'));
  }
  requireAccount(options.chart, input.fxClearing.soldCurrencyLedgerAccountId, { role: 'fx_clearing' }, 'FX clearing (sold)');
  requireAccount(options.chart, input.fxClearing.boughtCurrencyLedgerAccountId, { role: 'fx_clearing' }, 'FX clearing (bought)');
  const nature: JournalLineNature = 'fx_conversion';
  const attr: LineAttribution = { economicOwnerEntityId: input.economicOwnerEntityId ?? null, memo: input.memo ?? null };
  const seller = input.sold.entityId;
  const crossEntity = seller !== input.bought.entityId;
  const cp = crossEntity ? input.bought.entityId : null;

  const lines: LineSpec[] = [
    { ...attr, counterpartyEntityId: cp, ledgerAccountId: input.sold.ledgerAccountId, entityId: seller, amount: soldAmount.negated(), currency: soldCcy, nature },
    { ...attr, counterpartyEntityId: cp, ledgerAccountId: input.fxClearing.soldCurrencyLedgerAccountId, entityId: seller, amount: soldAmount, currency: soldCcy, nature },
    { ...attr, counterpartyEntityId: cp, ledgerAccountId: input.fxClearing.boughtCurrencyLedgerAccountId, entityId: seller, amount: boughtAmount.negated(), currency: boughtCcy, nature },
  ];
  if (crossEntity) {
    if (!input.intercompany) throw new LedgerError(issue('invalid_input', 'A conversion into another entity needs intercompany due accounts'));
    lines.push(...crossEntityLines(boughtAmount, boughtCcy, input.sold, input.bought, input.intercompany, nature, attr, options));
  } else {
    lines.push({ ...attr, ledgerAccountId: input.bought.ledgerAccountId, entityId: input.bought.entityId, amount: boughtAmount, currency: boughtCcy, nature });
  }

  const implied = impliedRate(input.sold.amount, input.bought.amount);
  const metadata: Record<string, string> = {
    impliedRate: rateString(implied),
    ratePair: `${soldCcy}/${boughtCcy}`,
    soldAmount: toDecimalString(soldAmount),
    boughtAmount: toDecimalString(boughtAmount),
  };
  if (input.referenceRate) {
    const reference = dec(input.referenceRate.rate);
    if (!reference.greaterThan(0)) throw new LedgerError(issue('invalid_input', 'Reference rate must be positive'));
    metadata.referenceRate = rateString(reference);
    metadata.referenceRateSource = input.referenceRate.source;
    metadata.referenceRateAsOf = input.referenceRate.asOf;
    metadata.rateDeviation = rateString(rateDeviation(implied, reference));
  }
  return finalize(input, 'fx_conversion', lines, options, { metadata });
}

export interface SplitPartInput extends LineAttribution {
  ledgerAccountId: string;
  share: SplitShare;
  nature?: TransactionNature;
}

export interface SplitEntryInput extends EntryHeader {
  entityId: string;
  direction: 'income' | 'expense';
  cashLedgerAccountId: string;
  /** Positive magnitude of the whole transaction. */
  total: Money;
  parts: readonly SplitPartInput[];
  counterpartyEntityId?: string | null;
  economicOwnerEntityId?: string | null;
}

/**
 * One cash line against several P&L lines. Parts are computed with `splitAmount`, so they sum exactly to the
 * total. Parts that round to zero carry no value and are omitted (listed in `metadata.omittedZeroParts`).
 */
export function buildSplitEntry(input: SplitEntryInput, options: BuildOptions = {}): JournalEntry {
  const total = positive(input.total, 'Split total');
  if (input.parts.length === 0) throw new LedgerError(issue('invalid_input', 'A split needs at least one part'));
  requireAccount(options.chart, input.cashLedgerAccountId, { types: ['asset', 'liability'] }, 'Cash account');
  const amounts = splitAmount(input.total, input.parts.map((p) => p.share));
  const sign = input.direction === 'income' ? 1 : -1;
  const defaultNature: TransactionNature = input.direction === 'income' ? 'income' : 'consumption';
  const currency = input.total.currency;
  const lines: LineSpec[] = [
    {
      ledgerAccountId: input.cashLedgerAccountId,
      entityId: input.entityId,
      amount: total.times(sign),
      currency,
      nature: input.parts.length === 1 ? (input.parts[0]!.nature ?? defaultNature) : defaultNature,
      counterpartyEntityId: input.counterpartyEntityId ?? null,
      economicOwnerEntityId: input.economicOwnerEntityId ?? null,
      memo: null,
      categoryId: null,
    },
  ];
  const omitted: number[] = [];
  input.parts.forEach((part, index) => {
    const value = dec(amounts[index]!.amount);
    if (value.isZero()) {
      omitted.push(index + 1);
      return;
    }
    requireAccount(options.chart, part.ledgerAccountId, { types: [input.direction] }, `Split part ${index + 1}`);
    lines.push({
      ledgerAccountId: part.ledgerAccountId,
      entityId: input.entityId,
      amount: value.times(-sign),
      currency,
      nature: part.nature ?? defaultNature,
      categoryId: part.categoryId ?? null,
      counterpartyEntityId: part.counterpartyEntityId ?? input.counterpartyEntityId ?? null,
      economicOwnerEntityId: part.economicOwnerEntityId ?? input.economicOwnerEntityId ?? null,
      memo: part.memo ?? null,
    });
  });
  const metadata: Record<string, string> = { splitParts: String(input.parts.length) };
  if (omitted.length > 0) metadata.omittedZeroParts = omitted.join(',');
  return finalize(input, 'split', lines, options, { metadata });
}

export interface FeeInput extends EntryHeader, LineAttribution {
  entityId: string;
  cashLedgerAccountId: string;
  feeLedgerAccountId: string;
  fee: Money;
  /** The entry that caused the fee (e.g. a transfer), if any. */
  relatedEntryId?: string | null;
}

/** A fee charged to an account (Dr fee expense / Cr cash), optionally linked to the entry that caused it. */
export function buildFeeEntry(input: FeeInput, options: BuildOptions = {}): JournalEntry {
  const fee = positive(input.fee, 'Fee');
  requireAccount(options.chart, input.feeLedgerAccountId, { types: ['expense'] }, 'Fee account');
  const attr = attribution(input);
  const currency = input.fee.currency;
  const metadata: Record<string, string> = {};
  if (input.relatedEntryId) metadata.relatedEntryId = input.relatedEntryId;
  return finalize(
    input,
    'fee',
    [
      { ...attr, ledgerAccountId: input.feeLedgerAccountId, entityId: input.entityId, amount: fee, currency, nature: 'fee' },
      { ...attr, ledgerAccountId: input.cashLedgerAccountId, entityId: input.entityId, amount: fee.negated(), currency, nature: 'fee' },
    ],
    options,
    { metadata },
  );
}

export interface RefundInput extends EntryHeader {
  original: JournalEntry;
  /** Account receiving (or paying) the refund. */
  cashLedgerAccountId: string;
  /** The income/expense account of the original entry being refunded. */
  pnlLedgerAccountId: string;
  /** Defaults to the full refundable amount. */
  amount?: Money | null;
  /** Earlier refunds of the same original, used to prevent refunding more than was paid. */
  priorRefunds?: readonly JournalEntry[];
  memo?: string | null;
}

/**
 * Refund of (part of) an original entry. The P&L line is reversed in direction and linked through
 * `refundOfEntryId`; the original is not changed. Cumulative refunds cannot exceed the original amount.
 */
export function buildRefundEntry(input: RefundInput, options: BuildOptions = {}): JournalEntry {
  const { original } = input;
  if (original.status !== 'posted') {
    throw new LedgerError(issue('not_posted', `Only posted entries can be refunded; ${original.id} is ${original.status}`));
  }
  const pnlLines = original.lines.filter((l) => l.ledgerAccountId === input.pnlLedgerAccountId);
  if (pnlLines.length === 0) {
    throw new LedgerError(issue('invalid_input', `Original entry ${original.id} has no line on ${input.pnlLedgerAccountId}`));
  }
  const currency = pnlLines[0]!.currency;
  if (pnlLines.some((l) => l.currency !== currency)) {
    throw new LedgerError(issue('invalid_input', 'The refunded account carries more than one currency in the original entry'));
  }
  const originalTotal = pnlLines.reduce((acc, l) => acc.plus(dec(l.amount)), new D(0));
  if (originalTotal.isZero()) throw new LedgerError(issue('invalid_input', 'Nothing to refund on that account'));
  const sign = originalTotal.isNegative() ? -1 : 1;
  let alreadyRefunded = new D(0);
  for (const prior of input.priorRefunds ?? []) {
    if (prior.refundOfEntryId !== original.id || prior.status === 'reversed' || prior.id === input.id) continue;
    for (const line of prior.lines) {
      if (line.ledgerAccountId === input.pnlLedgerAccountId && line.currency === currency) {
        alreadyRefunded = alreadyRefunded.plus(dec(line.amount).times(-sign));
      }
    }
  }
  const refundable = originalTotal.abs().minus(alreadyRefunded);
  if (!refundable.greaterThan(0)) {
    throw new LedgerError(issue('refund_exceeds_original', `Entry ${original.id} has already been fully refunded`));
  }
  const amount = input.amount ? positive(input.amount, 'Refund amount') : refundable;
  if (input.amount) sameCurrency(money('0', currency), input.amount, 'Refund');
  if (amount.greaterThan(refundable)) {
    throw new LedgerError(
      issue('refund_exceeds_original', `Refund ${toDecimalString(amount)} ${currency} exceeds the refundable ${toDecimalString(refundable)} ${currency}`),
    );
  }
  const template = pnlLines[0]!;
  const attr: LineAttribution = {
    categoryId: template.categoryId,
    counterpartyEntityId: template.counterpartyEntityId,
    economicOwnerEntityId: template.economicOwnerEntityId,
    memo: input.memo ?? null,
  };
  return finalize(
    input,
    'refund',
    [
      { ...attr, ledgerAccountId: input.cashLedgerAccountId, entityId: template.entityId, amount: amount.times(sign), currency, nature: 'refund' },
      { ...attr, ledgerAccountId: input.pnlLedgerAccountId, entityId: template.entityId, amount: amount.times(-sign), currency, nature: 'refund' },
    ],
    options,
    { links: { refundOfEntryId: original.id }, metadata: { refundOf: original.id, refundedSoFar: toDecimalString(alreadyRefunded.plus(amount)) } },
  );
}

export interface ReversalInput {
  id: string;
  effectiveDate: IsoDate;
  reason: string;
  description?: string;
  sourceRecordIds?: readonly string[];
}

export interface ReversalResult {
  /** The original, now `reversed` and pointing at its reversal (a new object; the input is untouched). */
  original: JournalEntry;
  reversal: JournalEntry;
}

/**
 * Reverses a posted entry with an exact negation, linking both ways. Refuses to reverse an entry that is
 * already reversed, that is itself a reversal, or that is not posted.
 */
export function reverseEntry(original: JournalEntry, input: ReversalInput, options: BuildOptions = {}): ReversalResult {
  if (original.status === 'reversed' || original.reversedByEntryId) {
    throw new LedgerError(issue('already_reversed', `Entry ${original.id} is already reversed by ${original.reversedByEntryId ?? 'another entry'}`));
  }
  if (original.kind === 'reversal' || original.reversesEntryId) {
    throw new LedgerError(issue('reversal_of_reversal', `Entry ${original.id} is a reversal; reversing a reversal is refused. Post a new entry instead.`));
  }
  if (original.status !== 'posted') {
    throw new LedgerError(issue('not_posted', `Entry ${original.id} is ${original.status}; only posted entries are reversed (amend pending entries instead)`));
  }
  if (!input.reason || input.reason.trim() === '') throw new LedgerError(issue('missing_field', 'A reversal needs a reason'));
  if (!isValidIsoDate(input.effectiveDate) || input.effectiveDate < original.effectiveDate) {
    throw new LedgerError(issue('invalid_date', `Reversal date ${input.effectiveDate} must be a valid date on or after ${original.effectiveDate}`));
  }
  if (input.id === original.id) throw new LedgerError(issue('invalid_link', 'A reversal needs its own id'));
  assertValidEntry(original, options.chart ? { chart: options.chart } : {});

  const reversal = finalize(
    {
      id: input.id,
      effectiveDate: input.effectiveDate,
      description: input.description ?? `Reversal of ${original.description}`,
      status: 'posted',
      sourceRecordIds: input.sourceRecordIds ?? original.sourceRecordIds,
    },
    'reversal',
    original.lines.map((l) => ({
      ledgerAccountId: l.ledgerAccountId,
      entityId: l.entityId,
      amount: dec(l.amount).negated(),
      currency: l.currency,
      nature: l.nature,
      categoryId: l.categoryId,
      counterpartyEntityId: l.counterpartyEntityId,
      economicOwnerEntityId: l.economicOwnerEntityId,
      memo: l.memo,
    })),
    options,
    { links: { reversesEntryId: original.id }, metadata: { reason: input.reason, reversedKind: original.kind } },
  );
  const reversedOriginal: JournalEntry = deepFreeze({
    ...original,
    status: 'reversed',
    reversedByEntryId: reversal.id,
    sourceRecordIds: [...original.sourceRecordIds],
    metadata: { ...original.metadata },
    lines: original.lines.map((l) => ({ ...l })),
  });
  return { original: reversedOriginal, reversal };
}

export interface CorrectionResult extends ReversalResult {
  /** The replacement entry, linked to the original through `replacesEntryId`. */
  replacement: JournalEntry;
}

/**
 * Correction = reversal of the original + a replacement entry (built with any builder). The replacement gets
 * `replacesEntryId` set to the original's id.
 */
export function correctEntry(original: JournalEntry, replacement: JournalEntry, reversal: ReversalInput, options: BuildOptions = {}): CorrectionResult {
  if (replacement.kind === 'reversal' || replacement.reversesEntryId) {
    throw new LedgerError(issue('invalid_input', 'A replacement cannot itself be a reversal'));
  }
  if (replacement.status === 'reversed') throw new LedgerError(issue('invalid_status', 'A replacement cannot already be reversed'));
  if (replacement.id === original.id || replacement.id === reversal.id) {
    throw new LedgerError(issue('invalid_link', 'The replacement needs its own id'));
  }
  const reversed = reverseEntry(original, reversal, options);
  const linked: JournalEntry = {
    ...replacement,
    replacesEntryId: original.id,
    sourceRecordIds: [...replacement.sourceRecordIds],
    metadata: { ...replacement.metadata, correctionOf: original.id, correctionReason: reversal.reason },
    lines: replacement.lines.map((l) => ({ ...l })),
  };
  assertValidEntry(linked, options.chart ? { chart: options.chart } : {});
  return { ...reversed, replacement: deepFreeze(linked) };
}

/**
 * Evidence behind an opening balance. `owner_reported_total` is deliberately NOT accepted: owner-reported
 * snapshots are valuation evidence (see valuation.ts), never journal entries.
 */
export type OpeningBalanceBasis = 'statement_opening' | 'provider_balance' | 'verified_document' | 'ledger_migration';
const OPENING_BASES: readonly string[] = ['statement_opening', 'provider_balance', 'verified_document', 'ledger_migration'];

export interface OpeningBalanceInput extends EntryHeader {
  entityId: string;
  ledgerAccountId: string;
  openingBalanceEquityLedgerAccountId: string;
  /** Debit-positive: an asset balance is positive, a liability balance negative. */
  balance: Money;
  basis: OpeningBalanceBasis;
  economicOwnerEntityId?: string | null;
  memo?: string | null;
}

/**
 * Opening balance against `opening_balance_equity`, for a verified starting position only (statement opening,
 * provider balance, verified document, ledger migration).
 *
 * Owner-reported totals and other valuation snapshots must NOT be posted here: a snapshot is not a movement
 * and not income. Posting one would turn an unverified figure into ledger fact and double count once real
 * history is imported. Store it as a `BalanceSnapshot` and let `valuation.ts` rank it.
 * A zero balance needs no entry and is refused (no zero lines).
 */
export function buildOpeningBalanceEntry(input: OpeningBalanceInput, options: BuildOptions = {}): JournalEntry {
  if (!OPENING_BASES.includes(input.basis)) {
    throw new LedgerError(
      issue('invalid_input', `Opening balances need verified evidence; basis ${String(input.basis)} is not accepted. Owner-reported snapshots are valuation evidence, not journal entries.`),
    );
  }
  const balance = parseAmount(input.balance.amount);
  if (!balance) throw new LedgerError(issue('invalid_amount', `Invalid opening balance ${String(input.balance.amount)}`));
  if (balance.isZero()) throw new LedgerError(issue('zero_amount', 'A zero opening balance needs no entry'));
  if (!hasValidPrecision(input.balance)) throw new LedgerError(issue('precision', 'Opening balance exceeds currency precision'));
  requireAccount(options.chart, input.openingBalanceEquityLedgerAccountId, { role: 'opening_balance_equity' }, 'Opening balance equity');
  requireAccount(options.chart, input.ledgerAccountId, { types: ['asset', 'liability'] }, 'Opening balance account');
  const attr: LineAttribution = { economicOwnerEntityId: input.economicOwnerEntityId ?? null, memo: input.memo ?? null };
  const currency = input.balance.currency;
  return finalize(
    input,
    'opening_balance',
    [
      { ...attr, ledgerAccountId: input.ledgerAccountId, entityId: input.entityId, amount: balance, currency, nature: 'opening_balance' },
      { ...attr, ledgerAccountId: input.openingBalanceEquityLedgerAccountId, entityId: input.entityId, amount: balance.negated(), currency, nature: 'opening_balance' },
    ],
    options,
    { metadata: { openingBasis: input.basis } },
  );
}

export interface InvestmentTradeInput extends EntryHeader {
  entityId: string;
  side: 'buy' | 'sell';
  cashLedgerAccountId: string;
  positionLedgerAccountId: string;
  instrumentId: string;
  /** Positive quantity magnitude as a decimal string. Tracked separately from money. */
  quantity: string;
  /** Gross consideration (executed price × quantity), positive, in the cash currency. */
  consideration: Money;
  /**
   * Commission. On a buy, `capitalise` adds it to cost; otherwise it is expensed to `ledgerAccountId`.
   * On a sell, `capitalise` deducts it from the realised gain; otherwise it is expensed.
   */
  fee?: { amount: Money; ledgerAccountId: string; capitalise?: boolean } | null;
  /** Sell only: cost basis of the quantity sold. */
  costBasisRelieved?: Money | null;
  /** Sell only: required when proceeds differ from cost. */
  realisedGainLedgerAccountId?: string | null;
  economicOwnerEntityId?: string | null;
  memo?: string | null;
}

export interface PositionMovement {
  entryId: string;
  entityId: string;
  positionLedgerAccountId: string;
  instrumentId: string;
  date: IsoDate;
  /** Signed quantity change (buy positive, sell negative). */
  quantityDelta: string;
  /** Signed change in cost basis. */
  costDelta: Money;
}

export interface InvestmentTradeResult {
  entry: JournalEntry;
  position: PositionMovement;
}

/**
 * Investment trade: a cash leg and a position leg at cost. The traded quantity is returned as a separate
 * `PositionMovement` (quantities are never mixed into money lines). Trades in a currency other than the cash
 * account's must be preceded by an FX conversion.
 */
export function buildInvestmentTradeEntry(input: InvestmentTradeInput, options: BuildOptions = {}): InvestmentTradeResult {
  const consideration = positive(input.consideration, 'Consideration');
  const currency = input.consideration.currency;
  const quantity = parseAmount(input.quantity);
  if (!quantity || !quantity.greaterThan(0)) throw new LedgerError(issue('invalid_input', 'Trade quantity must be a positive decimal string'));
  if (quantity.decimalPlaces() > 18) throw new LedgerError(issue('precision', 'Trade quantity exceeds 18 decimal places'));
  if (!input.instrumentId) throw new LedgerError(issue('missing_field', 'Trade needs an instrument'));
  requireAccount(options.chart, input.positionLedgerAccountId, { types: ['asset'] }, 'Position account');
  let fee = new D(0);
  if (input.fee) {
    sameCurrency(input.consideration, input.fee.amount, 'Trade fee');
    fee = positive(input.fee.amount, 'Trade fee');
    if (!input.fee.capitalise) requireAccount(options.chart, input.fee.ledgerAccountId, { types: ['expense'] }, 'Trade fee account');
  }
  const capitalise = Boolean(input.fee?.capitalise);
  const nature: JournalLineNature = 'investment_trade';
  const attr: LineAttribution = { economicOwnerEntityId: input.economicOwnerEntityId ?? null, memo: input.memo ?? null };
  const base = { ...attr, entityId: input.entityId, currency };
  const lines: LineSpec[] = [];
  let costDelta: Dec;

  if (input.side === 'buy') {
    if (input.costBasisRelieved) throw new LedgerError(issue('invalid_input', 'costBasisRelieved applies to sells only'));
    const cost = capitalise ? consideration.plus(fee) : consideration;
    lines.push({ ...base, ledgerAccountId: input.positionLedgerAccountId, amount: cost, nature });
    if (fee.greaterThan(0) && !capitalise) lines.push({ ...base, ledgerAccountId: input.fee!.ledgerAccountId, amount: fee, nature: 'fee' });
    lines.push({ ...base, ledgerAccountId: input.cashLedgerAccountId, amount: consideration.plus(fee).negated(), nature });
    costDelta = cost;
  } else {
    if (!input.costBasisRelieved) throw new LedgerError(issue('missing_field', 'A sell needs the cost basis relieved'));
    sameCurrency(input.consideration, input.costBasisRelieved, 'Cost basis');
    const basis = positive(input.costBasisRelieved, 'Cost basis relieved');
    if (!fee.lessThan(consideration)) throw new LedgerError(issue('invalid_input', 'Sale fee must be smaller than the consideration'));
    const netProceeds = consideration.minus(fee);
    const gain = (capitalise ? netProceeds : consideration).minus(basis);
    lines.push({ ...base, ledgerAccountId: input.cashLedgerAccountId, amount: netProceeds, nature });
    if (fee.greaterThan(0) && !capitalise) lines.push({ ...base, ledgerAccountId: input.fee!.ledgerAccountId, amount: fee, nature: 'fee' });
    lines.push({ ...base, ledgerAccountId: input.positionLedgerAccountId, amount: basis.negated(), nature });
    if (!gain.isZero()) {
      if (!input.realisedGainLedgerAccountId) throw new LedgerError(issue('missing_field', 'A sell with a gain or loss needs a realised gain account'));
      requireAccount(options.chart, input.realisedGainLedgerAccountId, { types: ['income', 'expense'] }, 'Realised gain account');
      lines.push({ ...base, ledgerAccountId: input.realisedGainLedgerAccountId, amount: gain.negated(), nature });
    }
    costDelta = basis.negated();
  }

  const entry = finalize(input, 'investment_trade', lines, options, {
    metadata: {
      side: input.side,
      instrumentId: input.instrumentId,
      quantity: toDecimalString(quantity),
      unitPrice: rateString(consideration.dividedBy(quantity)),
    },
  });
  return {
    entry,
    position: deepFreeze({
      entryId: entry.id,
      entityId: input.entityId,
      positionLedgerAccountId: input.positionLedgerAccountId,
      instrumentId: input.instrumentId,
      date: input.effectiveDate,
      quantityDelta: toDecimalString(input.side === 'buy' ? quantity : quantity.negated()),
      costDelta: money(costDelta, currency),
    }),
  };
}

export interface InvestmentIncomeInput extends EntryHeader, LineAttribution {
  entityId: string;
  cashLedgerAccountId: string;
  incomeLedgerAccountId: string;
  /** Gross income before withholding, positive. */
  gross: Money;
  /** Tax withheld at source, expensed to `ledgerAccountId`. */
  withholding?: { amount: Money; ledgerAccountId: string } | null;
  instrumentId?: string | null;
}

function investmentIncome(kind: 'dividend' | 'interest', input: InvestmentIncomeInput, options: BuildOptions): JournalEntry {
  const gross = positive(input.gross, 'Gross income');
  const currency = input.gross.currency;
  requireAccount(options.chart, input.incomeLedgerAccountId, { types: ['income'] }, 'Income account');
  let withheld = new D(0);
  if (input.withholding) {
    sameCurrency(input.gross, input.withholding.amount, 'Withholding');
    withheld = positive(input.withholding.amount, 'Withholding');
    if (!withheld.lessThan(gross)) throw new LedgerError(issue('invalid_input', 'Withholding must be smaller than the gross amount'));
    requireAccount(options.chart, input.withholding.ledgerAccountId, { types: ['expense'] }, 'Withholding account');
  }
  const attr = attribution(input);
  const base = { ...attr, entityId: input.entityId, currency };
  const lines: LineSpec[] = [{ ...base, ledgerAccountId: input.cashLedgerAccountId, amount: gross.minus(withheld), nature: kind }];
  if (withheld.greaterThan(0)) lines.push({ ...base, ledgerAccountId: input.withholding!.ledgerAccountId, amount: withheld, nature: 'tax' });
  lines.push({ ...base, ledgerAccountId: input.incomeLedgerAccountId, amount: gross.negated(), nature: kind });
  const metadata: Record<string, string> = { gross: toDecimalString(gross), withheld: toDecimalString(withheld) };
  if (input.instrumentId) metadata.instrumentId = input.instrumentId;
  return finalize(input, kind, lines, options, { metadata });
}

/** Dividend received, with optional withholding tax (Dr cash net, Dr tax withheld, Cr dividend income gross). */
export function buildDividendEntry(input: InvestmentIncomeInput, options: BuildOptions = {}): JournalEntry {
  return investmentIncome('dividend', input, options);
}

export interface InterestPaidInput extends EntryHeader, LineAttribution {
  direction: 'paid';
  entityId: string;
  cashLedgerAccountId: string;
  expenseLedgerAccountId: string;
  amount: Money;
}

/** Interest received (like a dividend, with optional withholding) or interest paid (Dr interest expense / Cr cash). */
export function buildInterestEntry(input: (InvestmentIncomeInput & { direction?: 'received' }) | InterestPaidInput, options: BuildOptions = {}): JournalEntry {
  if (input.direction === 'paid') {
    const amount = positive(input.amount, 'Interest');
    requireAccount(options.chart, input.expenseLedgerAccountId, { types: ['expense'] }, 'Interest expense account');
    const attr = attribution(input);
    const base = { ...attr, entityId: input.entityId, currency: input.amount.currency, nature: 'interest' as const };
    return finalize(
      input,
      'interest',
      [
        { ...base, ledgerAccountId: input.expenseLedgerAccountId, amount },
        { ...base, ledgerAccountId: input.cashLedgerAccountId, amount: amount.negated() },
      ],
      options,
      { metadata: { direction: 'paid' } },
    );
  }
  return investmentIncome('interest', input, options);
}

// ---------------------------------------------------------------------------------------------------------
// Pending entries
// ---------------------------------------------------------------------------------------------------------

/** Posts a pending entry (optionally on a different date). Posted entries are refused. */
export function postPendingEntry(entry: JournalEntry, changes: { effectiveDate?: IsoDate } = {}, options: BuildOptions = {}): JournalEntry {
  assertMutable(entry);
  const posted: JournalEntry = {
    ...entry,
    status: 'posted',
    effectiveDate: changes.effectiveDate ?? entry.effectiveDate,
    sourceRecordIds: [...entry.sourceRecordIds],
    metadata: { ...entry.metadata },
    lines: entry.lines.map((l) => ({ ...l })),
  };
  assertValidEntry(posted, options.chart ? { chart: options.chart } : {});
  return deepFreeze(posted);
}

export interface PendingAmendment {
  effectiveDate?: IsoDate;
  description?: string;
  lines?: readonly JournalLine[];
  metadata?: Readonly<Record<string, string>>;
}

/** Returns an amended copy of a pending entry. Posted and reversed entries are immutable and refused. */
export function amendPendingEntry(entry: JournalEntry, changes: PendingAmendment, options: BuildOptions = {}): JournalEntry {
  assertMutable(entry);
  const amended: JournalEntry = {
    ...entry,
    effectiveDate: changes.effectiveDate ?? entry.effectiveDate,
    description: changes.description ?? entry.description,
    sourceRecordIds: [...entry.sourceRecordIds],
    metadata: { ...(changes.metadata ?? entry.metadata) },
    lines: (changes.lines ?? entry.lines).map((l) => ({ ...l })),
  };
  assertValidEntry(amended, options.chart ? { chart: options.chart } : {});
  return deepFreeze(amended);
}

// ---------------------------------------------------------------------------------------------------------
// Balances and reports
// ---------------------------------------------------------------------------------------------------------

export interface BalanceOptions {
  /** Include entries effective on or before this date. */
  asOf?: IsoDate;
  /** Pending entries are excluded unless this is true. */
  includePending?: boolean;
  /** Only lines in this entity's books. */
  entityId?: string;
}

export interface LedgerBalance {
  ledgerAccountId: string;
  entityId: string;
  currency: string;
  /** Debit-positive net balance. */
  balance: Money;
  debits: Money;
  /** Credits as a positive magnitude. */
  credits: Money;
}

/**
 * Whether an entry counts toward balances. Posted and reversed entries count (a reversed entry's reversal is
 * posted and cancels it), pending entries only on request.
 */
export function entryCounts(entry: JournalEntry, options: BalanceOptions = {}): boolean {
  if (entry.status === 'pending' && !options.includePending) return false;
  if (options.asOf && entry.effectiveDate > options.asOf) return false;
  return true;
}

/** Balance per ledger account per currency (and per entity), sorted deterministically. */
export function computeLedgerBalances(entries: readonly JournalEntry[], options: BalanceOptions = {}): LedgerBalance[] {
  const totals = new Map<string, { ledgerAccountId: string; entityId: string; currency: string; debits: Dec; credits: Dec }>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new LedgerError(issue('invalid_input', `Entry ${entry.id} appears more than once`));
    seen.add(entry.id);
    if (!entryCounts(entry, options)) continue;
    assertValidEntry(entry);
    for (const line of entry.lines) {
      if (options.entityId && line.entityId !== options.entityId) continue;
      const key = `${line.entityId}\u0000${line.ledgerAccountId}\u0000${line.currency}`;
      const row = totals.get(key) ?? { ledgerAccountId: line.ledgerAccountId, entityId: line.entityId, currency: line.currency, debits: new D(0), credits: new D(0) };
      const amount = dec(line.amount);
      if (amount.isNegative()) row.credits = row.credits.plus(amount.negated());
      else row.debits = row.debits.plus(amount);
      totals.set(key, row);
    }
  }
  return [...totals.values()]
    .sort((a, b) => cmpStr(a.entityId, b.entityId) || cmpStr(a.ledgerAccountId, b.ledgerAccountId) || cmpStr(a.currency, b.currency))
    .map((row) => ({
      ledgerAccountId: row.ledgerAccountId,
      entityId: row.entityId,
      currency: row.currency,
      balance: money(row.debits.minus(row.credits), row.currency),
      debits: money(row.debits, row.currency),
      credits: money(row.credits, row.currency),
    }));
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Debit-positive balance of one ledger account in one currency (zero when it has no lines). */
export function ledgerAccountBalance(entries: readonly JournalEntry[], ledgerAccountId: string, currency: string, options: BalanceOptions = {}): Money {
  const row = computeLedgerBalances(entries, options).filter((r) => r.ledgerAccountId === ledgerAccountId && r.currency === currency);
  return money(row.reduce((acc, r) => acc.plus(dec(r.balance.amount)), new D(0)), currency);
}

export interface TrialBalanceRow {
  ledgerAccountId: string;
  name: string | null;
  type: LedgerAccountType | null;
  entityId: string;
  currency: string;
  /** Net debit balance (zero when the account is in credit). */
  debit: Money;
  /** Net credit balance as a positive magnitude (zero when the account is in debit). */
  credit: Money;
  balance: Money;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totals: Array<{ currency: string; debits: Money; credits: Money; balanced: boolean }>;
  /** Ledger accounts referenced by entries but missing from the chart. */
  unknownAccountIds: string[];
}

export function trialBalance(entries: readonly JournalEntry[], chart: LedgerChart, options: BalanceOptions = {}): TrialBalance {
  const balances = computeLedgerBalances(entries, options);
  const totals = new Map<string, { debits: Dec; credits: Dec }>();
  const unknown = new Set<string>();
  const rows = balances.map((b) => {
    const account = chart.get(b.ledgerAccountId) ?? null;
    if (!account) unknown.add(b.ledgerAccountId);
    const net = dec(b.balance.amount);
    const debit = net.isNegative() ? new D(0) : net;
    const credit = net.isNegative() ? net.negated() : new D(0);
    const t = totals.get(b.currency) ?? { debits: new D(0), credits: new D(0) };
    t.debits = t.debits.plus(debit);
    t.credits = t.credits.plus(credit);
    totals.set(b.currency, t);
    return {
      ledgerAccountId: b.ledgerAccountId,
      name: account?.name ?? null,
      type: account?.type ?? null,
      entityId: b.entityId,
      currency: b.currency,
      debit: money(debit, b.currency),
      credit: money(credit, b.currency),
      balance: b.balance,
    };
  });
  return {
    rows,
    totals: [...totals.entries()]
      .sort(([a], [b]) => cmpStr(a, b))
      .map(([currency, t]) => ({ currency, debits: money(t.debits, currency), credits: money(t.credits, currency), balanced: t.debits.equals(t.credits) })),
    unknownAccountIds: [...unknown].sort(),
  };
}

const LEDGER_TYPES: readonly LedgerAccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

export interface EntityBalanceSheet {
  entityId: string;
  asOf: IsoDate | null;
  /** Natural-sign totals: assets and expenses debit-positive; liabilities, equity and income credit-positive. */
  byType: Array<{ type: LedgerAccountType; currency: string; total: Money }>;
  accounts: Array<{ ledgerAccountId: string; name: string; type: LedgerAccountType; currency: string; balance: Money }>;
  /** assets = liabilities + equity + (income − expenses), per currency. */
  checks: Array<{ currency: string; assets: Money; liabilities: Money; equity: Money; currentEarnings: Money; balanced: boolean }>;
  unknownAccountIds: string[];
}

/** Entity-level balance sheet by account type, with a per-currency accounting-equation check. */
export function entityBalanceSheet(entries: readonly JournalEntry[], chart: LedgerChart, entityId: string, options: BalanceOptions = {}): EntityBalanceSheet {
  const balances = computeLedgerBalances(entries, { ...options, entityId });
  const byType = new Map<string, Dec>();
  const currencies = new Set<string>();
  const unknown: string[] = [];
  const accounts: EntityBalanceSheet['accounts'] = [];
  for (const b of balances) {
    const account = chart.get(b.ledgerAccountId);
    if (!account) {
      unknown.push(b.ledgerAccountId);
      continue;
    }
    const natural = account.type === 'asset' || account.type === 'expense' ? dec(b.balance.amount) : dec(b.balance.amount).negated();
    currencies.add(b.currency);
    const key = `${account.type}\u0000${b.currency}`;
    byType.set(key, (byType.get(key) ?? new D(0)).plus(natural));
    accounts.push({ ledgerAccountId: account.id, name: account.name, type: account.type, currency: b.currency, balance: money(natural, b.currency) });
  }
  const get = (type: LedgerAccountType, currency: string) => byType.get(`${type}\u0000${currency}`) ?? new D(0);
  const sortedCurrencies = [...currencies].sort();
  return {
    entityId,
    asOf: options.asOf ?? null,
    byType: LEDGER_TYPES.flatMap((type) =>
      sortedCurrencies.filter((c) => byType.has(`${type}\u0000${c}`)).map((currency) => ({ type, currency, total: money(get(type, currency), currency) })),
    ),
    accounts,
    checks: sortedCurrencies.map((currency) => {
      const assets = get('asset', currency);
      const liabilities = get('liability', currency);
      const equity = get('equity', currency);
      const earnings = get('income', currency).minus(get('expense', currency));
      return {
        currency,
        assets: money(assets, currency),
        liabilities: money(liabilities, currency),
        equity: money(equity, currency),
        currentEarnings: money(earnings, currency),
        balanced: assets.equals(liabilities.plus(equity).plus(earnings)),
      };
    }),
    unknownAccountIds: [...new Set(unknown)].sort(),
  };
}
