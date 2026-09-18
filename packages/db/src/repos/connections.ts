/**
 * The connections control plane: provider connections, their discovered accounts, their
 * encrypted secrets, OAuth clients/states/tokens, the outbound allowlist and sync runs.
 *
 * Secrets rule: no ordinary read ever selects a ciphertext column. `listSecrets` returns
 * names and key versions only, and `getActiveOauthToken` returns token metadata only. The
 * ciphertext comes back solely from `getConnectionSecretCiphertext`,
 * `getOauthTokenCiphertext` and the single-use `consumeOauthState`, each of which exists to
 * be called immediately before decryption.
 *
 * Provider integrations are read-only. Nothing here can initiate a payment or a trade.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import {
  connectionAccounts,
  connections,
  connectionSecrets,
  oauthClients,
  oauthStates,
  oauthTokens,
  outboundAllowlist,
  syncRuns,
  type ConnectionConfigValue,
  type ConnectionStatusValue,
  type SYNC_RUN_KINDS,
  type SYNC_RUN_STATUSES,
  type VERIFICATION_LEVELS,
} from '../schema/connections';
import { ConflictError, InvalidError, mapErrors, pickDefined, required, tx, type DbOrTx } from './_util';

export type ConnectionRow = typeof connections.$inferSelect;
export type ConnectionAccountRow = typeof connectionAccounts.$inferSelect;
export type OauthClientRow = typeof oauthClients.$inferSelect;
export type OauthTokenRow = typeof oauthTokens.$inferSelect;
export type OauthStateRow = typeof oauthStates.$inferSelect;
export type OutboundAllowlistRow = typeof outboundAllowlist.$inferSelect;
export type SyncRunRow = typeof syncRuns.$inferSelect;
export type SyncRunKind = (typeof SYNC_RUN_KINDS)[number];
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** A secret's identity and key version. Never its ciphertext. */
export type SecretDescriptor = { id: string; name: string; keyVersion: string; createdAt: Date; updatedAt: Date };

/** A token without any ciphertext column. */
export type OauthTokenMetadata = Omit<OauthTokenRow, 'accessTokenCiphertext' | 'refreshTokenCiphertext'>;

const TOKEN_METADATA_COLUMNS = {
  id: oauthTokens.id,
  connectionId: oauthTokens.connectionId,
  oauthClientId: oauthTokens.oauthClientId,
  tokenType: oauthTokens.tokenType,
  keyVersion: oauthTokens.keyVersion,
  scopes: oauthTokens.scopes,
  expiresAt: oauthTokens.expiresAt,
  refreshExpiresAt: oauthTokens.refreshExpiresAt,
  obtainedAt: oauthTokens.obtainedAt,
  revokedAt: oauthTokens.revokedAt,
  createdAt: oauthTokens.createdAt,
  updatedAt: oauthTokens.updatedAt,
} as const;

// ---------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------

export interface CreateConnectionInput {
  providerKey: string;
  method: string;
  name: string;
  entityId?: string | null;
  /** Non-secret configuration only. Credentials go to `putSecret`. */
  config?: Record<string, ConnectionConfigValue>;
  verificationLevel?: VerificationLevel;
  status?: ConnectionStatusValue;
  nextOwnerStep?: string | null;
}

export async function create(db: DbOrTx, input: CreateConnectionInput): Promise<ConnectionRow> {
  return mapErrors('create connection', async () => {
    const [row] = await db
      .insert(connections)
      .values({
        providerKey: input.providerKey,
        method: input.method,
        name: input.name,
        entityId: input.entityId ?? null,
        config: input.config ?? {},
        verificationLevel: input.verificationLevel ?? 'implemented',
        status: input.status ?? 'not_configured',
        nextOwnerStep: input.nextOwnerStep ?? null,
      })
      .returning();
    return required(row, 'connection');
  });
}

export interface UpdateConnectionInput {
  name?: string;
  entityId?: string | null;
  config?: Record<string, ConnectionConfigValue>;
  coverageFrom?: string | null;
  coverageTo?: string | null;
  coverageNote?: string | null;
  scheduleEnabled?: boolean;
  scheduleCron?: string | null;
  scheduleTimezone?: string;
  paused?: boolean;
  grantedScopes?: string[];
  nextOwnerStep?: string | null;
}

