/**
 * Import batches, their rows, remembered templates, coverage periods and reconciliations.
 *
 * An import is never destructive: committing writes source records and journal entries,
 * reversing them is an auditable reversal, and the batch keeps its counts either way.
 * Reconciliation only reports — `checkStatement` in `@financialos/domain` never produces a
 * balancing entry, and neither does this repository.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { checkStatement, type StatementCheckResult } from '@financialos/domain';
import {
  coveragePeriods,
  importBatches,
  importRows,
  importTemplates,
  reconciliations,
  EMPTY_IMPORT_COUNTS,
  type ImportBatchStatusValue,
  type ImportCounts,
  type COVERAGE_SOURCES,
  type IMPORT_FILE_KINDS,
  type IMPORT_ROW_STATUSES,
  type RECONCILIATION_STATUSES,
} from '../schema/documents';
import { assertDecimal, ConflictError, InvalidError, mapErrors, pickDefined, required, tx, type DbOrTx } from './_util';

export type ImportBatchRow = typeof importBatches.$inferSelect;
export type ImportRowRow = typeof importRows.$inferSelect;
export type ImportTemplateRow = typeof importTemplates.$inferSelect;
export type CoveragePeriodRow = typeof coveragePeriods.$inferSelect;
export type ReconciliationRow = typeof reconciliations.$inferSelect;
export type ImportFileKind = (typeof IMPORT_FILE_KINDS)[number];
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];
export type CoverageSource = (typeof COVERAGE_SOURCES)[number];
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

// ---------------------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------------------

export interface CreateBatchInput {
  fileName: string;
  fileSha256: string;
  sizeBytes: number;
  fileKind?: ImportFileKind | null;
  documentId?: string | null;
  accountId?: string | null;
  entityId?: string | null;
  templateId?: string | null;
  connectionId?: string | null;
  /** Makes a re-upload of the same file return the same batch. */
  idempotencyKey?: string | null;
  createdBy?: string;
}

export async function createBatch(db: DbOrTx, input: CreateBatchInput): Promise<{ row: ImportBatchRow; created: boolean }> {
  return mapErrors('create import batch', async () => {
    const values = {
      fileName: input.fileName,
      fileSha256: input.fileSha256,
      sizeBytes: input.sizeBytes,
      fileKind: input.fileKind ?? null,
      documentId: input.documentId ?? null,
      accountId: input.accountId ?? null,
      entityId: input.entityId ?? null,
      templateId: input.templateId ?? null,
      connectionId: input.connectionId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.createdBy ?? 'owner',
    };
    if (!input.idempotencyKey) {
      const [row] = await db.insert(importBatches).values(values).returning();
      return { row: required(row, 'import batch'), created: true };
    }
    const inserted = await db.insert(importBatches).values(values).onConflictDoNothing({ target: importBatches.idempotencyKey }).returning();
    if (inserted[0]) return { row: inserted[0], created: true };
    const [existing] = await db.select().from(importBatches).where(eq(importBatches.idempotencyKey, input.idempotencyKey)).limit(1);
    return { row: required(existing, 'import batch'), created: false };
  });
}

export interface BatchProgressInput {
  status?: ImportBatchStatusValue;
  parser?: string | null;
  parserVersion?: string | null;
  mapping?: Record<string, unknown> | null;
  checks?: Array<{ check: string; passed: boolean; detail: string }>;
  detectedHeaders?: string[];
  sampleRows?: string[][];
  counts?: Partial<ImportCounts>;
  coverageFrom?: string | null;
  coverageTo?: string | null;
  statementCurrency?: string | null;
  statementOpening?: string | null;
  statementClosing?: string | null;
  reconciliation?: Record<string, unknown> | null;
  jobId?: string | null;
  error?: string | null;
  providerHistoryNote?: string | null;
  templateId?: string | null;
}

export async function updateBatch(db: DbOrTx, id: string, patch: BatchProgressInput): Promise<ImportBatchRow> {
  if (patch.statementOpening != null) assertDecimal(patch.statementOpening, 'statementOpening');
  if (patch.statementClosing != null) assertDecimal(patch.statementClosing, 'statementClosing');
  const values = pickDefined(patch);
  if (patch.counts) values.counts = { ...EMPTY_IMPORT_COUNTS, ...patch.counts };
  return mapErrors('update import batch', async () => {
    const [row] = await db.update(importBatches).set(values).where(eq(importBatches.id, id)).returning();
    return required(row, 'import batch');
  });
}

