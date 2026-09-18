/**
 * Read model for transactions: immutable source records plus their current classification version.
 *
 * A "transaction" in the API is one `source_records` row of kind `transaction` joined to the single
 * current `classifications` row. Classification changes append a new version; nothing is overwritten.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type {
  ClassificationInput,
  Confidence,
  Money,
  SplitLine,
  Transaction,
  TransactionNature,
  TransactionPage,
  TransactionQuery,
} from '@financialos/contracts';
import {
  accounts as accountsTable,
  categories as categoriesTable,
  classifications,
  counterparties,
  sourceRecordTags,
  sourceRecords,
  tags as tagsTable,
  transferMatches,
  type DbOrTx,
} from '@financialos/db';
import { convert, nextClassificationVersion, type ClassificationContent, type ClassificationVersion, type FxTable } from '@financialos/domain';
import type { BudgetTransaction, ConsolidationFlow, RunwayFlow } from '@financialos/domain';
import { decodeCursor, encodeCursor, iso, normalizeDecimal } from './common';

export type SourceRecordRow = typeof sourceRecords.$inferSelect;
export type ClassificationRow = typeof classifications.$inferSelect;

export interface TransactionRow {
  record: SourceRecordRow;
  classification: ClassificationRow | null;
  accountName: string;
  accountEntityId: string | null;
  accountCurrency: string | null;
  categoryName: string | null;
}

export interface TransactionContext {
  reportingCurrency: string;
  fx: FxTable;
}

function statusOf(record: SourceRecordRow): Transaction['status'] {
  if (record.supersededBy) return 'superseded';
  if (record.deletedUpstreamAt) return 'reversed';
  return record.pending ? 'pending' : 'posted';
}

function splitsOf(row: ClassificationRow | null): SplitLine[] | null {
  if (!row?.splits) return null;
  return row.splits.map((s) => ({
    amount: normalizeDecimal(String(s.amount ?? '0')),
    categoryId: typeof s.categoryId === 'string' ? s.categoryId : null,
    nature: (s.nature as TransactionNature) ?? 'unknown',
    economicOwnerEntityId: typeof s.economicOwnerEntityId === 'string' ? s.economicOwnerEntityId : null,
    memo: typeof s.memo === 'string' ? s.memo : null,
  }));
}

export function transactionView(
  row: TransactionRow,
  ctx: TransactionContext,
  extras: { tags?: string[]; transferMatch?: Transaction['transferMatch'] } = {},
): Transaction {
  const record = row.record;
  const currency = record.currency ?? row.accountCurrency;
  const amount: Money = { amount: normalizeDecimal(record.amount ?? '0'), currency: currency ?? 'XXX' };
  const known = record.amount !== null && currency !== null;
  const reporting =
    known && currency !== ctx.reportingCurrency && record.bookedOn
      ? convert(amount, ctx.reportingCurrency, record.bookedOn, ctx.fx, { method: 'historical' })
      : null;
  const classification = row.classification;
  return {
    id: record.id,
    accountId: record.accountId,
    accountName: row.accountName,
    entityId: row.accountEntityId,
    bookedOn: record.bookedOn ?? (record.firstSeenAt.toISOString().slice(0, 10) as string),
    valueOn: record.valueOn,
    sourceTimezone: record.sourceTimezone,
    status: statusOf(record),
    amount,
    reporting,
    description: record.description ?? '',
    counterparty: record.counterpartyName,
    category: classification?.categoryId ? { id: classification.categoryId, name: row.categoryName ?? 'Category' } : null,
    nature: classification?.nature ?? 'unknown',
    economicOwnerEntityId: classification?.economicOwnerEntityId ?? null,
    classification: {
      version: classification?.version ?? 0,
      method: classification?.method ?? 'none',
      confidence: (classification?.confidence ?? 'none') as Confidence,
      needsReview: classification?.needsReview ?? true,
    },
    splits: splitsOf(classification),
    transferMatch: extras.transferMatch ?? null,
    tags: extras.tags ?? [],
    source: {
      kind: record.origin,
      batchId: record.importBatchId,
      externalId: record.providerId,
    },
    documentIds: record.documentId ? [record.documentId] : [],
  };
}

function baseSelect(db: DbOrTx) {
  return db
    .select({
      record: sourceRecords,
      classification: classifications,
      accountName: accountsTable.name,
      accountEntityId: accountsTable.legalEntityId,
      accountCurrency: accountsTable.currency,
      categoryName: categoriesTable.name,
    })
    .from(sourceRecords)
    .innerJoin(accountsTable, eq(sourceRecords.accountId, accountsTable.id))
    .leftJoin(classifications, and(eq(classifications.sourceRecordId, sourceRecords.id), eq(classifications.isCurrent, true)))
    .leftJoin(categoriesTable, eq(classifications.categoryId, categoriesTable.id));
}

export interface TransactionFilters extends Partial<TransactionQuery> {
  /** Restrict to the accounts of these legal entities (entity scope). */
  entityIds?: readonly string[];
  accountIds?: readonly string[];
}

