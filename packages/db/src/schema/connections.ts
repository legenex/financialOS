import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, isoDate, jsonObject, pk, tstz, updatedAt } from './_columns';
import { aiProviders } from './ai';
import { accounts } from './accounts';
import { entities } from './org';

export const CONNECTION_STATUSES = [
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
] as const;
export type ConnectionStatusValue = (typeof CONNECTION_STATUSES)[number];

export const VERIFICATION_LEVELS = ['implemented', 'sandbox_verified', 'live_verified'] as const;

export type ConnectionConfigValue = string | number | boolean | null;

/** Provider connections. Configuration here is non-secret; secrets live in connection_secrets. */
export const connections = pgTable(
  'connections',
  {
    id: pk(),
    providerKey: text('provider_key').notNull(),
    method: text('method').notNull(),
    name: text('name').notNull(),
    entityId: uuid('entity_id').references(() => entities.id),
    status: text('status').$type<ConnectionStatusValue>().notNull().default('not_configured'),
    statusDetail: text('status_detail').notNull().default(''),
    nextOwnerStep: text('next_owner_step'),
    verificationLevel: text('verification_level')
      .$type<(typeof VERIFICATION_LEVELS)[number]>()
      .notNull()
      .default('implemented'),
    config: jsonb('config').$type<Record<string, ConnectionConfigValue>>().notNull().default(sql`'{}'::jsonb`),
    grantedScopes: text('granted_scopes').array().notNull().default(sql`'{}'::text[]`),
    lastSuccessAt: tstz('last_success_at'),
    lastAttemptAt: tstz('last_attempt_at'),
    lastError: text('last_error'),
    coverageFrom: isoDate('coverage_from'),
    coverageTo: isoDate('coverage_to'),
    coverageNote: text('coverage_note'),
    scheduleEnabled: boolean('schedule_enabled').notNull().default(false),
    scheduleCron: text('schedule_cron'),
    scheduleTimezone: text('schedule_timezone').notNull().default('UTC'),
    paused: boolean('paused').notNull().default(false),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('connections_status_check', inList('status', CONNECTION_STATUSES)),
    check('connections_verification_level_check', inList('verification_level', VERIFICATION_LEVELS)),
    index('connections_provider_idx').on(t.providerKey),
  ],
);

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: pk(),
    providerKey: text('provider_key').notNull(),
    clientId: text('client_id').notNull(),
    issuer: text('issuer'),
    authorizationEndpoint: text('authorization_endpoint').notNull(),
    tokenEndpoint: text('token_endpoint').notNull(),
    revocationEndpoint: text('revocation_endpoint'),
    redirectUri: text('redirect_uri').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    /** Non-secret registration metadata. The client secret, if any, is in connection_secrets. */
    registration: jsonObject('registration'),
    dynamic: boolean('dynamic').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('oauth_clients_provider_client_key').on(t.providerKey, t.clientId)],
);

/**
 * Encrypted secrets. Exactly one owner reference is set. Repository reads never select
 * `ciphertext` except through `getConnectionSecretCiphertext`.
 */
export const connectionSecrets = pgTable(
  'connection_secrets',
  {
    id: pk(),
    connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'cascade' }),
    aiProviderId: uuid('ai_provider_id').references((): AnyPgColumn => aiProviders.id, { onDelete: 'cascade' }),
    oauthClientId: uuid('oauth_client_id').references(() => oauthClients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ciphertext: text('ciphertext').notNull(),
    keyVersion: text('key_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('connection_secrets_single_owner_check', sql`num_nonnulls(connection_id, ai_provider_id, oauth_client_id) = 1`),
    uniqueIndex('connection_secrets_connection_name_key').on(t.connectionId, t.name).where(sql`connection_id IS NOT NULL`),
    uniqueIndex('connection_secrets_ai_provider_name_key').on(t.aiProviderId, t.name).where(sql`ai_provider_id IS NOT NULL`),
    uniqueIndex('connection_secrets_oauth_client_name_key').on(t.oauthClientId, t.name).where(sql`oauth_client_id IS NOT NULL`),
    index('connection_secrets_key_version_idx').on(t.keyVersion),
  ],
);

export const connectionAccounts = pgTable(
  'connection_accounts',
  {
    id: pk(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    externalAccountId: text('external_account_id').notNull(),
    externalName: text('external_name').notNull(),
    externalMask: text('external_mask'),
    currency: text('currency'),
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id, { onDelete: 'set null' }),
    excluded: boolean('excluded').notNull().default(false),
    metadata: jsonObject('metadata'),
    discoveredAt: tstz('discovered_at').notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('connection_accounts_external_key').on(t.connectionId, t.externalAccountId),
    check(
      'connection_accounts_mask_check',
      sql`external_mask IS NULL OR length(regexp_replace(external_mask, '[^0-9]', '', 'g')) <= 4`,
    ),
  ],
);

export const oauthStates = pgTable(
  'oauth_states',
  {
    id: pk(),
    stateHash: text('state_hash').notNull().unique('oauth_states_state_hash_key'),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    oauthClientId: uuid('oauth_client_id').references(() => oauthClients.id, { onDelete: 'cascade' }),
    codeVerifierCiphertext: text('code_verifier_ciphertext').notNull(),
    keyVersion: text('key_version').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    nonceHash: text('nonce_hash'),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
  },
  (t) => [index('oauth_states_expires_idx').on(t.expiresAt)],
);

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: pk(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    oauthClientId: uuid('oauth_client_id').references(() => oauthClients.id, { onDelete: 'cascade' }),
    tokenType: text('token_type').notNull().default('bearer'),
    accessTokenCiphertext: text('access_token_ciphertext').notNull(),
    refreshTokenCiphertext: text('refresh_token_ciphertext'),
    keyVersion: text('key_version').notNull(),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    expiresAt: tstz('expires_at'),
    refreshExpiresAt: tstz('refresh_expires_at'),
    obtainedAt: tstz('obtained_at').notNull().defaultNow(),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('oauth_tokens_one_active').on(t.connectionId).where(sql`revoked_at IS NULL`)],
);

export const outboundAllowlist = pgTable(
  'outbound_allowlist',
  {
    id: pk(),
    scheme: text('scheme').$type<'https' | 'http'>().notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    purpose: text('purpose').notNull(),
    createdBy: text('created_by').notNull().default('owner'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('outbound_allowlist_target_key').on(t.scheme, t.host, t.port),
    check('outbound_allowlist_scheme_check', inList('scheme', ['https', 'http'])),
    check('outbound_allowlist_port_check', sql`port BETWEEN 1 AND 65535`),
    check('outbound_allowlist_host_check', sql`host = lower(host) AND host !~ '[/@*\\s]'`),
  ],
);

export const SYNC_RUN_KINDS = ['test', 'sync', 'backfill', 'import', 'discover'] as const;
export const SYNC_RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] as const;

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: pk(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<(typeof SYNC_RUN_KINDS)[number]>().notNull(),
    status: text('status').$type<(typeof SYNC_RUN_STATUSES)[number]>().notNull().default('queued'),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    error: text('error'),
    jobId: uuid('job_id'),
    rangeFrom: isoDate('range_from'),
    rangeTo: isoDate('range_to'),
    createdAt: createdAt(),
  },
  (t) => [
    check('sync_runs_kind_check', inList('kind', SYNC_RUN_KINDS)),
    check('sync_runs_status_check', inList('status', SYNC_RUN_STATUSES)),
    index('sync_runs_connection_idx').on(t.connectionId, t.createdAt),
  ],
);