export async function update(db: DbOrTx, id: string, patch: UpdateConnectionInput): Promise<ConnectionRow> {
  return mapErrors('update connection', async () => {
    const [row] = await db.update(connections).set(pickDefined(patch)).where(eq(connections.id, id)).returning();
    return required(row, 'connection');
  });
}

/**
 * Records the connection's state. `statusDetail` and `nextOwnerStep` are what the UI shows,
 * so a credential-blocked connection is never displayed as healthy.
 */
export async function setStatus(
  db: DbOrTx,
  id: string,
  input: { status: ConnectionStatusValue; detail?: string; nextOwnerStep?: string | null; error?: string | null; at?: Date },
): Promise<ConnectionRow> {
  const now = input.at ?? new Date();
  const [row] = await db
    .update(connections)
    .set({
      status: input.status,
      statusDetail: input.detail ?? '',
      ...(input.nextOwnerStep !== undefined ? { nextOwnerStep: input.nextOwnerStep } : {}),
      lastAttemptAt: now,
      ...(input.status === 'connected' ? { lastSuccessAt: now, lastError: null } : {}),
      ...(input.error !== undefined ? { lastError: input.error } : {}),
    })
    .where(eq(connections.id, id))
    .returning();
  return required(row, 'connection');
}

export async function revoke(db: DbOrTx, id: string, now = new Date()): Promise<ConnectionRow> {
  return tx(db, async (t) => {
    await t.update(oauthTokens).set({ revokedAt: now }).where(and(eq(oauthTokens.connectionId, id), isNull(oauthTokens.revokedAt)));
    const [row] = await t
      .update(connections)
      .set({ status: 'revoked', revokedAt: now, statusDetail: 'Access revoked by the owner' })
      .where(eq(connections.id, id))
      .returning();
    return required(row, 'connection');
  });
}

export async function getById(db: DbOrTx, id: string): Promise<ConnectionRow | undefined> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id)).limit(1);
  return row;
}

export async function list(
  db: DbOrTx,
  query: { providerKey?: string; status?: ConnectionStatusValue | ConnectionStatusValue[]; entityId?: string } = {},
): Promise<ConnectionRow[]> {
  const conditions: SQL[] = [];
  if (query.providerKey) conditions.push(eq(connections.providerKey, query.providerKey));
  if (query.status) conditions.push(inArray(connections.status, Array.isArray(query.status) ? query.status : [query.status]));
  if (query.entityId) conditions.push(eq(connections.entityId, query.entityId));
  return db
    .select()
    .from(connections)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(connections.name));
}

/** Connections whose last success is older than `hours`, for the staleness check. */
export async function listStale(db: DbOrTx, hours: number, now = new Date()): Promise<ConnectionRow[]> {
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  return db
    .select()
    .from(connections)
    .where(and(eq(connections.paused, false), inArray(connections.status, ['connected', 'partial_coverage']), lt(connections.lastSuccessAt, cutoff)))
    .orderBy(asc(connections.lastSuccessAt));
}

// ---------------------------------------------------------------------------------------
// Connection accounts
// ---------------------------------------------------------------------------------------

export interface DiscoveredAccountInput {
  connectionId: string;
  externalAccountId: string;
  externalName: string;
  externalMask?: string | null;
  currency?: string | null;
  metadata?: Record<string, unknown>;
}

/** Upserts what the provider reported. Any mapping the owner made is left untouched. */
export async function recordDiscoveredAccounts(db: DbOrTx, inputs: readonly DiscoveredAccountInput[], now = new Date()): Promise<ConnectionAccountRow[]> {
  if (inputs.length === 0) return [];
  return mapErrors('record discovered accounts', () =>
    tx(db, async (t) => {
      const rows: ConnectionAccountRow[] = [];
      for (const input of inputs) {
        const [row] = await t
          .insert(connectionAccounts)
          .values({
            connectionId: input.connectionId,
            externalAccountId: input.externalAccountId,
            externalName: input.externalName,
            externalMask: input.externalMask ?? null,
            currency: input.currency ?? null,
            metadata: input.metadata ?? {},
            discoveredAt: now,
          })
          .onConflictDoUpdate({
            target: [connectionAccounts.connectionId, connectionAccounts.externalAccountId],
            set: {
              externalName: input.externalName,
              externalMask: input.externalMask ?? null,
              currency: input.currency ?? null,
              metadata: input.metadata ?? {},
            },
          })
          .returning();
        rows.push(required(row, 'connection account'));
      }
      return rows;
    }),
  );
}