function filterConditions(query: TransactionFilters): SQL[] {
  const conditions: SQL[] = [eq(sourceRecords.recordKind, 'transaction')];
  if (query.accountId) conditions.push(eq(sourceRecords.accountId, query.accountId));
  if (query.accountIds) conditions.push(inArray(sourceRecords.accountId, query.accountIds.length ? [...query.accountIds] : ['00000000-0000-0000-0000-000000000000']));
  if (query.entityId) conditions.push(eq(accountsTable.legalEntityId, query.entityId));
  if (query.entityIds) conditions.push(inArray(accountsTable.legalEntityId, query.entityIds.length ? [...query.entityIds] : ['00000000-0000-0000-0000-000000000000']));
  if (query.from) conditions.push(gte(sourceRecords.bookedOn, query.from));
  if (query.to) conditions.push(lte(sourceRecords.bookedOn, query.to));
  if (query.nature) conditions.push(eq(classifications.nature, query.nature));
  if (query.categoryId) conditions.push(eq(classifications.categoryId, query.categoryId));
  if (query.needsReview !== undefined) {
    conditions.push(query.needsReview ? or(eq(classifications.needsReview, true), isNull(classifications.id))! : eq(classifications.needsReview, false));
  }
  if (query.status === 'pending') conditions.push(and(eq(sourceRecords.pending, true), isNull(sourceRecords.supersededBy))!);
  if (query.status === 'posted') conditions.push(and(eq(sourceRecords.pending, false), isNull(sourceRecords.supersededBy), isNull(sourceRecords.deletedUpstreamAt))!);
  if (query.status === 'superseded') conditions.push(sql`${sourceRecords.supersededBy} is not null`);
  if (query.status === 'reversed') conditions.push(sql`${sourceRecords.deletedUpstreamAt} is not null`);
  if (query.q) {
    // Case-insensitive substring search over the text the owner actually sees.
    const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      or(
        sql`${sourceRecords.description} ILIKE ${like}`,
        sql`${sourceRecords.counterpartyName} ILIKE ${like}`,
        sql`${sourceRecords.reference} ILIKE ${like}`,
      )!,
    );
  }
  return conditions;
}

async function decorate(db: DbOrTx, rows: TransactionRow[], ctx: TransactionContext): Promise<Transaction[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.record.id);
  const [tagRows, matchRows] = await Promise.all([
    db
      .select({ sourceRecordId: sourceRecordTags.sourceRecordId, name: tagsTable.name })
      .from(sourceRecordTags)
      .innerJoin(tagsTable, eq(sourceRecordTags.tagId, tagsTable.id))
      .where(inArray(sourceRecordTags.sourceRecordId, ids)),
    db
      .select()
      .from(transferMatches)
      .where(or(inArray(transferMatches.fromSourceRecordId, ids), inArray(transferMatches.toSourceRecordId, ids))),
  ]);
  const tagsById = new Map<string, string[]>();
  for (const row of tagRows) {
    const list = tagsById.get(row.sourceRecordId) ?? [];
    list.push(row.name);
    tagsById.set(row.sourceRecordId, list);
  }
  const matchById = new Map<string, Transaction['transferMatch']>();
  for (const match of matchRows) {
    const forFrom = { matchId: match.id, otherTransactionId: match.toSourceRecordId, confidence: match.confidence, status: match.status };
    const forTo = { matchId: match.id, otherTransactionId: match.fromSourceRecordId, confidence: match.confidence, status: match.status };
    if (!matchById.has(match.fromSourceRecordId)) matchById.set(match.fromSourceRecordId, forFrom);
    if (!matchById.has(match.toSourceRecordId)) matchById.set(match.toSourceRecordId, forTo);
  }
  return rows.map((row) =>
    transactionView(row, ctx, {
      tags: (tagsById.get(row.record.id) ?? []).sort(),
      transferMatch: matchById.get(row.record.id) ?? null,
    }),
  );
}

