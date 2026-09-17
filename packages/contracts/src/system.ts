import { z } from 'zod';
import { CurrencyCode, Id, IsoDateTime } from './common';

export const ExceptionKind = z.enum([
  'unclassified',
  'ownership_uncertain',
  'fee_policy_unconfirmed',
  'reconciliation_discrepancy',
  'reconciliation_question',
  'missing_period',
  'possible_duplicate',
  'transfer_match_review',
  'stale_connection',
  'sync_error',
  'valuation_unverified',
  'restriction_unverified',
  'interest_unverified',
  'missing_information',
  'tax_fact_unconfirmed',
  'fx_rate_missing',
  'import_error',
  'unusual_transaction',
  'agent_suggestion',
]);
export type ExceptionKind = z.infer<typeof ExceptionKind>;

export const ExceptionItem = z.object({
  id: Id,
  kind: ExceptionKind,
  severity: z.enum(['info', 'warning', 'critical']),
  status: z.enum(['open', 'resolved', 'dismissed', 'snoozed']),
  title: z.string(),
  detail: z.string(),
  subject: z.object({ type: z.string(), id: z.string().nullable(), label: z.string().nullable() }),
  entityId: Id.nullable(),
  suggestedActions: z.array(z.object({ id: z.string(), label: z.string(), href: z.string().nullable() })),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  snoozedUntil: IsoDateTime.nullable(),
  resolution: z.string().nullable(),
});
export type ExceptionItem = z.infer<typeof ExceptionItem>;

export const ExceptionResolveInput = z.object({
  action: z.enum(['resolve', 'dismiss', 'snooze', 'reopen']),
  note: z.string().max(1000).nullable(),
  snoozeDays: z.number().int().min(1).max(90).optional(),
});
export type ExceptionResolveInput = z.infer<typeof ExceptionResolveInput>;

export const JobRecord = z.object({
  id: Id,
  queue: z.string(),
  label: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'cancelling', 'dead_letter', 'retrying']),
  progress: z.number().min(0).max(1).nullable(),
  progressLabel: z.string().nullable(),
  attempts: z.number().int(),
  cancellable: z.boolean(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  error: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
});
export type JobRecord = z.infer<typeof JobRecord>;

export const Notification = z.object({
  id: Id,
  kind: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string(),
  body: z.string(),
  why: z.string(),
  href: z.string().nullable(),
  createdAt: IsoDateTime,
  readAt: IsoDateTime.nullable(),
});
export type Notification = z.infer<typeof Notification>;

export const Schedule = z.object({
  id: Id,
  key: z.string(),
  label: z.string(),
  description: z.string(),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  lastRunAt: IsoDateTime.nullable(),
  lastStatus: z.string().nullable(),
  nextRunAt: IsoDateTime.nullable(),
});
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleUpdateInput = z.object({
  cron: z.string().max(100),
  timezone: z.string().max(64),
  enabled: z.boolean(),
});
export type ScheduleUpdateInput = z.infer<typeof ScheduleUpdateInput>;

export const AppSettings = z.object({
  reportingCurrency: CurrencyCode,
  budgetCurrency: CurrencyCode,
  reportingTimezone: z.string(),
  safeToSpendHorizonDays: z.number().int().min(7).max(120),
  safeToSpendHorizonBasis: z.enum(['fixed_days', 'next_income']),
  includeNearCashInSafeToSpend: z.boolean(),
  runwayMinimumHistoryMonths: z.number().int().min(1).max(24),
  staleAfterHours: z.number().int().min(1).max(24 * 30),
  idleTimeoutSeconds: z.number().int().min(60).max(600),
  privacyModeDefault: z.boolean(),
  quietHours: z.object({ enabled: z.boolean(), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }),
  weekStartsOn: z.enum(['monday', 'sunday']),
  cloudAiAllowed: z.boolean(),
  publicMarketDataEnabled: z.boolean(),
});
export type AppSettings = z.infer<typeof AppSettings>;

export const HealthStatus = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  checks: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'degraded', 'down']), detail: z.string() })),
});
export type HealthStatus = z.infer<typeof HealthStatus>;

export const BackupRecord = z.object({
  id: Id,
  status: z.enum(['running', 'succeeded', 'failed']),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().nullable(),
  keyVersion: z.string().nullable(),
  destination: z.enum(['local', 'offhost']),
  includes: z.array(z.string()),
  restoreVerifiedAt: IsoDateTime.nullable(),
  restoreVerification: z.string().nullable(),
  error: z.string().nullable(),
});
export type BackupRecord = z.infer<typeof BackupRecord>;