/** Maps a discovered account to one of ours, or clears the mapping with `null`. */
export async function mapConnectionAccount(db: DbOrTx, id: string, accountId: string | null): Promise<ConnectionAccountRow> {
  const [row] = await db.update(connectionAccounts).set({ accountId }).where(eq(connectionAccounts.id, id)).returning();
  return required(row, 'connection account');
}

export async function excludeConnectionAccount(db: DbOrTx, id: string, excluded: boolean): Promise<ConnectionAccountRow> {
  const [row] = await db.update(connectionAccounts).set({ excluded }).where(eq(connectionAccounts.id, id)).returning();
  return required(row, 'connection account');
}

export async function listConnectionAccounts(db: DbOrTx, connectionId: string): Promise<ConnectionAccountRow[]> {
  return db
    .select()
    .from(connectionAccounts)
    .where(eq(connectionAccounts.connectionId, connectionId))
    .orderBy(asc(connectionAccounts.externalName));
}

// ---------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------

export interface SecretOwner {
  connectionId?: string | null;
  aiProviderId?: string | null;
  oauthClientId?: string | null;
}

function ownerConditions(owner: SecretOwner): SQL[] {
  const conditions: SQL[] = [];
  if (owner.connectionId) conditions.push(eq(connectionSecrets.connectionId, owner.connectionId));
  if (owner.aiProviderId) conditions.push(eq(connectionSecrets.aiProviderId, owner.aiProviderId));
  if (owner.oauthClientId) conditions.push(eq(connectionSecrets.oauthClientId, owner.oauthClientId));
  if (conditions.length !== 1) throw new InvalidError('A secret belongs to exactly one of a connection, an AI provider or an OAuth client');
  return conditions;
}

/** Stores or replaces a secret. The plaintext never reaches this layer. */
export async function putSecret(
  db: DbOrTx,
  input: SecretOwner & { name: string; ciphertext: string; keyVersion: string },
): Promise<SecretDescriptor> {
  if (!input.ciphertext) throw new InvalidError('A secret needs a ciphertext');
  const owner: SecretOwner = {
    connectionId: input.connectionId ?? null,
    aiProviderId: input.aiProviderId ?? null,
    oauthClientId: input.oauthClientId ?? null,
  };
  ownerConditions(owner);
  return mapErrors('store secret', () =>
    tx(db, async (t) => {
      await t.delete(connectionSecrets).where(and(...ownerConditions(owner), eq(connectionSecrets.name, input.name)));
      const [row] = await t
        .insert(connectionSecrets)
        .values({
          connectionId: owner.connectionId ?? null,
          aiProviderId: owner.aiProviderId ?? null,
          oauthClientId: owner.oauthClientId ?? null,
          name: input.name,
          ciphertext: input.ciphertext,
          keyVersion: input.keyVersion,
        })
        .returning({
          id: connectionSecrets.id,
          name: connectionSecrets.name,
          keyVersion: connectionSecrets.keyVersion,
          createdAt: connectionSecrets.createdAt,
          updatedAt: connectionSecrets.updatedAt,
        });
      return required(row, 'secret');
    }),
  );
}

/** Names and key versions only. This is what the UI and every ordinary read may see. */
export async function listSecrets(db: DbOrTx, owner: SecretOwner): Promise<SecretDescriptor[]> {
  return db
    .select({
      id: connectionSecrets.id,
      name: connectionSecrets.name,
      keyVersion: connectionSecrets.keyVersion,
      createdAt: connectionSecrets.createdAt,
      updatedAt: connectionSecrets.updatedAt,
    })
    .from(connectionSecrets)
    .where(and(...ownerConditions(owner)))
    .orderBy(asc(connectionSecrets.name));
}

/**
 * The only function that returns a stored secret's ciphertext. Call it immediately before
 * decrypting, and never log or cache what it returns.
 */