/** Keyset paging over (booked_on desc, id desc). Stable when rows are inserted concurrently. */
export async function loadTransactionPage(db: DbOrTx, query: TransactionFilters, ctx: TransactionContext): Promise<TransactionPage> {
  const limit = query.limit ?? 50;
  const conditions = filterConditions(query);
  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    conditions.push(
      sql`(${sourceRecords.bookedOn}, ${sourceRecords.id}) < (${cursor.key}::date, ${cursor.id}::uuid)`,
    );
  }
  const rows = await baseSelect(db)
    .where(and(...conditions))
    .orderBy(desc(sourceRecords.bookedOn), desc(sourceRecords.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const items = await decorate(db, page, ctx);
  const last = page.at(-1);
  const nextCursor = rows.length > limit && last?.record.bookedOn ? encodeCursor(last.record.bookedOn, last.record.id) : null;
  return { items, nextCursor };
}

export async function loadTransaction(db: DbOrTx, id: string, ctx: TransactionContext): Promise<Transaction | null> {
  const rows = await baseSelect(db).where(and(eq(sourceRecords.id, id), eq(sourceRecords.recordKind, 'transaction'))).limit(1);
  const [items] = await Promise.all([decorate(db, rows, ctx)]);
  return items[0] ?? null;
}

export interface ClassificationHistoryItem {
  version: number;
  method: ClassificationRow['method'];
  nature: TransactionNature;
  categoryId: string | null;
  economicOwnerEntityId: string | null;
  confidence: Confidence;
  needsReview: boolean;
  note: string | null;
  createdBy: string;
  createdAt: string;
  current: boolean;
}

export async function classificationHistory(db: DbOrTx, sourceRecordId: string): Promise<ClassificationHistoryItem[]> {
  const rows = await db
    .select()
    .from(classifications)
    .where(eq(classifications.sourceRecordId, sourceRecordId))
    .orderBy(desc(classifications.version))
    .limit(100);
  return rows.map((row) => ({
    version: row.version,
    method: row.method,
    nature: row.nature,
    categoryId: row.categoryId,
    economicOwnerEntityId: row.economicOwnerEntityId,
    confidence: row.confidence,
    needsReview: row.needsReview,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    current: row.isCurrent,
  }));
}

function toVersion(row: ClassificationRow): ClassificationVersion {
  return {
    sourceRecordId: row.sourceRecordId,
    version: row.version,
    current: row.isCurrent,
    createdAt: row.createdAt.toISOString(),
    supersedesVersion: row.version > 1 ? row.version - 1 : null,
    supersededAt: null,
    method: row.method,
    categoryId: row.categoryId,
    nature: row.nature,
    economicOwnerEntityId: row.economicOwnerEntityId,
    splits: splitsOf(row),
    tags: [],
    confidence: row.confidence,
    needsReview: row.needsReview,
    explanation: [],
    ruleIds: [],
    note: row.note,
  };
}

export type ClassifyOutcome =
  | { applied: true; version: number }
  | { applied: false; reason: 'unchanged' | 'protected_user_decision'; version: number };

/**
 * Appends a new owner classification version inside one transaction. The previous current row is
 * marked not-current first so the `classifications_one_current` unique index always holds.
 */
export async function applyOwnerClassification(
  db: DbOrTx,
  sourceRecordId: string,
  input: ClassificationInput,
  options: { at: Date; createdBy: string },
): Promise<ClassifyOutcome> {
  const [current] = await db
    .select()
    .from(classifications)
    .where(and(eq(classifications.sourceRecordId, sourceRecordId), eq(classifications.isCurrent, true)))
    .limit(1);
  const content: ClassificationContent = {
    method: 'user',
    categoryId: input.categoryId,
    nature: input.nature,
    economicOwnerEntityId: input.economicOwnerEntityId,
    splits: input.splits,
    tags: [],
    confidence: 'high',
    needsReview: false,
    explanation: ['Classified by the owner'],
    ruleIds: [],
    note: input.note,
  };
  const result = nextClassificationVersion(current ? toVersion(current) : null, sourceRecordId, content, { at: options.at.toISOString() });
  if (!result.applied) return { applied: false, reason: result.reason, version: current?.version ?? 0 };
  if (current) {
    await db.update(classifications).set({ isCurrent: false }).where(eq(classifications.id, current.id));
  }
  await db.insert(classifications).values({
    sourceRecordId,
    version: result.next.version,
    isCurrent: true,
    nature: result.next.nature,
    categoryId: result.next.categoryId,
    economicOwnerEntityId: result.next.economicOwnerEntityId,
    counterpartyId: input.counterpartyId ?? null,
    splits: result.next.splits ? result.next.splits.map((s) => ({ ...s })) : null,
    confidence: result.next.confidence,
    method: result.next.method,
    needsReview: result.next.needsReview,
    note: result.next.note,
    createdBy: options.createdBy,
    createdAt: options.at,
  });
  return { applied: true, version: result.next.version };
}

// ---------------------------------------------------------------------------------------------
// Domain-engine projections of the same rows
// ---------------------------------------------------------------------------------------------

export async function loadClassifiedRows(db: DbOrTx, filters: TransactionFilters, limit = 20_000): Promise<TransactionRow[]> {
  const conditions = filterConditions(filters);
  conditions.push(isNull(sourceRecords.supersededBy), isNull(sourceRecords.deletedUpstreamAt));
  return baseSelect(db)
    .where(and(...conditions))
    .orderBy(asc(sourceRecords.bookedOn), asc(sourceRecords.id))
    .limit(limit);
}

export function toRunwayFlows(rows: readonly TransactionRow[], counterpartyEntityByRecord?: ReadonlyMap<string, string | null>): RunwayFlow[] {
  const flows: RunwayFlow[] = [];
  for (const row of rows) {
    const currency = row.record.currency ?? row.accountCurrency;
    if (row.record.amount === null || currency === null || !row.record.bookedOn) continue;
    const nature = row.classification?.nature ?? 'unknown';
    const splits = splitsOf(row.classification);
    const base = {
      accountId: row.record.accountId,
      date: row.record.bookedOn,
      counterpartyEntityId: counterpartyEntityByRecord?.get(row.record.id) ?? null,
      status: row.record.pending ? ('pending' as const) : ('posted' as const),
      label: row.record.description ?? 'Transaction',
    };
    if (splits && splits.length > 0) {
      splits.forEach((split, i) => {
        flows.push({ ...base, id: `${row.record.id}:${i}`, amount: { amount: split.amount, currency }, nature: split.nature });
      });
    } else {
      flows.push({ ...base, id: row.record.id, amount: { amount: normalizeDecimal(row.record.amount!), currency }, nature });
    }
  }
  return flows;
}

export function toBudgetTransactions(rows: readonly TransactionRow[]): BudgetTransaction[] {
  const out: BudgetTransaction[] = [];
  for (const row of rows) {
    const currency = row.record.currency ?? row.accountCurrency;
    if (row.record.amount === null || currency === null || !row.record.bookedOn) continue;
    const splits = splitsOf(row.classification);
    out.push({
      id: row.record.id,
      date: row.record.bookedOn,
      amount: { amount: normalizeDecimal(row.record.amount), currency },
      nature: row.classification?.nature ?? 'unknown',
      categoryId: row.classification?.categoryId ?? null,
      status: row.record.pending ? 'pending' : 'posted',
      splits: splits ? splits.map((s) => ({ amount: s.amount, categoryId: s.categoryId, nature: s.nature })) : null,
      economicOwnerEntityId: row.classification?.economicOwnerEntityId ?? null,
      description: row.record.description ?? undefined,
    });
  }
  return out;
}

export function toConsolidationFlows(
  rows: readonly TransactionRow[],
  counterpartyEntityByRecord: ReadonlyMap<string, string | null>,
): ConsolidationFlow[] {
  const flows: ConsolidationFlow[] = [];
  for (const row of rows) {
    const currency = row.record.currency ?? row.accountCurrency;
    if (row.record.amount === null || currency === null || !row.record.bookedOn || row.accountEntityId === null) continue;
    flows.push({
      id: row.record.id,
      entityId: row.accountEntityId,
      counterpartyEntityId: counterpartyEntityByRecord.get(row.record.id) ?? null,
      amount: { amount: normalizeDecimal(row.record.amount), currency },
      nature: row.classification?.nature ?? 'unknown',
      date: row.record.bookedOn,
      label: row.record.description ?? 'Transaction',
      categoryId: row.classification?.categoryId ?? null,
      links: [{ kind: 'transaction', id: row.record.id, label: row.record.description ?? 'Transaction' }],
    });
  }
  return flows;
}

/** Counterparty entity per record: from the classification's counterparty when it is one of our entities. */
export async function counterpartyEntities(db: DbOrTx, rows: readonly TransactionRow[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const counterpartyIds = [...new Set(rows.map((r) => r.classification?.counterpartyId).filter((v): v is string => typeof v === 'string'))];
  if (counterpartyIds.length === 0) return map;
  const rowsCp = await db
    .select({ id: counterparties.id, entityId: counterparties.entityId })
    .from(counterparties)
    .where(inArray(counterparties.id, counterpartyIds));
  const entityByCounterparty = new Map(rowsCp.map((r) => [r.id, r.entityId]));
  for (const row of rows) {
    const cp = row.classification?.counterpartyId;
    map.set(row.record.id, cp ? (entityByCounterparty.get(cp) ?? null) : null);
  }
  return map;
}
