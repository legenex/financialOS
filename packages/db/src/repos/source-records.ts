/**
 * Immutable raw rows from imports and provider APIs.
 *
 * A source record is never edited: the trigger in migration 0001 only lets `last_seen_at`,
 * `superseded_by` and `deleted_upstream_at` change. When a provider revises a row, or a
 * pending row is later posted, a NEW record is inserted with `upstream_version + 1` and the
 * old one is superseded. Because `(account_id, dedupe_key)` is unique, later versions carry
 * a suffixed dedupe key (`<base>@v2`); the base key is what the dedupe planner sees.
 *
 * `insertBatch` applies the plan from `planImport` in `@financialos/domain`; the planner is
 * the single source of truth for what counts as a duplicate.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  planImport,
  type ExistingSourceRecord,
  type ImportDecision,
  type IncomingSourceRow,
  type PlanImportOptions,
  type PlannedImportRow,
} from '@financialos/domain';
import { sourceRecords, type SourceOrigin, type SOURCE_RECORD_KINDS } from '../schema/sources';
import { clampLimit, InvalidError, mapErrors, normalizeDecimal, required, tx, type DbOrTx } from './_util';

export type SourceRecordRow = typeof sourceRecords.$inferSelect;
export type SourceRecordKind = (typeof SOURCE_RECORD_KINDS)[number];

const VERSION_SUFFIX = /@v(\d+)$/;

/** The dedupe key stored for version `n` of a record. Version 1 keeps the planner's key. */
export function versionedDedupeKey(baseKey: string, version: number): string {
  if (!Number.isInteger(version) || version < 1) throw new InvalidError('upstream version must be a positive integer');
  return version === 1 ? baseKey : `${baseKey}@v${version}`;
}

/** Strips the version suffix so the planner compares like with like. */
export function baseDedupeKey(storedKey: string): string {
  return storedKey.replace(VERSION_SUFFIX, '');
}

/** One incoming row plus the extra columns the database keeps beside the planner's fields. */
export interface IncomingRecord extends IncomingSourceRow {
  /** The untouched upstream payload. Stored verbatim; never interpreted as instructions. */
  raw: Record<string, unknown>;
  recordKind?: SourceRecordKind;
  reference?: string | null;
  balanceAfter?: string | null;
  sourceTimezone?: string | null;
}

export interface InsertBatchInput {
  origin: SourceOrigin;
  rows: readonly IncomingRecord[];
  importBatchId?: string | null;
  connectionId?: string | null;
  documentId?: string | null;
  /**
   * What to do with rows the planner calls `possible_duplicate`. `hold` (default) writes
   * nothing and leaves the decision to the owner; `insert` accepts them as new records.
   */
  possibleDuplicatePolicy?: 'hold' | 'insert';
  plan?: PlanImportOptions;
  now?: Date;
}

export interface RowOutcome extends PlannedImportRow {
  /** The record written for this row, when one was written. */
  sourceRecordId: string | null;
  /** True when this row superseded `matchedRecordId`. */
  superseded: boolean;
}

export interface InsertBatchResult {
  outcomes: RowOutcome[];
  counts: {
    total: number;
    new: number;
    duplicate: number;
    possibleDuplicate: number;
    pendingToPosted: number;
    changedUpstream: number;
    inserted: number;
  };
}

function toExisting(row: SourceRecordRow): ExistingSourceRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    bookedOn: row.bookedOn ?? '1970-01-01',
    amount: { amount: normalizeDecimal(row.amount ?? '0'), currency: row.currency ?? 'XXX' },
    description: row.description ?? '',
    providerTransactionId: row.providerId,
    pending: row.pending,
    state: row.supersededBy || row.deletedUpstreamAt ? 'superseded' : 'active',
    dedupeKey: baseDedupeKey(row.dedupeKey),
    contentHash: row.contentHash,
  };
}

/**
 * Applies a dedupe plan and writes the resulting records in one transaction.
 *
 * - `new` → insert
 * - `duplicate` → nothing written; the matched record's `last_seen_at` is refreshed
 * - `pending_to_posted` / `changed_upstream` → a new version is inserted and the matched
 *   record is superseded by it
 * - `possible_duplicate` → held for the owner by default (nothing written)
 */
