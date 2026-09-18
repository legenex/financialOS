/**
 * Connections: provider catalogue, connections, write-only credentials, tests, discovery, syncs,
 * backfills, account mapping, OAuth, the outbound allowlist and AI providers.
 *
 * Secrets are encrypted with the keyring and never appear in any response. Everything that talks to
 * a provider is a durable job: a request only records intent and returns a job id.
 */
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AccountMappingInput,
  AiProviderInput,
  BackfillInput,
  ConnectionCreateInput,
  ConnectionUpdateInput,
  CredentialInput,
  OutboundAllowlistInput,
  type AiProvider,
  type Connection,
  type ConnectionAccountLink,
  type OAuthStartResult,
  type OutboundAllowlistEntry,
  type ProviderDescriptor,
  type SyncRun,
} from '@financialos/contracts';
import {
  aiProviders,
  aiUsage,
  jobRecords,
  connectionAccounts,
  connectionSecrets,
  connections as connectionsTable,
  oauthClients,
  oauthStates,
  oauthTokens,
  outboundAllowlist,
  syncRuns,
  type DbOrTx,
} from '@financialos/db';
import { errors } from '../../errors';
import { parseBody, parseQuery } from '../../validation';
import { RATE_LIMITS } from '../../plugins/rate-limit';
import { dec, toDecimalString } from '@financialos/domain';
import { iso, loadSettings, normalizeDecimal } from '../../data/common';
import { findProvider, loadProviderRegistry } from '../../data/provider-registry';
import { audit, enqueueJob, loadOne, ownerRoutes, requireUuid } from './_shared';

const OAUTH_STATE_TTL_SECONDS = 600;
const CALLBACK_PATH = '/api/oauth/callback';

type ConnectionRow = typeof connectionsTable.$inferSelect;