export async function getConnectionSecretCiphertext(
  db: DbOrTx,
  owner: SecretOwner,
  name: string,
): Promise<{ ciphertext: string; keyVersion: string } | undefined> {
  const [row] = await db
    .select({ ciphertext: connectionSecrets.ciphertext, keyVersion: connectionSecrets.keyVersion })
    .from(connectionSecrets)
    .where(and(...ownerConditions(owner), eq(connectionSecrets.name, name)))
    .limit(1);
  return row;
}

export async function deleteSecret(db: DbOrTx, owner: SecretOwner, name: string): Promise<boolean> {
  const rows = await db
    .delete(connectionSecrets)
    .where(and(...ownerConditions(owner), eq(connectionSecrets.name, name)))
    .returning({ id: connectionSecrets.id });
  return rows.length > 0;
}

/** Secrets still wrapped by an older keyring version, for a rotation job. */
export async function countSecretsByKeyVersion(db: DbOrTx): Promise<Record<string, number>> {
  const rows = await db
    .select({ keyVersion: connectionSecrets.keyVersion, n: sql<number>`count(*)::int` })
    .from(connectionSecrets)
    .groupBy(connectionSecrets.keyVersion);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.keyVersion] = row.n;
  return counts;
}

// ---------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------

export interface OauthClientInput {
  providerKey: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  redirectUri: string;
  issuer?: string | null;
  revocationEndpoint?: string | null;
  scopes?: string[];
  registration?: Record<string, unknown>;
  dynamic?: boolean;
}

export async function upsertOauthClient(db: DbOrTx, input: OauthClientInput): Promise<OauthClientRow> {
  const values = {
    providerKey: input.providerKey,
    clientId: input.clientId,
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
    redirectUri: input.redirectUri,
    issuer: input.issuer ?? null,
    revocationEndpoint: input.revocationEndpoint ?? null,
    scopes: input.scopes ?? [],
    registration: input.registration ?? {},
    dynamic: input.dynamic ?? false,
  };
  return mapErrors('upsert oauth client', async () => {
    const [row] = await db
      .insert(oauthClients)
      .values(values)
      .onConflictDoUpdate({ target: [oauthClients.providerKey, oauthClients.clientId], set: values })
      .returning();
    return required(row, 'oauth client');
  });
}

export async function getOauthClient(db: DbOrTx, id: string): Promise<OauthClientRow | undefined> {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1);
  return row;
}

export async function listOauthClients(db: DbOrTx, providerKey?: string): Promise<OauthClientRow[]> {
  return db
    .select()
    .from(oauthClients)
    .where(providerKey ? eq(oauthClients.providerKey, providerKey) : undefined)
    .orderBy(asc(oauthClients.providerKey));
}

export interface OauthStateInput {
  stateHash: string;
  connectionId: string;
  redirectUri: string;
  codeVerifierCiphertext: string;
  keyVersion: string;
  expiresAt: Date;
  oauthClientId?: string | null;
  nonceHash?: string | null;
}

export async function createOauthState(db: DbOrTx, input: OauthStateInput): Promise<{ id: string; expiresAt: Date }> {
  return mapErrors('create oauth state', async () => {
    const [row] = await db
      .insert(oauthStates)
      .values({
        stateHash: input.stateHash,
        connectionId: input.connectionId,
        oauthClientId: input.oauthClientId ?? null,
        codeVerifierCiphertext: input.codeVerifierCiphertext,
        keyVersion: input.keyVersion,
        redirectUri: input.redirectUri,
        nonceHash: input.nonceHash ?? null,
        expiresAt: input.expiresAt,
      })
      .returning({ id: oauthStates.id, expiresAt: oauthStates.expiresAt });
    return required(row, 'oauth state');
  });
}

/**
 * Consumes a state exactly once and returns the PKCE verifier ciphertext. A second call
 * with the same state hash returns undefined, which is what makes replay impossible.
 */
export async function consumeOauthState(
  db: DbOrTx,
  stateHash: string,
  now = new Date(),
): Promise<{ connectionId: string; oauthClientId: string | null; redirectUri: string; codeVerifierCiphertext: string; keyVersion: string; nonceHash: string | null } | undefined> {
  const [row] = await db
    .update(oauthStates)
    .set({ consumedAt: now })
    .where(and(eq(oauthStates.stateHash, stateHash), isNull(oauthStates.consumedAt), gt(oauthStates.expiresAt, now)))
    .returning({
      connectionId: oauthStates.connectionId,
      oauthClientId: oauthStates.oauthClientId,
      redirectUri: oauthStates.redirectUri,
      codeVerifierCiphertext: oauthStates.codeVerifierCiphertext,
      keyVersion: oauthStates.keyVersion,
      nonceHash: oauthStates.nonceHash,
    });
  return row;
}