export async function insertBatch(db: DbOrTx, input: InsertBatchInput): Promise<InsertBatchResult> {
  const now = input.now ?? new Date();
  const policy = input.possibleDuplicatePolicy ?? 'hold';
  if (input.rows.length === 0) {
    return { outcomes: [], counts: { total: 0, new: 0, duplicate: 0, possibleDuplicate: 0, pendingToPosted: 0, changedUpstream: 0, inserted: 0 } };
  }
  for (const row of input.rows) {
    if (!row.accountId) throw new InvalidError(`Row ${row.rowNumber} has no account`);
  }

  return mapErrors('insert source records', () =>
    tx(db, async (t) => {
      const accountIds = [...new Set(input.rows.map((r) => r.accountId))];
      const existingRows = await t
        .select()
        .from(sourceRecords)
        .where(inArray(sourceRecords.accountId, accountIds))
        .orderBy(asc(sourceRecords.createdAt));
      const byId = new Map(existingRows.map((r) => [r.id, r]));
      const plan = planImport(existingRows.map(toExisting), input.rows, input.plan ?? {});

      const outcomes: RowOutcome[] = [];
      let inserted = 0;
      for (const planned of plan.rows) {
        const row = required(
          input.rows.find((r) => r.rowNumber === planned.rowNumber),
          `incoming row ${planned.rowNumber}`,
        );
        const matched = planned.matchedRecordId ? byId.get(planned.matchedRecordId) : undefined;

        if (planned.status === 'duplicate') {
          if (matched) await touch(t, matched.id, now);
          outcomes.push({ ...planned, sourceRecordId: matched?.id ?? null, superseded: false });
          continue;
        }
        if (planned.status === 'possible_duplicate' && policy === 'hold') {
          if (matched) await touch(t, matched.id, now);
          outcomes.push({ ...planned, sourceRecordId: null, superseded: false });
          continue;
        }

        const supersedes = planned.status === 'pending_to_posted' || planned.status === 'changed_upstream' ? matched : undefined;
        const version = (supersedes?.upstreamVersion ?? 0) + 1;
        const record = await insertRecord(t, {
          row,
          input,
          dedupeKey: versionedDedupeKey(planned.dedupeKey, version),
          contentHash: planned.contentHash,
          upstreamVersion: version,
          now,
        });
        inserted += 1;
        if (supersedes) await supersede(t, supersedes.id, record.id, now);
        outcomes.push({ ...planned, sourceRecordId: record.id, superseded: Boolean(supersedes) });
      }

      return {
        outcomes,
        counts: { ...plan.counts, inserted },
      };
    }),
  );
}

async function insertRecord(
  db: DbOrTx,
  args: { row: IncomingRecord; input: InsertBatchInput; dedupeKey: string; contentHash: string; upstreamVersion: number; now: Date },
): Promise<SourceRecordRow> {
  const { row, input } = args;
  const [record] = await db
    .insert(sourceRecords)
    .values({
      accountId: row.accountId,
      origin: input.origin,
      recordKind: row.recordKind ?? 'transaction',
      connectionId: input.connectionId ?? null,
      importBatchId: input.importBatchId ?? null,
      documentId: input.documentId ?? null,
      providerId: row.providerTransactionId?.trim() || null,
      dedupeKey: args.dedupeKey,
      contentHash: args.contentHash,
      upstreamVersion: args.upstreamVersion,
      raw: row.raw,
      bookedOn: row.bookedOn,
      valueOn: row.valueOn ?? null,
      sourceTimezone: row.sourceTimezone ?? null,
      amount: row.amount.amount,
      currency: row.amount.currency,
      description: row.description,
      counterpartyName: row.counterparty ?? null,
      reference: row.reference ?? null,
      balanceAfter: row.balanceAfter ?? null,
      pending: row.pending ?? false,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
    })
    .returning();
  return required(record, 'source record');
}

async function touch(db: DbOrTx, id: string, now: Date): Promise<void> {
  await db.update(sourceRecords).set({ lastSeenAt: now }).where(eq(sourceRecords.id, id));
}

/**
 * Links a superseded record to the version that replaces it. This is one of the three
 * columns the immutability trigger allows to change.
 */
export async function supersede(db: DbOrTx, oldRecordId: string, newRecordId: string, now = new Date()): Promise<SourceRecordRow> {
  if (oldRecordId === newRecordId) throw new InvalidError('A source record cannot supersede itself');
  return mapErrors('supersede source record', async () => {
    const [row] = await db
      .update(sourceRecords)
      .set({ supersededBy: newRecordId, lastSeenAt: now })
      .where(and(eq(sourceRecords.id, oldRecordId), isNull(sourceRecords.supersededBy)))
      .returning();
    return required(row, 'source record (already superseded?)');
  });
}

/**
 * Records that the pending version was replaced by a posted one. The pending record keeps
 * its own history; only the supersede link changes.
 */
export async function markPendingPosted(
  db: DbOrTx,
  input: { pendingRecordId: string; postedRecordId: string },
  now = new Date(),
): Promise<SourceRecordRow> {
  const pending = await getById(db, input.pendingRecordId);
  if (!pending) throw new InvalidError('Pending source record not found');
  if (!pending.pending) throw new InvalidError(`Source record ${input.pendingRecordId} is not pending`);
  const posted = await getById(db, input.postedRecordId);
  if (!posted) throw new InvalidError('Posted source record not found');
  if (posted.pending) throw new InvalidError(`Source record ${input.postedRecordId} is still pending`);
  return supersede(db, input.pendingRecordId, input.postedRecordId, now);
}

