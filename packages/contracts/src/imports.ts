import { z } from 'zod';
import { CurrencyCode, DecimalString, Id, IsoDate, IsoDateTime, Money } from './common';

export const ImportFileKind = z.enum(['csv', 'xlsx', 'ofx', 'qfx', 'ibkr_flex_xml', 'ibkr_flex_csv', 'pdf']);
export type ImportFileKind = z.infer<typeof ImportFileKind>;

export const ImportLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxRows: 200_000,
  maxPdfPages: 300,
  allowedMime: [
    'text/csv',
    'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/x-ofx',
    'application/ofx',
    'application/vnd.intu.qfx',
    'application/xml',
    'text/xml',
    'application/pdf',
    'application/octet-stream',
  ],
} as const;

export const DateFormat = z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD', 'D MMM YYYY', 'MMM D, YYYY', 'YYYYMMDD', 'excel_serial', 'iso_datetime']);
export type DateFormat = z.infer<typeof DateFormat>;

export const AmountMode = z.enum([
  /** One signed amount column. `negativeIsDebit` decides the sign convention. */
  'signed',
  /** Separate debit and credit columns. */
  'debit_credit',
  /** Amount column plus a direction column (e.g. "DR"/"CR"). */
  'amount_direction',
]);
export type AmountMode = z.infer<typeof AmountMode>;

export const ColumnMapping = z.object({
  hasHeader: z.boolean(),
  skipRows: z.number().int().min(0).max(200),
  delimiter: z.enum([',', ';', '\t', '|']).nullable(),
  sheetName: z.string().max(100).nullable(),
  dateColumn: z.string().max(100),
  valueDateColumn: z.string().max(100).nullable(),
  dateFormat: DateFormat,
  descriptionColumns: z.array(z.string().max(100)).min(1).max(4),
  counterpartyColumn: z.string().max(100).nullable(),
  referenceColumn: z.string().max(100).nullable(),
  balanceColumn: z.string().max(100).nullable(),
  currencyColumn: z.string().max(100).nullable(),
  statusColumn: z.string().max(100).nullable(),
  categoryColumn: z.string().max(100).nullable(),
  amountMode: AmountMode,
  amountColumn: z.string().max(100).nullable(),
  debitColumn: z.string().max(100).nullable(),
  creditColumn: z.string().max(100).nullable(),
  directionColumn: z.string().max(100).nullable(),
  debitMarkers: z.array(z.string().max(20)).max(10),
  negativeIsDebit: z.boolean(),
  decimalSeparator: z.enum(['.', ',']),
  thousandsSeparator: z.enum([',', '.', ' ', "'", '']),
  defaultCurrency: CurrencyCode,
  sourceTimezone: z.string().max(64),
});
export type ColumnMapping = z.infer<typeof ColumnMapping>;

export const ImportTemplate = z.object({
  id: Id,
  name: z.string(),
  providerKey: z.string().nullable(),
  fileKind: ImportFileKind,
  mapping: ColumnMapping,
  headerFingerprint: z.string().nullable(),
  verified: z.boolean(),
  lastUsedAt: IsoDateTime.nullable(),
});
export type ImportTemplate = z.infer<typeof ImportTemplate>;

export const ImportBatchStatus = z.enum([
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
]);
export type ImportBatchStatus = z.infer<typeof ImportBatchStatus>;

export const FileCheck = z.object({
  check: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type FileCheck = z.infer<typeof FileCheck>;

export const ImportRowStatus = z.enum(['new', 'duplicate', 'possible_duplicate', 'pending_to_posted', 'changed_upstream', 'error', 'skipped']);
export type ImportRowStatus = z.infer<typeof ImportRowStatus>;

export const PreviewRow = z.object({
  rowNumber: z.number().int(),
  status: ImportRowStatus,
  bookedOn: IsoDate.nullable(),
  description: z.string().nullable(),
  amount: Money.nullable(),
  balance: Money.nullable(),
  pending: z.boolean(),
  message: z.string().nullable(),
  duplicateOf: Id.nullable(),
});
export type PreviewRow = z.infer<typeof PreviewRow>;

export const ImportBatch = z.object({
  id: Id,
  status: ImportBatchStatus,
  fileName: z.string(),
  fileKind: ImportFileKind.nullable(),
  fileSha256: z.string(),
  sizeBytes: z.number().int(),
  accountId: Id.nullable(),
  entityId: Id.nullable(),
  templateId: Id.nullable(),
  parser: z.string().nullable(),
  parserVersion: z.string().nullable(),
  checks: z.array(FileCheck),
  detectedHeaders: z.array(z.string()),
  sampleRows: z.array(z.array(z.string())),
  counts: z.object({
    total: z.number().int(),
    new: z.number().int(),
    duplicate: z.number().int(),
    possibleDuplicate: z.number().int(),
    pendingToPosted: z.number().int(),
    changedUpstream: z.number().int(),
    error: z.number().int(),
    skipped: z.number().int(),
    imported: z.number().int(),
  }),
  coverage: z.object({ from: IsoDate.nullable(), to: IsoDate.nullable() }),
  statementBalances: z.object({ opening: Money.nullable(), closing: Money.nullable() }),
  reconciliation: z
    .object({
      status: z.enum(['balanced', 'discrepancy', 'incomplete', 'not_applicable']),
      expectedClosing: Money.nullable(),
      difference: Money.nullable(),
      detail: z.string(),
    })
    .nullable(),
  jobId: Id.nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateTime,
  committedAt: IsoDateTime.nullable(),
  reversedAt: IsoDateTime.nullable(),
  reversalReason: z.string().nullable(),
  providerHistoryNote: z.string().nullable(),
});
export type ImportBatch = z.infer<typeof ImportBatch>;

export const ImportConfigureInput = z.object({
  accountId: Id,
  templateId: Id.nullable(),
  mapping: ColumnMapping.nullable(),
  fileKind: ImportFileKind,
  saveTemplateAs: z.string().max(80).nullable(),
  statementOpening: DecimalString.nullable(),
  statementClosing: DecimalString.nullable(),
});
export type ImportConfigureInput = z.infer<typeof ImportConfigureInput>;

export const ImportCommitInput = z.object({
  /** Rows the owner explicitly chose to import despite being flagged as possible duplicates. */
  includePossibleDuplicates: z.array(z.number().int()).max(10_000),
  idempotencyKey: z.string().min(16).max(100),
});
export type ImportCommitInput = z.infer<typeof ImportCommitInput>;

export const ImportReverseInput = z.object({
  reason: z.string().min(3).max(500),
});
export type ImportReverseInput = z.infer<typeof ImportReverseInput>;