export async function markBatchCommitted(db: DbOrTx, id: string, counts: Partial<ImportCounts>, now = new Date()): Promise<ImportBatchRow> {
  const [row] = await db
    .update(importBatches)
    .set({ status: 'committed', counts: { ...EMPTY_IMPORT_COUNTS, ...counts }, committedAt: now, error: null })
    .where(and(eq(importBatches.id, id), inArray(importBatches.status, ['previewed', 'committing', 'committed'])))
    .returning();
  if (!row) throw new ConflictError(`Import batch ${id} is not in a state that can be committed`);
  return row;
}

/** An import is undone by an auditable reversal, never by deleting rows. */
export async function markBatchReversed(db: DbOrTx, id: string, reason: string, jobId: string | null = null, now = new Date()): Promise<ImportBatchRow> {
  if (!reason.trim()) throw new InvalidError('Reversing an import needs a reason');
  const [row] = await db
    .update(importBatches)
    .set({ status: 'reversed', reversedAt: now, reversalReason: reason, reversalJobId: jobId })
    .where(and(eq(importBatches.id, id), inArray(importBatches.status, ['committed', 'reversing'])))
    .returning();
  if (!row) throw new ConflictError(`Import batch ${id} is not committed, so it cannot be reversed`);
  return row;
}

export async function markBatchFailed(db: DbOrTx, id: string, error: string): Promise<ImportBatchRow> {
  const [row] = await db.update(importBatches).set({ status: 'failed', error: error.slice(0, 2000) }).where(eq(importBatches.id, id)).returning();
  return required(row, 'import batch');
}

export async function getBatch(db: DbOrTx, id: string): Promise<ImportBatchRow | undefined> {
  const [row] = await db.select().from(importBatches).where(eq(importBatches.id, id)).limit(1);
  return row;
}

export async function listBatches(
  db: DbOrTx,
  query: { accountId?: string; status?: ImportBatchStatusValue | ImportBatchStatusValue[]; fileSha256?: string; limit?: number } = {},
): Promise<ImportBatchRow[]> {
  const conditions: SQL[] = [];
  if (query.accountId) conditions.push(eq(importBatches.accountId, query.accountId));
  if (query.status) conditions.push(inArray(importBatches.status, Array.isArray(query.status) ? query.status : [query.status]));
  if (query.fileSha256) conditions.push(eq(importBatches.fileSha256, query.fileSha256));
  return db
    .select()
    .from(importBatches)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(importBatches.createdAt))
    .limit(query.limit ?? 50);
}

// ---------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------

export interface ImportRowInput {
  rowNumber: number;
  status: ImportRowStatus;
  /** The row exactly as the file had it. Never rewritten. */
  raw: Record<string, unknown> | unknown[];
  parsed?: Record<string, unknown> | null;
  bookedOn?: string | null;
  description?: string | null;
  amount?: string | null;
  currency?: string | null;
  balance?: string | null;
  pending?: boolean;
  message?: string | null;
  dedupeKey?: string | null;
  duplicateOfSourceRecordId?: string | null;
  sourceRecordId?: string | null;
}

/** Replaces the rows of a batch (a re-parse produces a fresh set). */
export async function replaceRows(db: DbOrTx, batchId: string, rows: readonly ImportRowInput[]): Promise<number> {
  return mapErrors('write import rows', () =>
    tx(db, async (t) => {
      await t.delete(importRows).where(eq(importRows.batchId, batchId));
      if (rows.length === 0) return 0;
      const inserted = await t
        .insert(importRows)
        .values(
          rows.map((row) => ({
            batchId,
            rowNumber: row.rowNumber,
            status: row.status,
            raw: row.raw,
            parsed: row.parsed ?? null,
            bookedOn: row.bookedOn ?? null,
            description: row.description ?? null,
            amount: row.amount ?? null,
            currency: row.currency ?? null,
            balance: row.balance ?? null,
            pending: row.pending ?? false,
            message: row.message ?? null,
            dedupeKey: row.dedupeKey ?? null,
            duplicateOfSourceRecordId: row.duplicateOfSourceRecordId ?? null,
            sourceRecordId: row.sourceRecordId ?? null,
          })),
        )
        .returning({ id: importRows.id });
      return inserted.length;
    }),
  );
}

