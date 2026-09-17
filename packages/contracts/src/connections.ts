import { z } from 'zod';
import { Id, IsoDate, IsoDateTime } from './common';

export const ConnectionStatus = z.enum([
  'not_configured',
  'needs_authorization',
  'connected',
  'syncing',
  'partial_coverage',
  'import_only',
  'stale',
  'rate_limited',
  'error',
  'paused',
  'revoked',
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const VerificationLevel = z.enum([
  /** Code exists and passes synthetic contract tests. */
  'implemented',
  /** Exercised against a provider sandbox. */
  'sandbox_verified',
  /** Exercised against the owner's real account in this deployment. */
  'live_verified',
]);
export type VerificationLevel = z.infer<typeof VerificationLevel>;

export const ProviderCategory = z.enum(['bank', 'broker', 'wallet', 'document', 'api', 'mcp', 'ai', 'notification', 'email', 'accounting']);
export type ProviderCategory = z.infer<typeof ProviderCategory>;

export const AuthMethod = z.enum([
  'api_token',
  'oauth',
  'mcp_oauth',
  'flex_web_service',
  'watch_only_address',
  'file_import',
  'manual_entry',
  'custom_http',
  'imap',
  'openai_compatible',
  'none',
]);
export type AuthMethod = z.infer<typeof AuthMethod>;

export const CredentialField = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['secret', 'text', 'url', 'select', 'number', 'boolean', 'textarea']),
  required: z.boolean(),
  help: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  pattern: z.string().optional(),
});
export type CredentialField = z.infer<typeof CredentialField>;

export const CapabilityFlag = z.object({
  supported: z.boolean(),
  note: z.string().nullable(),
});
export type CapabilityFlag = z.infer<typeof CapabilityFlag>;

export const ProviderMethod = z.object({
  method: AuthMethod,
  label: z.string(),
  description: z.string(),
  readOnly: z.literal(true),
  fields: z.array(CredentialField),
  /** Exact owner steps outside FinancialOS required before this method can work. */
  ownerActivationSteps: z.array(z.string()),
  capabilities: z.object({
    balances: CapabilityFlag,
    transactions: CapabilityFlag,
    pendingTransactions: CapabilityFlag,
    holdings: CapabilityFlag,
    investmentTransactions: CapabilityFlag,
    cards: CapabilityFlag,
    statements: CapabilityFlag,
    agentContext: CapabilityFlag,
  }),
  historyLimit: z.object({
    documentedDays: z.number().int().nullable(),
    verifiedDays: z.number().int().nullable(),
    note: z.string(),
  }),
  fileKinds: z.array(z.string()),
  verificationLevel: VerificationLevel,
  documentationUrls: z.array(z.string()),
  unsupportedProducts: z.array(z.string()),
  scheduleSupported: z.boolean(),
});
export type ProviderMethod = z.infer<typeof ProviderMethod>;

export const ProviderDescriptor = z.object({
  key: z.string(),
  name: z.string(),
  category: ProviderCategory,
  regions: z.array(z.string()),
  summary: z.string(),
  methods: z.array(ProviderMethod),
  capabilityNotes: z.string(),
  checkedOn: IsoDate,
});
export type ProviderDescriptor = z.infer<typeof ProviderDescriptor>;

export const ConnectionAccountLink = z.object({
  externalAccountId: z.string(),
  externalName: z.string(),
  externalMask: z.string().nullable(),
  currency: z.string().nullable(),
  accountId: Id.nullable(),
  excluded: z.boolean(),
});
export type ConnectionAccountLink = z.infer<typeof ConnectionAccountLink>;

export const SyncRun = z.object({
  id: Id,
  kind: z.enum(['test', 'sync', 'backfill', 'import']),
  status: z.enum(['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled']),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  counts: z.record(z.string(), z.number()),
  error: z.string().nullable(),
  jobId: Id.nullable(),
});
export type SyncRun = z.infer<typeof SyncRun>;

