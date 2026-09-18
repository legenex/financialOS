import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, isoDate, jsonObject, money, pk, tstz, updatedAt } from './_columns';
import { accounts } from './accounts';
import { connections } from './connections';
import { entities } from './org';
import { sourceRecords } from './sources';

export const DOCUMENT_KINDS = ['statement', 'agreement', 'valuation', 'tax', 'invoice', 'other'] as const;

/**
 * Encrypted evidence files. The blob lives in storage under `storage_key`, encrypted with a
 * per-document data key that is itself wrapped (`wrapped_dek`) by the keyring version
 * `key_version`.
 */
export const documents = pgTable(
  'documents',
  {
    id: pk(),
    fileName: text('file_name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull().unique('documents_sha256_key'),
    storageKey: text('storage_key').notNull().unique('documents_storage_key_key'),
    wrappedDek: text('wrapped_dek').notNull(),
    keyVersion: text('key_version').notNull(),
    encrypted: boolean('encrypted').notNull().default(true),
    kind: text('kind').$type<(typeof DOCUMENT_KINDS)[number]>().notNull().default('other'),
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id),
    entityId: uuid('entity_id').references(() => entities.id),
    source: text('source').notNull().default('upload'),
    note: text('note'),
    uploadedAt: tstz('uploaded_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    check('documents_kind_check', inList('kind', DOCUMENT_KINDS)),
    check('documents_sha256_check', sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check('documents_size_check', sql`size_bytes >= 0`),
    index('documents_account_idx').on(t.accountId),
  ],
);

export const IMPORT_FILE_KINDS = ['csv', 'xlsx', 'ofx', 'qfx', 'ibkr_flex_xml', 'ibkr_flex_csv', 'pdf'] as const;
export const IMPORT_BATCH_STATUSES = [
  'uploaded',
  'parsing',
  'needs_mapping',
  'previewed',
  'committing',
  'committed',
  'reversing',
  'reversed',
  'failed',
  'cancelled',
] as const;
export type ImportBatchStatusValue = (typeof IMPORT_BATCH_STATUSES)[number];

export interface ImportCounts {
  total: number;
  new: number;
  duplicate: number;
  possibleDuplicate: number;
  pendingToPosted: number;
  changedUpstream: number;
  error: number;
  skipped: number;
  imported: number;
}

export const EMPTY_IMPORT_COUNTS: ImportCounts = {
  total: 0,
  new: 0,
  duplicate: 0,
  possibleDuplicate: 0,
  pendingToPosted: 0,
  changedUpstream: 0,
  error: 0,
  skipped: 0,
  imported: 0,
};

export const importTemplates = pgTable(
  'import_templates',
  {
    id: pk(),
    name: text('name').notNull().unique('import_templates_name_key'),
    providerKey: text('provider_key'),
    fileKind: text('file_kind').$type<(typeof IMPORT_FILE_KINDS)[number]>().notNull(),
    mapping: jsonb('mapping').$type<Record<string, unknown>>().notNull(),
    headerFingerprint: text('header_fingerprint'),
    verified: boolean('verified').notNull().default(false),
    lastUsedAt: tstz('last_used_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('import_templates_file_kind_check', inList('file_kind', IMPORT_FILE_KINDS)),
    index('import_templates_fingerprint_idx').on(t.headerFingerprint),
  ],
);

export const importBatches = pgTable(
  'import_batches',
  {
    id: pk(),
    status: text('status').$type<ImportBatchStatusValue>().notNull().default('uploaded'),
    fileName: text('file_name').notNull(),
    fileKind: text('file_kind').$type<(typeof IMPORT_FILE_KINDS)[number]>(),
    fileSha256: text('file_sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    documentId: uuid('document_id').references(() => documents.id),
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id),
    entityId: uuid('entity_id').references(() => entities.id),
    templateId: uuid('template_id').references(() => importTemplates.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id').references((): AnyPgColumn => connections.id),
    parser: text('parser'),
    parserVersion: text('parser_version'),
    mapping: jsonb('mapping').$type<Record<string, unknown>>(),
    checks: jsonb('checks').$type<Array<{ check: string; passed: boolean; detail: string }>>().notNull().default(sql`'[]'::jsonb`),
    detectedHeaders: jsonb('detected_headers').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    sampleRows: jsonb('sample_rows').$type<string[][]>().notNull().default(sql`'[]'::jsonb`),
    counts: jsonb('counts')
      .$type<ImportCounts>()
      .notNull()
      .default(sql`'{"total":0,"new":0,"duplicate":0,"possibleDuplicate":0,"pendingToPosted":0,"changedUpstream":0,"error":0,"skipped":0,"imported":0}'::jsonb`),
    coverageFrom: isoDate('coverage_from'),
    coverageTo: isoDate('coverage_to'),
    statementCurrency: text('statement_currency'),
    statementOpening: money('statement_opening'),
    statementClosing: money('statement_closing'),
    reconciliation: jsonb('reconciliation').$type<Record<string, unknown>>(),
    idempotencyKey: text('idempotency_key').unique('import_batches_idempotency_key_key'),
    commitIdempotencyKey: text('commit_idempotency_key').unique('import_batches_commit_idempotency_key_key'),
    jobId: uuid('job_id'),
    error: text('error'),
    providerHistoryNote: text('provider_history_note'),
    createdBy: text('created_by').notNull().default('owner'),
    committedAt: tstz('committed_at'),
    reversedAt: tstz('reversed_at'),
    reversalReason: text('reversal_reason'),
    reversalJobId: uuid('reversal_job_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('import_batches_status_check', inList('status', IMPORT_BATCH_STATUSES)),
    check('import_batches_file_kind_check', sql`file_kind IS NULL OR ${inList('file_kind', IMPORT_FILE_KINDS)}`),
    check('import_batches_reversal_check', sql`status <> 'reversed' OR (reversed_at IS NOT NULL AND reversal_reason IS NOT NULL)`),
    index('import_batches_sha_idx').on(t.fileSha256),
    index('import_batches_account_idx').on(t.accountId),
  ],
);

export const IMPORT_ROW_STATUSES = [
  'new',
  'duplicate',
  'possible_duplicate',
  'pending_to_posted',
  'changed_upstream',
  'error',
  'skipped',
] as const;

export const importRows = pgTable(
  'import_rows',
  {
    id: pk(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id),
    rowNumber: integer('row_number').notNull(),
    status: text('status').$type<(typeof IMPORT_ROW_STATUSES)[number]>().notNull(),
    raw: jsonb('raw').$type<Record<string, unknown> | unknown[]>().notNull(),
    parsed: jsonb('parsed').$type<Record<string, unknown>>(),
    bookedOn: isoDate('booked_on'),
    description: text('description'),
    amount: money('amount'),
    currency: text('currency'),
    balance: money('balance'),
    pending: boolean('pending').notNull().default(false),
    message: text('message'),
    dedupeKey: text('dedupe_key'),
    duplicateOfSourceRecordId: uuid('duplicate_of_source_record_id').references((): AnyPgColumn => sourceRecords.id),
    sourceRecordId: uuid('source_record_id').references((): AnyPgColumn => sourceRecords.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('import_rows_batch_row_key').on(t.batchId, t.rowNumber),
    check('import_rows_status_check', inList('status', IMPORT_ROW_STATUSES)),
    index('import_rows_batch_status_idx').on(t.batchId, t.status),
  ],
);

export const COVERAGE_SOURCES = ['import', 'provider_api', 'manual', 'statement', 'bootstrap'] as const;

export const coveragePeriods = pgTable(
  'coverage_periods',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .references((): AnyPgColumn => accounts.id),
    fromDate: isoDate('from_date').notNull(),
    toDate: isoDate('to_date').notNull(),
    source: text('source').$type<(typeof COVERAGE_SOURCES)[number]>().notNull(),
    importBatchId: uuid('import_batch_id').references(() => importBatches.id),
    connectionId: uuid('connection_id').references((): AnyPgColumn => connections.id),
    complete: boolean('complete').notNull().default(true),
    active: boolean('active').notNull().default(true),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    check('coverage_periods_range_check', sql`to_date >= from_date`),
    check('coverage_periods_source_check', inList('source', COVERAGE_SOURCES)),
    index('coverage_periods_account_idx').on(t.accountId, t.fromDate),
  ],
);

export const RECONCILIATION_STATUSES = ['balanced', 'discrepancy', 'incomplete'] as const;

export const reconciliations = pgTable(
  'reconciliations',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .references((): AnyPgColumn => accounts.id),
    periodStart: isoDate('period_start').notNull(),
    periodEnd: isoDate('period_end').notNull(),
    currency: text('currency').notNull(),
    openingBalance: money('opening_balance'),
    movements: money('movements').notNull(),
    expectedClosing: money('expected_closing'),
    actualClosing: money('actual_closing'),
    difference: money('difference'),
    status: text('status').$type<(typeof RECONCILIATION_STATUSES)[number]>().notNull(),
    batchId: uuid('batch_id').references(() => importBatches.id),
    detail: jsonObject('detail'),
    resolvedAt: tstz('resolved_at'),
    resolution: text('resolution'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('reconciliations_range_check', sql`period_end >= period_start`),
    check('reconciliations_status_check', inList('status', RECONCILIATION_STATUSES)),
    check(
      'reconciliations_balanced_check',
      sql`status <> 'balanced' OR (difference IS NOT NULL AND difference = 0)`,
    ),
    index('reconciliations_account_idx').on(t.accountId, t.periodEnd),
  ],
);