/** Links a committed row to the source record it produced. */
export async function linkRow(
  db: DbOrTx,
  batchId: string,
  rowNumber: number,
  input: { sourceRecordId?: string | null; duplicateOfSourceRecordId?: string | null; status?: ImportRowStatus; message?: string | null },
): Promise<ImportRowRow> {
  const [row] = await db
    .update(importRows)
    .set(pickDefined(input))
    .where(and(eq(importRows.batchId, batchId), eq(importRows.rowNumber, rowNumber)))
    .returning();
  return required(row, 'import row');
}

export async function listRows(db: DbOrTx, batchId: string, query: { status?: ImportRowStatus | ImportRowStatus[]; limit?: number } = {}): Promise<ImportRowRow[]> {
  const conditions: SQL[] = [eq(importRows.batchId, batchId)];
  if (query.status) conditions.push(inArray(importRows.status, Array.isArray(query.status) ? query.status : [query.status]));
  return db
    .select()
    .from(importRows)
    .where(and(...conditions))
    .orderBy(asc(importRows.rowNumber))
    .limit(query.limit ?? 5000);
}

export async function countRowsByStatus(db: DbOrTx, batchId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: importRows.status, n: sql<number>`count(*)::int` })
    .from(importRows)
    .where(eq(importRows.batchId, batchId))
    .groupBy(importRows.status);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

// ---------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------

export interface TemplateInput {
  name: string;
  fileKind: ImportFileKind;
  mapping: Record<string, unknown>;
  providerKey?: string | null;
  /** Hash of the header row, so the next file from the same source is recognised. */
  headerFingerprint?: string | null;
  verified?: boolean;
}

export async function saveTemplate(db: DbOrTx, input: TemplateInput): Promise<ImportTemplateRow> {
  return mapErrors('save import template', async () => {
    const values = {
      name: input.name,
      fileKind: input.fileKind,
      mapping: input.mapping,
      providerKey: input.providerKey ?? null,
      headerFingerprint: input.headerFingerprint ?? null,
      verified: input.verified ?? false,
    };
    const [row] = await db
      .insert(importTemplates)
      .values(values)
      .onConflictDoUpdate({ target: importTemplates.name, set: values })
      .returning();
    return required(row, 'import template');
  });
}

export async function findTemplateByFingerprint(db: DbOrTx, headerFingerprint: string): Promise<ImportTemplateRow | undefined> {
  const [row] = await db
    .select()
    .from(importTemplates)
    .where(eq(importTemplates.headerFingerprint, headerFingerprint))
    .orderBy(desc(importTemplates.verified), desc(importTemplates.lastUsedAt))
    .limit(1);
  return row;
}

export async function markTemplateUsed(db: DbOrTx, id: string, now = new Date()): Promise<void> {
  await db.update(importTemplates).set({ lastUsedAt: now }).where(eq(importTemplates.id, id));
}

export async function listTemplates(db: DbOrTx): Promise<ImportTemplateRow[]> {
  return db.select().from(importTemplates).orderBy(asc(importTemplates.name));
}