export async function deleteExpiredOauthStates(db: DbOrTx, now = new Date()): Promise<number> {
  const rows = await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now)).returning({ id: oauthStates.id });
  return rows.length;
}

export interface OauthTokenInput {
  connectionId: string;
  accessTokenCiphertext: string;
  keyVersion: string;
  refreshTokenCiphertext?: string | null;
  oauthClientId?: string | null;
  tokenType?: string;
  scopes?: string[];
  expiresAt?: Date | null;
  refreshExpiresAt?: Date | null;
}

/** Stores a new token and revokes the previous one; a connection has one active token. */
export async function storeOauthToken(db: DbOrTx, input: OauthTokenInput, now = new Date()): Promise<OauthTokenMetadata> {
  if (!input.accessTokenCiphertext) throw new InvalidError('A token needs an access token ciphertext');
  return mapErrors('store oauth token', () =>
    tx(db, async (t) => {
      await t.update(oauthTokens).set({ revokedAt: now }).where(and(eq(oauthTokens.connectionId, input.connectionId), isNull(oauthTokens.revokedAt)));
      const [row] = await t
        .insert(oauthTokens)
        .values({
          connectionId: input.connectionId,
          oauthClientId: input.oauthClientId ?? null,
          tokenType: input.tokenType ?? 'bearer',
          accessTokenCiphertext: input.accessTokenCiphertext,
          refreshTokenCiphertext: input.refreshTokenCiphertext ?? null,
          keyVersion: input.keyVersion,
          scopes: input.scopes ?? [],
          expiresAt: input.expiresAt ?? null,
          refreshExpiresAt: input.refreshExpiresAt ?? null,
          obtainedAt: now,
        })
        .returning(TOKEN_METADATA_COLUMNS);
      return required(row, 'oauth token');
    }),
  );
}

/** Token metadata (expiry, scopes) with no ciphertext. */
export async function getActiveOauthToken(db: DbOrTx, connectionId: string): Promise<OauthTokenMetadata | undefined> {
  const [row] = await db
    .select(TOKEN_METADATA_COLUMNS)
    .from(oauthTokens)
    .where(and(eq(oauthTokens.connectionId, connectionId), isNull(oauthTokens.revokedAt)))
    .limit(1);
  return row;
}

/** The only function returning OAuth token ciphertexts. Call it just before decrypting. */
export async function getOauthTokenCiphertext(
  db: DbOrTx,
  connectionId: string,
): Promise<{ accessTokenCiphertext: string; refreshTokenCiphertext: string | null; keyVersion: string } | undefined> {
  const [row] = await db
    .select({
      accessTokenCiphertext: oauthTokens.accessTokenCiphertext,
      refreshTokenCiphertext: oauthTokens.refreshTokenCiphertext,
      keyVersion: oauthTokens.keyVersion,
    })
    .from(oauthTokens)
    .where(and(eq(oauthTokens.connectionId, connectionId), isNull(oauthTokens.revokedAt)))
    .limit(1);
  return row;
}

export async function revokeOauthTokens(db: DbOrTx, connectionId: string, now = new Date()): Promise<number> {
  const rows = await db
    .update(oauthTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthTokens.connectionId, connectionId), isNull(oauthTokens.revokedAt)))
    .returning({ id: oauthTokens.id });
  return rows.length;
}

// ---------------------------------------------------------------------------------------
// Outbound allowlist
// ---------------------------------------------------------------------------------------

export interface AllowlistInput {
  scheme: 'https' | 'http';
  host: string;
  port: number;
  purpose: string;
  createdBy?: string;
}

