/**
 * Trades, dividends, interest, fees and transfers reported by a broker or wallet.
 *
 * These rows describe what the source said happened. The ledger effect of a trade is a
 * separate journal entry (`journal.postEntry` with `buildInvestmentTradeEntry`), linked by
 * `journalEntryId`. Quantities are decimal strings and never mixed into money columns.
 */
import { and, asc, desc, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';
import { investmentTransactions, INVESTMENT_TRANSACTION_KINDS } from '../schema/accounts';
import { assertDecimal, clampLimit, mapErrors, required, type DbOrTx } from './_util';

export type InvestmentTransactionRow = typeof investmentTransactions.$inferSelect;
export type InvestmentTransactionKind = (typeof INVESTMENT_TRANSACTION_KINDS)[number];

export interface RecordInput {
  accountId: string;
  kind: InvestmentTransactionKind;
  tradeDate: string;
  instrumentId?: string | null;
  sourceRecordId?: string | null;
  settleDate?: string | null;
  quantity?: string | null;
  price?: string | null;
  amount?: string | null;
  currency?: string | null;
  fees?: string | null;
  feeCurrency?: string | null;
  /** Stable broker identifier; makes re-imports idempotent per account. */
  externalId?: string | null;
  journalEntryId?: string | null;
  details?: Record<string, unknown>;
}

function check(input: RecordInput): void {
  for (const [label, value] of [
    ['quantity', input.quantity],
    ['price', input.price],
    ['amount', input.amount],
    ['fees', input.fees],
  ] as const) {
    if (value != null) assertDecimal(value, label);
  }
}

/** Inserts, or returns the existing row when the same `externalId` was already recorded. */
export async function record(db: DbOrTx, input: RecordInput): Promise<{ row: InvestmentTransactionRow; created: boolean }> {
  check(input);
  return mapErrors('record investment transaction', async () => {
    const values = {
      accountId: input.accountId,
      instrumentId: input.instrumentId ?? null,
      sourceRecordId: input.sourceRecordId ?? null,
      kind: input.kind,
      tradeDate: input.tradeDate,
      settleDate: input.settleDate ?? null,
      quantity: input.quantity ?? null,
      price: input.price ?? null,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      fees: input.fees ?? null,
      feeCurrency: input.feeCurrency ?? null,
      externalId: input.externalId ?? null,
      journalEntryId: input.journalEntryId ?? null,
      details: input.details ?? {},
    };
    if (!input.externalId) {
      const [row] = await db.insert(investmentTransactions).values(values).returning();
      return { row: required(row, 'investment transaction'), created: true };
    }
    const inserted = await db
      .insert(investmentTransactions)
      .values(values)
      .onConflictDoNothing({ target: [investmentTransactions.accountId, investmentTransactions.externalId] })
      .returning();
    if (inserted[0]) return { row: inserted[0], created: true };
    const [existing] = await db
      .select()
      .from(investmentTransactions)
      .where(and(eq(investmentTransactions.accountId, input.accountId), eq(investmentTransactions.externalId, input.externalId)))
      .limit(1);
    return { row: required(existing, 'investment transaction'), created: false };
  });
}

/** Links an already recorded transaction to the journal entry that booked it. */
export async function linkJournalEntry(db: DbOrTx, id: string, journalEntryId: string): Promise<InvestmentTransactionRow> {
  const [row] = await db.update(investmentTransactions).set({ journalEntryId }).where(eq(investmentTransactions.id, id)).returning();
  return required(row, 'investment transaction');
}

export async function getById(db: DbOrTx, id: string): Promise<InvestmentTransactionRow | undefined> {
  const [row] = await db.select().from(investmentTransactions).where(eq(investmentTransactions.id, id)).limit(1);
  return row;
}

export interface Query {
  accountId?: string | string[];
  instrumentId?: string;
  kind?: InvestmentTransactionKind | InvestmentTransactionKind[];
  from?: string;
  to?: string;
  limit?: number;
}

export async function list(db: DbOrTx, query: Query = {}): Promise<InvestmentTransactionRow[]> {
  const conditions: SQL[] = [];
  if (query.accountId) {
    conditions.push(inArray(investmentTransactions.accountId, Array.isArray(query.accountId) ? query.accountId : [query.accountId]));
  }
  if (query.instrumentId) conditions.push(eq(investmentTransactions.instrumentId, query.instrumentId));
  if (query.kind) conditions.push(inArray(investmentTransactions.kind, Array.isArray(query.kind) ? query.kind : [query.kind]));
  if (query.from) conditions.push(gte(investmentTransactions.tradeDate, query.from));
  if (query.to) conditions.push(lte(investmentTransactions.tradeDate, query.to));
  return db
    .select()
    .from(investmentTransactions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(investmentTransactions.tradeDate), asc(investmentTransactions.createdAt))
    .limit(clampLimit(query.limit, 500, 5000));
}

export async function latestForAccount(db: DbOrTx, accountId: string): Promise<InvestmentTransactionRow | undefined> {
  const [row] = await db
    .select()
    .from(investmentTransactions)
    .where(eq(investmentTransactions.accountId, accountId))
    .orderBy(desc(investmentTransactions.tradeDate), desc(investmentTransactions.createdAt))
    .limit(1);
  return row;
}