/** The upstream source no longer reports this record. The row itself stays. */
export async function markDeletedUpstream(db: DbOrTx, id: string, now = new Date()): Promise<SourceRecordRow> {
  return mapErrors('mark source record deleted upstream', async () => {
    const [row] = await db
      .update(sourceRecords)
      .set({ deletedUpstreamAt: now, lastSeenAt: now })
      .where(eq(sourceRecords.id, id))
      .returning();
    return required(row, 'source record');
  });
}

export async function markSeen(db: DbOrTx, ids: readonly string[], now = new Date()): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(sourceRecords)
    .set({ lastSeenAt: now })
    .where(inArray(sourceRecords.id, [...ids]))
    .returning({ id: sourceRecords.id });
  return rows.length;
}

// ---------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------

export async function getById(db: DbOrTx, id: string): Promise<SourceRecordRow | undefined> {
  const [row] = await db.select().from(sourceRecords).where(eq(sourceRecords.id, id)).limit(1);
  return row;
}

/** Looks up by the stored key; pass a base key to find version 1. */
export async function getByDedupeKey(db: DbOrTx, accountId: string, dedupeKey: string): Promise<SourceRecordRow | undefined> {
  const [row] = await db
    .select()
    .from(sourceRecords)
    .where(and(eq(sourceRecords.accountId, accountId), eq(sourceRecords.dedupeKey, dedupeKey)))
    .limit(1);
  return row;
}

/** Every version stored under one base dedupe key, oldest first. */
export async function listVersionsByDedupeKey(db: DbOrTx, accountId: string, baseKey: string): Promise<SourceRecordRow[]> {
  return db
    .select()
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.accountId, accountId),
        sql`${sourceRecords.dedupeKey} = ${baseKey} OR ${sourceRecords.dedupeKey} LIKE ${`${baseKey}@v%`}`,
      ),
    )
    .orderBy(asc(sourceRecords.upstreamVersion));
}

export interface SourceRecordQuery {
  accountId?: string | string[];
  from?: string;
  to?: string;
  importBatchId?: string;
  connectionId?: string;
  recordKind?: SourceRecordKind;
  /** Skip records that were superseded or deleted upstream (default true). */
  activeOnly?: boolean;
  pending?: boolean;
  limit?: number;
}

export async function list(db: DbOrTx, query: SourceRecordQuery = {}): Promise<SourceRecordRow[]> {
  const conditions: SQL[] = [];
  if (query.accountId) {
    conditions.push(inArray(sourceRecords.accountId, Array.isArray(query.accountId) ? query.accountId : [query.accountId]));
  }
  if (query.from) conditions.push(gte(sourceRecords.bookedOn, query.from));
  if (query.to) conditions.push(lte(sourceRecords.bookedOn, query.to));
  if (query.importBatchId) conditions.push(eq(sourceRecords.importBatchId, query.importBatchId));
  if (query.connectionId) conditions.push(eq(sourceRecords.connectionId, query.connectionId));
  if (query.recordKind) conditions.push(eq(sourceRecords.recordKind, query.recordKind));
  if (query.pending !== undefined) conditions.push(eq(sourceRecords.pending, query.pending));
  if (query.activeOnly !== false) {
    conditions.push(isNull(sourceRecords.supersededBy));
    conditions.push(isNull(sourceRecords.deletedUpstreamAt));
  }
  return db
    .select()
    .from(sourceRecords)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(sourceRecords.bookedOn), asc(sourceRecords.createdAt))
    .limit(clampLimit(query.limit, 500, 5000));
}

export async function listByAccount(db: DbOrTx, accountId: string, query: Omit<SourceRecordQuery, 'accountId'> = {}): Promise<SourceRecordRow[]> {
  return list(db, { ...query, accountId });
}

/** Most recently seen record on an account, used to decide what to backfill. */
export async function latestForAccount(db: DbOrTx, accountId: string): Promise<SourceRecordRow | undefined> {
  const [row] = await db
    .select()
    .from(sourceRecords)
    .where(eq(sourceRecords.accountId, accountId))
    .orderBy(desc(sourceRecords.bookedOn), desc(sourceRecords.createdAt))
    .limit(1);
  return row;
}

/** Counts by planner decision, for job progress and import summaries. */
export function summarise(outcomes: readonly RowOutcome[]): Record<ImportDecision | 'inserted', number> {
  const counts = { new: 0, duplicate: 0, possible_duplicate: 0, pending_to_posted: 0, changed_upstream: 0, inserted: 0 };
  for (const outcome of outcomes) {
    counts[outcome.status] += 1;
    if (outcome.sourceRecordId && outcome.status !== 'duplicate') counts.inserted += 1;
  }
  return counts;
}