/** Every outbound host the worker may reach. Nothing not listed here is fetched. */
export async function allowOutbound(db: DbOrTx, input: AllowlistInput): Promise<OutboundAllowlistRow> {
  const host = input.host.toLowerCase();
  if (/[/@*\s]/.test(host)) throw new InvalidError('An allowlist host is a bare hostname');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new InvalidError('Port must be between 1 and 65535');
  return mapErrors('allow outbound host', async () => {
    const inserted = await db
      .insert(outboundAllowlist)
      .values({ scheme: input.scheme, host, port: input.port, purpose: input.purpose, createdBy: input.createdBy ?? 'owner' })
      .onConflictDoNothing({ target: [outboundAllowlist.scheme, outboundAllowlist.host, outboundAllowlist.port] })
      .returning();
    if (inserted[0]) return inserted[0];
    const [existing] = await db
      .select()
      .from(outboundAllowlist)
      .where(and(eq(outboundAllowlist.scheme, input.scheme), eq(outboundAllowlist.host, host), eq(outboundAllowlist.port, input.port)))
      .limit(1);
    return required(existing, 'allowlist entry');
  });
}

export async function denyOutbound(db: DbOrTx, id: string): Promise<boolean> {
  const rows = await db.delete(outboundAllowlist).where(eq(outboundAllowlist.id, id)).returning({ id: outboundAllowlist.id });
  return rows.length > 0;
}

export async function listOutboundAllowlist(db: DbOrTx): Promise<OutboundAllowlistRow[]> {
  return db.select().from(outboundAllowlist).orderBy(asc(outboundAllowlist.host), asc(outboundAllowlist.port));
}

export async function isOutboundAllowed(db: DbOrTx, target: { scheme: string; host: string; port: number }): Promise<boolean> {
  const [row] = await db
    .select({ id: outboundAllowlist.id })
    .from(outboundAllowlist)
    .where(
      and(
        eq(outboundAllowlist.scheme, target.scheme as 'https' | 'http'),
        eq(outboundAllowlist.host, target.host.toLowerCase()),
        eq(outboundAllowlist.port, target.port),
      ),
    )
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------------------
// Sync runs
// ---------------------------------------------------------------------------------------

export async function startSyncRun(
  db: DbOrTx,
  input: { connectionId: string; kind: SyncRunKind; jobId?: string | null; rangeFrom?: string | null; rangeTo?: string | null },
  now = new Date(),
): Promise<SyncRunRow> {
  return mapErrors('start sync run', async () => {
    const [row] = await db
      .insert(syncRuns)
      .values({
        connectionId: input.connectionId,
        kind: input.kind,
        status: 'running',
        startedAt: now,
        jobId: input.jobId ?? null,
        rangeFrom: input.rangeFrom ?? null,
        rangeTo: input.rangeTo ?? null,
      })
      .returning();
    return required(row, 'sync run');
  });
}

export async function finishSyncRun(
  db: DbOrTx,
  id: string,
  input: { status: SyncRunStatus; counts?: Record<string, number>; error?: string | null },
  now = new Date(),
): Promise<SyncRunRow> {
  const [row] = await db
    .update(syncRuns)
    .set({ status: input.status, counts: input.counts ?? {}, error: input.error ? input.error.slice(0, 2000) : null, finishedAt: now })
    .where(eq(syncRuns.id, id))
    .returning();
  return required(row, 'sync run');
}

export async function listSyncRuns(db: DbOrTx, connectionId: string, limit = 20): Promise<SyncRunRow[]> {
  return db.select().from(syncRuns).where(eq(syncRuns.connectionId, connectionId)).orderBy(desc(syncRuns.createdAt)).limit(limit);
}

export async function latestSyncRun(db: DbOrTx, connectionId: string): Promise<SyncRunRow | undefined> {
  const [row] = await listSyncRuns(db, connectionId, 1);
  return row;
}

/** Refuses to leave a run marked running forever after a crash. */
export async function failStaleSyncRuns(db: DbOrTx, olderThanMinutes: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);
  const rows = await db
    .update(syncRuns)
    .set({ status: 'failed', error: 'The run did not finish; the worker stopped', finishedAt: now })
    .where(and(eq(syncRuns.status, 'running'), lt(syncRuns.startedAt, cutoff)))
    .returning({ id: syncRuns.id });
  return rows.length;
}

/** Guards against two syncs of the same connection at once. */
export async function assertNoRunningSync(db: DbOrTx, connectionId: string): Promise<void> {
  const [row] = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(eq(syncRuns.connectionId, connectionId), inArray(syncRuns.status, ['queued', 'running'])))
    .limit(1);
  if (row) throw new ConflictError(`Connection ${connectionId} already has a sync in progress`);
}