export const SystemStatus = z.object({
  version: z.string(),
  environment: z.enum(['production', 'test', 'development']),
  canonicalOrigin: z.string(),
  allowedOrigins: z.array(z.string()),
  route: z.object({
    kind: z.enum(['tailscale_serve', 'custom_domain', 'loopback_only']),
    status: z.enum(['active', 'pending_owner_activation', 'unverified', 'error']),
    detail: z.string(),
    ownerSteps: z.array(z.string()),
  }),
  tls: z.object({ terminatedBy: z.string(), verified: z.boolean(), detail: z.string() }),
  oauthCallbackUrls: z.array(z.string()),
  extensionOrigins: z.array(z.string()),
  database: z.object({ status: z.enum(['ok', 'down']), sizeBytes: z.number().int().nullable(), migrations: z.string() }),
  worker: z.object({ status: z.enum(['ok', 'stale', 'down']), lastHeartbeatAt: IsoDateTime.nullable() }),
  jobs: z.object({ queued: z.number().int(), running: z.number().int(), failed24h: z.number().int(), deadLetter: z.number().int() }),
  disk: z.object({ freeBytes: z.number().int().nullable(), totalBytes: z.number().int().nullable(), warning: z.boolean() }),
  backups: z.object({
    last: BackupRecord.nullable(),
    offhost: z.object({ configured: z.boolean(), detail: z.string() }),
    encryption: z.string(),
  }),
  encryptionAtRest: z.object({ secrets: z.string(), documents: z.string(), database: z.string(), hostDisk: z.string() }),
  recentErrors: z.array(z.object({ at: IsoDateTime, source: z.string(), message: z.string() })),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

export const DomainMigrationPlan = z.object({
  currentOrigin: z.string(),
  proposedOrigin: z.string(),
  checks: z.array(z.object({ id: z.string(), label: z.string(), status: z.enum(['pass', 'fail', 'todo', 'warning']), detail: z.string() })),
  consequences: z.array(z.string()),
});
export type DomainMigrationPlan = z.infer<typeof DomainMigrationPlan>;

export const DomainMigrationInput = z.object({
  proposedOrigin: z.string().url().max(200),
});
export type DomainMigrationInput = z.infer<typeof DomainMigrationInput>;

export const AuditEvent = z.object({
  id: z.string(),
  occurredAt: IsoDateTime,
  actorType: z.enum(['owner', 'system', 'worker', 'agent', 'device', 'anonymous']),
  actorId: z.string().nullable(),
  action: z.string(),
  objectType: z.string().nullable(),
  objectId: z.string().nullable(),
  summary: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const SearchResult = z.object({
  items: z.array(
    z.object({
      kind: z.enum(['account', 'transaction', 'entity', 'goal', 'connection', 'page', 'exception', 'document']),
      id: z.string(),
      title: z.string(),
      subtitle: z.string().nullable(),
      href: z.string(),
    }),
  ),
});
export type SearchResult = z.infer<typeof SearchResult>;

export const DocumentRecord = z.object({
  id: Id,
  fileName: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  kind: z.enum(['statement', 'agreement', 'valuation', 'tax', 'invoice', 'other']),
  accountId: Id.nullable(),
  entityId: Id.nullable(),
  uploadedAt: IsoDateTime,
  encrypted: z.literal(true),
  note: z.string().nullable(),
});
export type DocumentRecord = z.infer<typeof DocumentRecord>;

export const TaxFact = z.object({
  id: Id,
  jurisdiction: z.string(),
  topic: z.enum(['residency', 'filing_status', 'deadline', 'registration', 'third_party_funds', 'document', 'other']),
  status: z.enum(['unconfirmed', 'confirmed', 'needs_accountant']),
  value: z.string().nullable(),
  deadline: z.string().nullable(),
  accountantQuestion: z.string().nullable(),
  documentIds: z.array(Id),
  updatedAt: IsoDateTime,
});
export type TaxFact = z.infer<typeof TaxFact>;

export const TaxFactInput = TaxFact.omit({ id: true, updatedAt: true });
export type TaxFactInput = z.infer<typeof TaxFactInput>;