const OAuthCallbackQuery = z.object({
  state: z.string().min(16).max(200).regex(/^[A-Za-z0-9_-]+$/),
  code: z.string().min(1).max(2048).regex(/^[A-Za-z0-9._~+/=-]+$/).optional(),
  error: z.string().max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

function connectionSecretAad(connectionId: string): string {
  return `connection-secret:${connectionId}`;
}

function aiProviderSecretAad(providerId: string): string {
  return `ai-provider-secret:${providerId}`;
}

function syncRunView(row: typeof syncRuns.$inferSelect): SyncRun {
  return {
    id: row.id,
    kind: row.kind === 'discover' ? 'test' : row.kind,
    status: row.status,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    counts: row.counts,
    error: row.error,
    jobId: row.jobId,
  };
}

async function connectionView(db: DbOrTx, row: ConnectionRow, descriptor: ProviderDescriptor | null): Promise<Connection> {
  const [accountLinks, runs, secrets] = await Promise.all([
    connectionAccountsFor(db, row.id),
    db.select().from(syncRuns).where(eq(syncRuns.connectionId, row.id)).orderBy(desc(syncRuns.createdAt)).limit(10),
    // Only metadata: the ciphertext column is never selected here.
    db.select({ id: connectionSecrets.id, updatedAt: connectionSecrets.updatedAt }).from(connectionSecrets).where(eq(connectionSecrets.connectionId, row.id)),
  ]);
  const latestSecret = secrets.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  const method = descriptor?.methods.find((m) => m.method === row.method) ?? null;
  return {
    id: row.id,
    providerKey: row.providerKey,
    providerName: descriptor?.name ?? row.providerKey,
    method: row.method as Connection['method'],
    name: row.name,
    entityId: row.entityId,
    status: row.status,
    statusDetail: row.statusDetail,
    nextOwnerStep: row.nextOwnerStep ?? method?.ownerActivationSteps[0] ?? null,
    verificationLevel: method?.verificationLevel ?? row.verificationLevel,
    hasCredential: secrets.length > 0,
    credentialUpdatedAt: latestSecret ? iso(latestSecret.updatedAt) : null,
    config: row.config,
    grantedScopes: row.grantedScopes,
    lastSuccessAt: iso(row.lastSuccessAt),
    lastAttemptAt: iso(row.lastAttemptAt),
    lastError: row.lastError,
    coverage: { from: row.coverageFrom, to: row.coverageTo, note: row.coverageNote },
    schedule: { enabled: row.scheduleEnabled, cron: row.scheduleCron, timezone: row.scheduleTimezone },
    paused: row.paused,
    accounts: accountLinks,
    recentRuns: runs.map(syncRunView),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function connectionAccountsFor(db: DbOrTx, connectionId: string): Promise<ConnectionAccountLink[]> {
  const rows = await db.select().from(connectionAccounts).where(eq(connectionAccounts.connectionId, connectionId)).orderBy(asc(connectionAccounts.externalName));
  return rows.map((row) => ({
    externalAccountId: row.externalAccountId,
    externalName: row.externalName,
    externalMask: row.externalMask,
    currency: row.currency,
    accountId: row.accountId,
    excluded: row.excluded,
  }));
}

function aiProviderView(row: typeof aiProviders.$inferSelect, hasCredential: boolean, usedThisMonthUsd: string): AiProvider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    model: row.model,
    locality: row.locality,
    enabled: row.enabled,
    hasCredential,
    allowIdentifiableData: row.allowIdentifiableData,
    monthlyBudgetUsd: normalizeDecimal(row.monthlyBudgetUsd),
    usedThisMonthUsd,
    taskRouting: row.taskRouting as AiProvider['taskRouting'],
    lastTest: row.lastTestAt ? { at: iso(row.lastTestAt), ok: row.lastTestOk ?? false, detail: row.lastTestDetail ?? '' } : null,
    isOrchestrator: row.isOrchestrator,
  };
}

export function registerConnectionRoutes(app: FastifyInstance): void {
  // The provider redirect is a cross-site top-level navigation: the SameSite=Strict session cookie
  // is not sent, so this route authenticates the callback by its single-use state instead.
  app.get(CALLBACK_PATH, { config: { rateLimit: RATE_LIMITS.oauth } }, async (req, reply) => {
    const query = parseQuery(OAuthCallbackQuery, req.query);
    const { db, clock, keyring, audit: auditService } = req.server.fos;
    const now = clock.now();
    const stateHash = createHash('sha256').update(`oauth-state:${query.state}`).digest('hex');
    const [state] = await db.select().from(oauthStates).where(eq(oauthStates.stateHash, stateHash)).limit(1);
    if (!state || state.consumedAt || state.expiresAt.getTime() <= now.getTime()) {
      await auditService.fromRequest(req, 'oauth.callback_rejected', { type: 'connection' }, 'OAuth callback with an unknown, used or expired state');
      throw errors.forbidden('oauth_state_invalid', 'This authorization link is not valid any more. Start the connection again.');
    }
    await db.update(oauthStates).set({ consumedAt: now }).where(eq(oauthStates.id, state.id));
    if (query.error || !query.code) {
      await db
        .update(connectionsTable)
        .set({ status: 'needs_authorization', statusDetail: 'The provider did not grant access.', lastAttemptAt: now, updatedAt: now })
        .where(eq(connectionsTable.id, state.connectionId));
      await auditService.fromRequest(req, 'oauth.denied', { type: 'connection', id: state.connectionId }, 'Provider authorization was not granted');
      return reply.code(303).header('location', '/connections?oauth=denied').send();
    }
    // The authorization code is a secret: it is stored encrypted and exchanged by the worker.
    await db
      .insert(connectionSecrets)
      .values({
        connectionId: state.connectionId,
        name: 'oauth_authorization_code',
        ciphertext: keyring.encryptString(query.code, connectionSecretAad(state.connectionId)),
        keyVersion: keyring.activeKid,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectionSecrets.connectionId, connectionSecrets.name],
        set: { ciphertext: keyring.encryptString(query.code, connectionSecretAad(state.connectionId)), keyVersion: keyring.activeKid, updatedAt: now },
      });
    await db
      .update(connectionsTable)
      .set({ status: 'syncing', statusDetail: 'Exchanging the authorization code.', lastAttemptAt: now, updatedAt: now })
      .where(eq(connectionsTable.id, state.connectionId));
    const [job] = await db
      .insert(jobRecords)
      .values({
        queue: 'sync.connection',
        label: 'Complete provider authorization',
        idempotencyKey: `oauth.exchange:${state.id}`,
        cancellable: false,
        subjectType: 'connection',
        subjectId: state.connectionId,
        requestedBy: 'oauth_callback',
        payload: { reason: 'oauth_exchange', connectionId: state.connectionId, oauthStateId: state.id },
      })
      .onConflictDoNothing({ target: jobRecords.idempotencyKey })
      .returning();
    if (job) {
      try {
        const result = await req.server.fos.jobs.enqueue('sync.connection', { reason: 'oauth_exchange', connectionId: state.connectionId, jobRecordId: job.id }, { singletonKey: `sync.connection:${state.connectionId}` });
        if (result.jobId) await db.update(jobRecords).set({ pgbossJobId: result.jobId }).where(eq(jobRecords.id, job.id));
      } catch {
        // The code is stored; the worker picks it up on the next scheduled sync.
      }
    }
    await auditService.fromRequest(req, 'oauth.callback_accepted', { type: 'connection', id: state.connectionId }, 'Provider authorization returned; token exchange scheduled');
    return reply.code(303).header('location', '/connections?oauth=complete').send();
  });

  ownerRoutes(app, (scope) => {
    scope.get('/api/providers', async () => {
      const registry = await loadProviderRegistry();
      return { items: registry.items, available: registry.available, note: registry.note };
    });

    scope.get('/api/connections', async (req): Promise<{ items: Connection[] }> => {
      const { db } = req.server.fos;
      const rows = await db.select().from(connectionsTable).orderBy(asc(connectionsTable.name)).limit(200);
      const registry = await loadProviderRegistry();
      const byKey = new Map(registry.items.map((p) => [p.key, p]));
      const items: Connection[] = [];
      for (const row of rows) items.push(await connectionView(db, row, byKey.get(row.providerKey) ?? null));
      return { items };
    });

    scope.post('/api/connections', async (req, reply): Promise<Connection> => {
      const input = parseBody(ConnectionCreateInput, req.body);
      const { db } = req.server.fos;
      const descriptor = await findProvider(input.providerKey);
      const method = descriptor?.methods.find((m) => m.method === input.method) ?? null;
      const [row] = await db
        .insert(connectionsTable)
        .values({
          providerKey: input.providerKey,
          method: input.method,
          name: input.name,
          entityId: input.entityId,
          status: 'not_configured',
          statusDetail: method ? 'Add the credentials this method needs.' : 'This provider is not declared on this server yet.',
          nextOwnerStep: method?.ownerActivationSteps[0] ?? null,
          verificationLevel: method?.verificationLevel ?? 'implemented',
          config: input.config,
        })
        .returning();
      if (!row) throw new Error('connection insert returned no row');
      await audit(req, 'connection.created', { type: 'connection', id: row.id }, `Connection created (${row.providerKey}/${row.method})`, {
        providerKey: row.providerKey,
        method: row.method,
      });
      reply.code(201);
      return connectionView(db, row, descriptor);
    });

    scope.get<{ Params: { id: string } }>('/api/connections/:id', async (req): Promise<Connection> => {
      const id = requireUuid(req.params.id, 'connection_not_found');
      const { db } = req.server.fos;
      const row = await loadOne(db.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(1), 'connection_not_found', 'Connection not found.');
      return connectionView(db, row, await findProvider(row.providerKey));
    });

    scope.patch<{ Params: { id: string } }>('/api/connections/:id', async (req): Promise<Connection> => {
      const id = requireUuid(req.params.id, 'connection_not_found');
      const input = parseBody(ConnectionUpdateInput, req.body);
      const { db, clock } = req.server.fos;
      const [row] = await db
        .update(connectionsTable)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
          ...(input.config !== undefined ? { config: input.config } : {}),
          ...(input.schedule !== undefined ? { scheduleEnabled: input.schedule.enabled, scheduleCron: input.schedule.cron } : {}),
          ...(input.paused !== undefined ? { paused: input.paused, status: input.paused ? ('paused' as const) : ('not_configured' as const) } : {}),
          updatedAt: clock.now(),
        })
        .where(eq(connectionsTable.id, id))
        .returning();
      if (!row) throw errors.notFound('connection_not_found', 'Connection not found.');
      await audit(req, 'connection.updated', { type: 'connection', id }, 'Connection updated', { fields: Object.keys(input) });
      return connectionView(db, row, await findProvider(row.providerKey));
    });

    scope.delete<{ Params: { id: string } }>('/api/connections/:id', async (req) => {
      const id = requireUuid(req.params.id, 'connection_not_found');
      const { db, clock } = req.server.fos;
      const row = await loadOne(db.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(1), 'connection_not_found', 'Connection not found.');
      await db.transaction(async (tx) => {
        await tx.delete(connectionSecrets).where(eq(connectionSecrets.connectionId, id));
        await tx.update(oauthTokens).set({ revokedAt: clock.now() }).where(and(eq(oauthTokens.connectionId, id), isNull(oauthTokens.revokedAt)));
        await tx
          .update(connectionsTable)
          .set({ status: 'revoked', statusDetail: 'Revoked by the owner; stored credentials were deleted.', revokedAt: clock.now(), paused: true, scheduleEnabled: false, updatedAt: clock.now() })
          .where(eq(connectionsTable.id, id));
      });
      await audit(req, 'connection.revoked', { type: 'connection', id }, `Connection revoked and credentials deleted (${row.providerKey})`);
      return { revoked: true };
    });

    scope.put<{ Params: { id: string } }>('/api/connections/:id/credentials', async (req): Promise<Connection> => {
      const id = requireUuid(req.params.id, 'connection_not_found');
      const input = parseBody(CredentialInput, req.body);
      const { db, clock, keyring } = req.server.fos;
      const row = await loadOne(db.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(1), 'connection_not_found', 'Connection not found.');
      const names = Object.keys(input.secrets);
      if (names.length === 0) throw errors.badRequest('No credential fields were sent.');
      if (names.some((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name))) throw errors.badRequest('Credential field names must be lower-case identifiers.');
      const now = clock.now();
      await db.transaction(async (tx) => {
        for (const [name, value] of Object.entries(input.secrets)) {
          const ciphertext = keyring.encryptString(value, connectionSecretAad(id));
          await tx
            .insert(connectionSecrets)
            .values({ connectionId: id, name, ciphertext, keyVersion: keyring.activeKid, updatedAt: now })
            .onConflictDoUpdate({
              target: [connectionSecrets.connectionId, connectionSecrets.name],
              targetWhere: sql`${connectionSecrets.connectionId} is not null`,
              set: { ciphertext, keyVersion: keyring.activeKid, updatedAt: now },
            });
        }
        await tx
          .update(connectionsTable)
          .set({ status: 'connected', statusDetail: 'Credentials stored. Run a test to confirm they work.', updatedAt: now })
          .where(eq(connectionsTable.id, id));
      });
      // Field names are recorded so a change is auditable; values never leave the keyring.
      await audit(req, 'connection.credentials_stored', { type: 'connection', id }, 'Connection credentials stored (write-only)', { fields: names });
      const updated = await loadOne(db.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(1), 'connection_not_found', 'Connection not found.');
      return connectionView(db, updated, await findProvider(row.providerKey));
    });

    scope.delete<{ Params: { id: string } }>('/api/connections/:id/credentials', async (req): Promise<Connection> => {
      const id = requireUuid(req.params.id, 'connection_not_found');
      const { db, clock } = req.server.fos;
      const row = await loadOne(db.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(1), 'connection_not_found', 'Connection not found.');
      await db.transaction(async (tx) => {
        await tx.delete(connectionSecrets).where(eq(connectionSecrets.connectionId, id));
        await tx.update(oauthTokens).set({ revokedAt: clock.now() }).where(and(eq(oauthTokens.connectionId, id), isNull(oauthTokens.revokedAt)));
        await tx
          .update(connectionsTable)
          .set({ status: 'not_configured', statusDetail: 'Stored credentials were removed.', updatedAt: clock.now() })
          .where(eq(connectionsTable.id, id));
      });
      await audit(req, 'connection.credentials_revoked', { type: 'connection', id }, 'Connection credentials removed');
      const updated = await loadOne(db.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(1), 'connection_not_found', 'Connection not found.');
      return connectionView(db, updated, await findProvider(row.providerKey));
    });

    const connectionJob = (path: string, queue: string, label: string, action: string, cancellable: boolean) => {
      scope.post<{ Params: { id: string } }>(path, async (req): Promise<{ jobId: string }> => {
        const id = requireUuid(req.params.id, 'connection_not_found');
        const { db } = req.server.fos;
        const row = await loadOne(db.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(1), 'connection_not_found', 'Connection not found.');
        if (row.revokedAt) throw errors.conflict('connection_revoked', 'This connection has been revoked.');
        const result = await enqueueJob(req, {
          queue,
          label: `${label}: ${row.name}`,
          data: { connectionId: id, action },
          singletonKey: `${queue}:${action}:${id}`,
          cancellable,
          subjectType: 'connection',
          subjectId: id,
          entityId: row.entityId,
        });
        await audit(req, `connection.${action}`, { type: 'connection', id }, `${label} scheduled`, { jobId: result.jobId });
        return result;
      });
    };

    connectionJob('/api/connections/:id/test', 'sync.connection', 'Connection test', 'test', false);
    connectionJob('/api/connections/:id/discover-accounts', 'sync.connection', 'Account discovery', 'discover', false);
    connectionJob('/api/connections/:id/sync', 'sync.connection', 'Sync', 'sync', true);

    scope.post<{ Params: { id: string } }>('/api/connections/:id/backfill', async (req): Promise<{ jobId: string }> => {
      const id = requireUuid(req.params.id, 'connection_not_found');
      const input = parseBody(BackfillInput, req.body);
      const { db } = req.server.fos;
      const row = await loadOne(db.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(1), 'connection_not_found', 'Connection not found.');
      if (row.revokedAt) throw errors.conflict('connection_revoked', 'This connection has been revoked.');
      const result = await enqueueJob(req, {
        queue: 'sync.backfill',
        label: `Backfill: ${row.name}`,
        data: { connectionId: id, from: input.from, to: input.to },
        singletonKey: `sync.backfill:${id}`,
        cancellable: true,
        subjectType: 'connection',
        subjectId: id,
        entityId: row.entityId,
      });
      await audit(req, 'connection.backfill', { type: 'connection', id }, 'Backfill scheduled', { from: input.from, to: input.to, jobId: result.jobId });
      return result;
    });

    scope.put<{ Params: { id: string } }>('/api/connections/:id/accounts', async (req): Promise<Connection> => {
      const id = requireUuid(req.params.id, 'connection_not_found');
      const input = parseBody(AccountMappingInput, req.body);
      const { db, clock } = req.server.fos;
      const row = await loadOne(db.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(1), 'connection_not_found', 'Connection not found.');
      await db.transaction(async (tx) => {
        for (const link of input.links) {
          await tx
            .update(connectionAccounts)
            .set({ accountId: link.accountId, excluded: link.excluded, updatedAt: clock.now() })
            .where(and(eq(connectionAccounts.connectionId, id), eq(connectionAccounts.externalAccountId, link.externalAccountId)));
        }
      });
      await audit(req, 'connection.accounts_mapped', { type: 'connection', id }, 'Provider accounts mapped', {
        mapped: input.links.filter((l) => l.accountId !== null).length,
        excluded: input.links.filter((l) => l.excluded).length,
      });
      return connectionView(db, row, await findProvider(row.providerKey));
    });

    scope.post<{ Params: { id: string } }>('/api/connections/:id/oauth/start', async (req): Promise<OAuthStartResult> => {
      const id = requireUuid(req.params.id, 'connection_not_found');
      const { db, clock, keyring, config } = req.server.fos;
      const row = await loadOne(db.select().from(connectionsTable).where(eq(connectionsTable.id, id)).limit(1), 'connection_not_found', 'Connection not found.');
      const [client] = await db.select().from(oauthClients).where(eq(oauthClients.providerKey, row.providerKey)).limit(1);
      if (!client) {
        throw errors.conflict('oauth_client_missing', 'No OAuth client is registered for this provider yet, so authorization cannot start.');
      }
      const redirectUri = `${config.publicBaseForOAuthCallbacks}${CALLBACK_PATH}`;
      if (client.redirectUri !== redirectUri) {
        throw errors.conflict('oauth_redirect_mismatch', 'The registered redirect URI does not match this deployment. Re-register the OAuth client.');
      }
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(64).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000);
      await db.insert(oauthStates).values({
        stateHash: createHash('sha256').update(`oauth-state:${state}`).digest('hex'),
        connectionId: id,
        oauthClientId: client.id,
        // The verifier is a secret: only its ciphertext is stored, and only the worker uses it.
        codeVerifierCiphertext: keyring.encryptString(verifier, connectionSecretAad(id)),
        keyVersion: keyring.activeKid,
        redirectUri,
        createdAt: now,
        expiresAt,
      });
      const url = new URL(client.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (client.scopes.length > 0) url.searchParams.set('scope', client.scopes.join(' '));
      await db
        .update(connectionsTable)
        .set({ status: 'needs_authorization', statusDetail: 'Waiting for you to approve access at the provider.', lastAttemptAt: now, updatedAt: now })
        .where(eq(connectionsTable.id, id));
      await audit(req, 'connection.oauth_started', { type: 'connection', id }, 'Provider authorization started', { providerKey: row.providerKey });
      return { authorizationUrl: url.toString(), expiresAt: expiresAt.toISOString() };
    });

    // --- Outbound allowlist ------------------------------------------------------------------
    scope.get('/api/outbound-allowlist', async (req): Promise<{ items: OutboundAllowlistEntry[] }> => {
      const rows = await req.server.fos.db.select().from(outboundAllowlist).orderBy(asc(outboundAllowlist.host)).limit(500);
      return { items: rows.map((row) => ({ id: row.id, scheme: row.scheme, host: row.host, port: row.port, purpose: row.purpose, createdAt: iso(row.createdAt) })) };
    });

    scope.post('/api/outbound-allowlist', async (req, reply): Promise<OutboundAllowlistEntry> => {
      const input = parseBody(OutboundAllowlistInput, req.body);
      const host = input.host.toLowerCase();
      if (/[/@*\s]/.test(host) || host.length === 0) throw errors.badRequest('The host must be a bare host name or address.');
      const [row] = await req.server.fos.db
        .insert(outboundAllowlist)
        .values({ scheme: input.scheme, host, port: input.port, purpose: input.purpose })
        .onConflictDoNothing({ target: [outboundAllowlist.scheme, outboundAllowlist.host, outboundAllowlist.port] })
        .returning();
      if (!row) throw errors.conflict('allowlist_entry_exists', 'That destination is already allowed.');
      await audit(req, 'outbound_allowlist.added', { type: 'outbound_allowlist', id: row.id }, `Outbound destination allowed (${row.scheme}://${row.host}:${row.port})`);
      reply.code(201);
      return { id: row.id, scheme: row.scheme, host: row.host, port: row.port, purpose: row.purpose, createdAt: iso(row.createdAt) };
    });

    scope.delete('/api/outbound-allowlist', async (req) => {
      const input = parseBody(z.object({ id: z.uuid() }), req.body);
      const rows = await req.server.fos.db.delete(outboundAllowlist).where(eq(outboundAllowlist.id, input.id)).returning();
      const row = rows[0];
      if (!row) throw errors.notFound('allowlist_entry_not_found', 'That allowlist entry does not exist.');
      await audit(req, 'outbound_allowlist.removed', { type: 'outbound_allowlist', id: input.id }, `Outbound destination removed (${row.scheme}://${row.host}:${row.port})`);
      return { deleted: true };
    });

    // --- AI providers -------------------------------------------------------------------------
    scope.get('/api/ai-providers', async (req): Promise<{ items: AiProvider[] }> => {
      const { db, clock } = req.server.fos;
      const rows = await db.select().from(aiProviders).orderBy(asc(aiProviders.name)).limit(100);
      if (rows.length === 0) return { items: [] };
      const monthStart = new Date(Date.UTC(clock.now().getUTCFullYear(), clock.now().getUTCMonth(), 1));
      const [secrets, usage] = await Promise.all([
        db.select({ aiProviderId: connectionSecrets.aiProviderId }).from(connectionSecrets).where(inArray(connectionSecrets.aiProviderId, rows.map((r) => r.id))),
        db.select({ providerId: aiUsage.providerId, costUsd: aiUsage.costUsd, occurredAt: aiUsage.occurredAt }).from(aiUsage).where(inArray(aiUsage.providerId, rows.map((r) => r.id))).limit(20_000),
      ]);
      const withSecret = new Set(secrets.map((s) => s.aiProviderId).filter((v): v is string => typeof v === 'string'));
      const spend = new Map<string, string[]>();
      for (const row of usage) {
        if (row.costUsd === null || row.occurredAt < monthStart) continue;
        const list = spend.get(row.providerId) ?? [];
        list.push(normalizeDecimal(row.costUsd));
        spend.set(row.providerId, list);
      }
      return {
        items: rows.map((row) => {
          const used = (spend.get(row.id) ?? []).reduce((acc, value) => acc.plus(dec(value)), dec('0'));
          return aiProviderView(row, withSecret.has(row.id), toDecimalString(used));
        }),
      };
    });

    scope.post('/api/ai-providers', async (req, reply): Promise<AiProvider> => {
      const input = parseBody(AiProviderInput, req.body);
      const { db } = req.server.fos;
      if (input.locality === 'cloud' && input.enabled) {
        const settings = await loadSettings(db);
        if (!settings.cloudAiAllowed) throw errors.conflict('cloud_ai_not_allowed', 'Cloud AI is switched off in settings. Enable it there first.');
      }
      const [row] = await db.insert(aiProviders).values({ ...input, taskRouting: [...input.taskRouting] }).returning();
      if (!row) throw new Error('ai provider insert returned no row');
      await audit(req, 'ai_provider.created', { type: 'ai_provider', id: row.id }, `AI provider added (${row.locality})`, { locality: row.locality, tasks: row.taskRouting });
      reply.code(201);
      return aiProviderView(row, false, '0');
    });

    scope.put('/api/ai-providers', async (req): Promise<AiProvider> => {
      const input = parseBody(AiProviderInput.partial().extend({ id: z.uuid() }), req.body);
      const { db, clock } = req.server.fos;
      const { id, taskRouting, ...rest } = input;
      const [row] = await db
        .update(aiProviders)
        .set({ ...rest, ...(taskRouting ? { taskRouting: [...taskRouting] } : {}), updatedAt: clock.now() })
        .where(eq(aiProviders.id, id))
        .returning();
      if (!row) throw errors.notFound('ai_provider_not_found', 'AI provider not found.');
      await audit(req, 'ai_provider.updated', { type: 'ai_provider', id }, 'AI provider updated', { fields: Object.keys(rest) });
      return aiProviderView(row, false, '0');
    });

    scope.put<{ Params: { id: string } }>('/api/ai-providers/:id/credentials', async (req): Promise<AiProvider> => {
      const id = requireUuid(req.params.id, 'ai_provider_not_found');
      const input = parseBody(CredentialInput, req.body);
      const { db, clock, keyring } = req.server.fos;
      const row = await loadOne(db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1), 'ai_provider_not_found', 'AI provider not found.');
      const now = clock.now();
      for (const [name, value] of Object.entries(input.secrets)) {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw errors.badRequest('Credential field names must be lower-case identifiers.');
        const ciphertext = keyring.encryptString(value, aiProviderSecretAad(id));
        await db
          .insert(connectionSecrets)
          .values({ aiProviderId: id, name, ciphertext, keyVersion: keyring.activeKid, updatedAt: now })
          .onConflictDoUpdate({
            target: [connectionSecrets.aiProviderId, connectionSecrets.name],
            targetWhere: sql`${connectionSecrets.aiProviderId} is not null`,
            set: { ciphertext, keyVersion: keyring.activeKid, updatedAt: now },
          });
      }
      await audit(req, 'ai_provider.credentials_stored', { type: 'ai_provider', id }, 'AI provider credentials stored (write-only)', { fields: Object.keys(input.secrets) });
      return aiProviderView(row, true, '0');
    });

    scope.post<{ Params: { id: string } }>('/api/ai-providers/:id/test', async (req): Promise<{ ok: boolean | null; detail: string; jobId: string }> => {
      const id = requireUuid(req.params.id, 'ai_provider_not_found');
      const { db } = req.server.fos;
      const row = await loadOne(db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1), 'ai_provider_not_found', 'AI provider not found.');
      const result = await enqueueJob(req, {
        queue: 'ai.task',
        label: `Test AI provider: ${row.name}`,
        data: { task: 'provider_test', providerId: id },
        singletonKey: `ai.task:provider_test:${id}`,
        cancellable: false,
        subjectType: 'ai_provider',
        subjectId: id,
      });
      await audit(req, 'ai_provider.test_requested', { type: 'ai_provider', id }, 'AI provider test scheduled', { jobId: result.jobId });
      // The outbound call happens in the worker, so the outcome is not known yet: it stays null.
      return { ok: null, detail: 'The provider test has been scheduled. Its result appears on the provider once the job finishes.', jobId: result.jobId };
    });
  });
}
