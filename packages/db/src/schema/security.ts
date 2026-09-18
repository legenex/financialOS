import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, inList, pk, tstz, updatedAt } from './_columns';

/** The single owner of this deployment. At most one row can exist. */
export const ownerAccount = pgTable(
  'owner_account',
  {
    id: pk(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash'),
    totpSecretCiphertext: text('totp_secret_ciphertext'),
    totpEnabledAt: tstz('totp_enabled_at'),
    totpLastUsedStep: bigint('totp_last_used_step', { mode: 'number' }),
    passwordChangedAt: tstz('password_changed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [uniqueIndex('owner_account_singleton').using('btree', sql`(true)`)],
);

export const SETUP_STATES = ['awaiting_bootstrap_secret', 'in_progress', 'sealed'] as const;
export type SetupStateValue = (typeof SETUP_STATES)[number];

/** One-row setup state machine. */
export const setupState = pgTable(
  'setup_state',
  {
    id: smallint('id').primaryKey().default(1),
    state: text('state').$type<SetupStateValue>().notNull().default('awaiting_bootstrap_secret'),
    bootstrapSecretHash: text('bootstrap_secret_hash'),
    bootstrapConsumedAt: tstz('bootstrap_consumed_at'),
    setupTokenHash: text('setup_token_hash'),
    setupTokenExpiresAt: tstz('setup_token_expires_at'),
    ownerCreatedAt: tstz('owner_created_at'),
    totpVerifiedAt: tstz('totp_verified_at'),
    recoveryCodesIssuedAt: tstz('recovery_codes_issued_at'),
    passkeyEnrolledAt: tstz('passkey_enrolled_at'),
    sealedAt: tstz('sealed_at'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: tstz('locked_until'),
    updatedAt: updatedAt(),
  },
  () => [check('setup_state_singleton', sql`id = 1`), check('setup_state_state_check', inList('state', SETUP_STATES))],
);

export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: pk(),
    credentialId: text('credential_id').notNull().unique('webauthn_credentials_credential_id_key'),
    publicKey: bytea('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull().default(false),
    rpId: text('rp_id').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
  },
);

export const WEBAUTHN_CHALLENGE_PURPOSES = ['register', 'authenticate'] as const;

export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: pk(),
    purpose: text('purpose').$type<(typeof WEBAUTHN_CHALLENGE_PURPOSES)[number]>().notNull(),
    challenge: text('challenge').notNull(),
    rpId: text('rp_id').notNull(),
    origin: text('origin').notNull(),
    binding: text('binding'),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
  },
  (t) => [
    check('webauthn_challenges_purpose_check', inList('purpose', WEBAUTHN_CHALLENGE_PURPOSES)),
    uniqueIndex('webauthn_challenges_challenge_key').on(t.challenge),
    index('webauthn_challenges_expires_idx').on(t.expiresAt),
  ],
);

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: pk(),
    batchId: uuid('batch_id').notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: tstz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('recovery_codes_batch_idx').on(t.batchId)],
);

/** Owner web sessions. The absolute lifetime is capped at 600 seconds by a check constraint. */
export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    tokenHash: text('token_hash').notNull().unique('sessions_token_hash_key'),
    authMethod: text('auth_method').notNull(),
    authenticatedAt: tstz('authenticated_at').notNull(),
    absoluteExpiresAt: tstz('absolute_expires_at').notNull(),
    idleExpiresAt: tstz('idle_expires_at').notNull(),
    lastActivityAt: tstz('last_activity_at').notNull(),
    createdAt: createdAt(),
    revokedAt: tstz('revoked_at'),
    revokeReason: text('revoke_reason'),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
    origin: text('origin'),
    launchRequestId: uuid('launch_request_id'),
  },
  (t) => [
    check('sessions_absolute_lifetime_check', sql`absolute_expires_at <= authenticated_at + interval '600 seconds'`),
    index('sessions_absolute_expires_idx').on(t.absoluteExpiresAt),
  ],
);

export const loginThrottle = pgTable('login_throttle', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  firstFailureAt: tstz('first_failure_at').notNull().defaultNow(),
  lastFailureAt: tstz('last_failure_at').notNull().defaultNow(),
  lockedUntil: tstz('locked_until'),
});

export const launchRequests = pgTable(
  'launch_requests',
  {
    id: pk(),
    nonceHash: text('nonce_hash').notNull().unique('launch_requests_nonce_hash_key'),
    target: text('target').notNull(),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    consumedSessionId: uuid('consumed_session_id'),
  },
  (t) => [index('launch_requests_expires_idx').on(t.expiresAt)],
);

/** Paired extension devices. Credentials are stored hashed. */
export const devices = pgTable(
  'devices',
  {
    id: pk(),
    label: text('label').notNull(),
    kind: text('kind').notNull().default('chrome_extension'),
    extensionOrigin: text('extension_origin').notNull(),
    installationId: text('installation_id').notNull(),
    credentialHash: text('credential_hash').notNull().unique('devices_credential_hash_key'),
    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
    revealedFields: text('revealed_fields').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    revokedAt: tstz('revoked_at'),
    lastAccessAt: tstz('last_access_at'),
    accessCount: integer('access_count').notNull().default(0),
  },
  (t) => [index('devices_installation_idx').on(t.installationId)],
);

export const devicePairings = pgTable(
  'device_pairings',
  {
    id: pk(),
    installationId: text('installation_id').notNull(),
    verifierChallenge: text('verifier_challenge').notNull(),
    userCodeHash: text('user_code_hash').notNull(),
    deviceLabel: text('device_label').notNull(),
    extensionOrigin: text('extension_origin').notNull(),
    extensionVersion: text('extension_version').notNull(),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    approvedAt: tstz('approved_at'),
    approvedLabel: text('approved_label'),
    approvedExpiresDays: integer('approved_expires_days'),
    deniedAt: tstz('denied_at'),
    completedAt: tstz('completed_at'),
    deviceId: uuid('device_id').references(() => devices.id),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    index('device_pairings_user_code_idx').on(t.userCodeHash),
    index('device_pairings_installation_idx').on(t.installationId),
  ],
);

/** Agent API / MCP credentials. Stored hashed. */
export const agentClients = pgTable('agent_clients', {
  id: pk(),
  name: text('name').notNull(),
  credentialHash: text('credential_hash').notNull().unique('agent_clients_credential_hash_key'),
  scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
  entityIds: uuid('entity_ids').array().notNull().default(sql`'{}'::uuid[]`),
  createdAt: createdAt(),
  expiresAt: tstz('expires_at').notNull(),
  revokedAt: tstz('revoked_at'),
  lastUsedAt: tstz('last_used_at'),
});

export const AUDIT_ACTOR_TYPES = ['owner', 'system', 'worker', 'agent', 'device', 'anonymous'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Append-only audit log. A trigger rejects UPDATE, DELETE, and TRUNCATE, and the
 * application roles only hold INSERT and SELECT. A database superuser can still alter
 * it, so it is not tamper-proof.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: tstz('occurred_at').notNull().defaultNow(),
    actorType: text('actor_type').$type<AuditActorType>().notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    objectType: text('object_type'),
    objectId: text('object_id'),
    entityId: uuid('entity_id'),
    summary: text('summary').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    requestId: text('request_id'),
    ipHash: text('ip_hash'),
  },
  (t) => [
    check('audit_events_actor_type_check', inList('actor_type', AUDIT_ACTOR_TYPES)),
    index('audit_events_occurred_idx').on(t.occurredAt),
    index('audit_events_object_idx').on(t.objectType, t.objectId),
  ],
);