export const Connection = z.object({
  id: Id,
  providerKey: z.string(),
  providerName: z.string(),
  method: AuthMethod,
  name: z.string(),
  entityId: Id.nullable(),
  status: ConnectionStatus,
  statusDetail: z.string(),
  nextOwnerStep: z.string().nullable(),
  verificationLevel: VerificationLevel,
  hasCredential: z.boolean(),
  credentialUpdatedAt: IsoDateTime.nullable(),
  /** Non-secret configuration only. Secrets are never returned. */
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  grantedScopes: z.array(z.string()),
  lastSuccessAt: IsoDateTime.nullable(),
  lastAttemptAt: IsoDateTime.nullable(),
  lastError: z.string().nullable(),
  coverage: z.object({ from: IsoDate.nullable(), to: IsoDate.nullable(), note: z.string().nullable() }),
  schedule: z.object({ enabled: z.boolean(), cron: z.string().nullable(), timezone: z.string() }),
  paused: z.boolean(),
  accounts: z.array(ConnectionAccountLink),
  recentRuns: z.array(SyncRun),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Connection = z.infer<typeof Connection>;

export const ConnectionCreateInput = z.object({
  providerKey: z.string().max(64),
  method: AuthMethod,
  name: z.string().min(1).max(80),
  entityId: Id.nullable(),
  config: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])),
});
export type ConnectionCreateInput = z.infer<typeof ConnectionCreateInput>;

export const CredentialInput = z.object({
  /** Values for fields whose kind is 'secret'. Write-only. */
  secrets: z.record(z.string(), z.string().min(1).max(8192)),
});
export type CredentialInput = z.infer<typeof CredentialInput>;

export const ConnectionUpdateInput = z.object({
  name: z.string().min(1).max(80).optional(),
  entityId: Id.nullable().optional(),
  config: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
  schedule: z.object({ enabled: z.boolean(), cron: z.string().max(100).nullable() }).optional(),
  paused: z.boolean().optional(),
});
export type ConnectionUpdateInput = z.infer<typeof ConnectionUpdateInput>;

export const AccountMappingInput = z.object({
  links: z
    .array(z.object({ externalAccountId: z.string().max(200), accountId: Id.nullable(), excluded: z.boolean() }))
    .max(200),
});
export type AccountMappingInput = z.infer<typeof AccountMappingInput>;

export const BackfillInput = z.object({
  from: IsoDate,
  to: IsoDate.nullable(),
});
export type BackfillInput = z.infer<typeof BackfillInput>;

export const OAuthStartResult = z.object({
  authorizationUrl: z.string().url(),
  expiresAt: IsoDateTime,
});
export type OAuthStartResult = z.infer<typeof OAuthStartResult>;

export const OutboundAllowlistEntry = z.object({
  id: Id,
  scheme: z.enum(['https', 'http']),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  purpose: z.string(),
  createdAt: IsoDateTime,
});
export type OutboundAllowlistEntry = z.infer<typeof OutboundAllowlistEntry>;

export const OutboundAllowlistInput = OutboundAllowlistEntry.omit({ id: true, createdAt: true });
export type OutboundAllowlistInput = z.infer<typeof OutboundAllowlistInput>;

/** Custom HTTP source definition: declarative only, never executable. */
export const CustomHttpSourceConfig = z.object({
  baseUrl: z.string().url(),
  path: z.string().max(500),
  authHeaderName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullable(),
  authScheme: z.enum(['bearer', 'raw', 'none']),
  extraHeaders: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(500)).default({}),
  pagination: z.object({
    kind: z.enum(['none', 'cursor', 'page', 'offset']),
    cursorParam: z.string().max(64).nullable(),
    cursorPath: z.string().max(200).nullable(),
    pageParam: z.string().max(64).nullable(),
    limitParam: z.string().max(64).nullable(),
    pageSize: z.number().int().min(1).max(1000).nullable(),
    maxPages: z.number().int().min(1).max(500),
  }),
  recordsPath: z.string().max(200),
  fieldMap: z.object({
    id: z.string().max(200),
    date: z.string().max(200),
    amount: z.string().max(200),
    currency: z.string().max(200).nullable(),
    description: z.string().max(200),
    status: z.string().max(200).nullable(),
  }),
});
export type CustomHttpSourceConfig = z.infer<typeof CustomHttpSourceConfig>;