export async function deleteTemplate(db: DbOrTx, id: string): Promise<boolean> {
  const rows = await db.delete(importTemplates).where(eq(importTemplates.id, id)).returning({ id: importTemplates.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------
// Coverage periods
// ---------------------------------------------------------------------------------------

export interface CoverageInput {
  accountId: string;
  fromDate: string;
  toDate: string;
  source: CoverageSource;
  importBatchId?: string | null;
  connectionId?: string | null;
  complete?: boolean;
  note?: string | null;
}

export async function recordCoverage(db: DbOrTx, input: CoverageInput): Promise<CoveragePeriodRow> {
  if (input.toDate < input.fromDate) throw new InvalidError('A coverage period must end on or after it starts');
  return mapErrors('record coverage period', async () => {
    const [row] = await db
      .insert(coveragePeriods)
      .values({
        accountId: input.accountId,
        fromDate: input.fromDate,
        toDate: input.toDate,
        source: input.source,
        importBatchId: input.importBatchId ?? null,
        connectionId: input.connectionId ?? null,
        complete: input.complete ?? true,
        note: input.note ?? null,
      })
      .returning();
    return required(row, 'coverage period');
  });
}

/** Reversing an import takes its coverage back, so the gap becomes visible again. */
export async function deactivateCoverageForBatch(db: DbOrTx, importBatchId: string): Promise<number> {
  const rows = await db
    .update(coveragePeriods)
    .set({ active: false })
    .where(eq(coveragePeriods.importBatchId, importBatchId))
    .returning({ id: coveragePeriods.id });
  return rows.length;
}

export async function listCoverage(
  db: DbOrTx,
  accountId: string,
  query: { from?: string; to?: string; includeInactive?: boolean } = {},
): Promise<CoveragePeriodRow[]> {
  const conditions: SQL[] = [eq(coveragePeriods.accountId, accountId)];
  if (!query.includeInactive) conditions.push(eq(coveragePeriods.active, true));
  if (query.from) conditions.push(gte(coveragePeriods.toDate, query.from));
  if (query.to) conditions.push(lte(coveragePeriods.fromDate, query.to));
  return db
    .select()
    .from(coveragePeriods)
    .where(and(...conditions))
    .orderBy(asc(coveragePeriods.fromDate));
}

// ---------------------------------------------------------------------------------------
// Reconciliations
// ---------------------------------------------------------------------------------------

export interface ReconciliationInput {
  accountId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  movements: string;
  status: ReconciliationStatus;
  openingBalance?: string | null;
  expectedClosing?: string | null;
  actualClosing?: string | null;
  difference?: string | null;
  batchId?: string | null;
  detail?: Record<string, unknown>;
}

export async function recordReconciliation(db: DbOrTx, input: ReconciliationInput): Promise<ReconciliationRow> {
  assertDecimal(input.movements, 'movements');
  // The database enforces this too; failing early gives a clearer message.
  if (input.status === 'balanced' && (input.difference == null || !/^-?0(\.0+)?$/.test(input.difference))) {
    throw new InvalidError('A balanced reconciliation must have a difference of exactly zero');
  }
  return mapErrors('record reconciliation', async () => {
    const [row] = await db
      .insert(reconciliations)
      .values({
        accountId: input.accountId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        currency: input.currency,
        openingBalance: input.openingBalance ?? null,
        movements: input.movements,
        expectedClosing: input.expectedClosing ?? null,
        actualClosing: input.actualClosing ?? null,
        difference: input.difference ?? null,
        status: input.status,
        batchId: input.batchId ?? null,
        detail: input.detail ?? {},
      })
      .returning();
    return required(row, 'reconciliation');
  });
}

/**
 * Runs the domain statement check and stores the result. Nothing is posted: a discrepancy
 * is reported to the owner, never balanced away.
 */
export async function reconcileStatement(
  db: DbOrTx,
  input: Parameters<typeof checkStatement>[0] & { batchId?: string | null },
): Promise<{ row: ReconciliationRow; result: StatementCheckResult }> {
  const result = checkStatement(input);
  const row = await recordReconciliation(db, {
    accountId: result.accountId,
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    currency: input.currency,
    openingBalance: result.openingBalance?.amount ?? null,
    movements: result.movements.amount,
    expectedClosing: result.expectedClosing?.amount ?? null,
    actualClosing: result.actualClosing?.amount ?? null,
    difference: result.difference?.amount ?? null,
    status: result.status,
    batchId: input.batchId ?? null,
    detail: {
      movementCount: result.movementCount,
      excludedPending: result.excludedPending,
      excludedOutOfPeriod: result.excludedOutOfPeriod,
      excludedOtherCurrency: result.excludedOtherCurrency,
      explanation: result.explanation,
    },
  });
  return { row, result };
}

export async function resolveReconciliation(db: DbOrTx, id: string, resolution: string, now = new Date()): Promise<ReconciliationRow> {
  const [row] = await db.update(reconciliations).set({ resolution, resolvedAt: now }).where(eq(reconciliations.id, id)).returning();
  return required(row, 'reconciliation');
}

export async function listReconciliations(
  db: DbOrTx,
  query: { accountId?: string; status?: ReconciliationStatus | ReconciliationStatus[]; limit?: number } = {},
): Promise<ReconciliationRow[]> {
  const conditions: SQL[] = [];
  if (query.accountId) conditions.push(eq(reconciliations.accountId, query.accountId));
  if (query.status) conditions.push(inArray(reconciliations.status, Array.isArray(query.status) ? query.status : [query.status]));
  return db
    .select()
    .from(reconciliations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reconciliations.periodEnd))
    .limit(query.limit ?? 200);
}
