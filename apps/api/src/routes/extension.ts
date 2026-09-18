/**
 * Chrome extension endpoints.
 *
 * /api/ext/* is reachable only from configured `chrome-extension://<id>` origins and accepts only
 * device credentials (never the session cookie). CORS headers are a browser courtesy, not
 * authorization: every handler checks the Origin and the credential itself.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream, statSync } from 'node:fs';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { devicePairings, devices } from '@financialos/db';
import {
  DEVICE_SCOPES,
  DevicePrivacyInput,
  GlanceResponse,
  PairApproveInput,
  PairCompleteInput,
  PairStartInput,
  type Device,
  type PairCompleteResult,
  type PairStartResult,
  RevealableField,
} from '@financialos/contracts';
import {
  generatePrefixedCredential,
  generateUserCode,
  hmacSha256,
  isPrefixedCredential,
  normalizeUserCode,
  sha256Base64Url,
  sha256Hex,
  timingSafeEqualString,
} from '@financialos/security/tokens';
import { addSeconds } from '../clock';
import { ApiError, errors } from '../errors';
import { RATE_LIMITS } from '../plugins/rate-limit';
import { parseBody } from '../validation';
import { ownerSessionOf, registerOwnerRoutes } from '../auth/guards';
import { UUID_SHAPE } from '../auth/sessions';
import { sendSessionBoundDownload } from '../auth/streams';

export const PAIRING_TTL_SECONDS = 600;
export const PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_POLL_SECONDS = 3;
export const GLANCE_AUDIT_INTERVAL_MS = 3600_000;

type DeviceRow = typeof devices.$inferSelect;
type PairingRow = typeof devicePairings.$inferSelect;

function deviceView(row: DeviceRow): Device {
  return {
    id: row.id,
    label: row.label,
    kind: 'chrome_extension',
    extensionOrigin: row.extensionOrigin,
    scopes: row.scopes,
    revealedFields: row.revealedFields as RevealableField[],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastAccessAt: row.lastAccessAt ? row.lastAccessAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    accessCount: row.accessCount,
  };
}

function userCodeHash(pepper: Buffer, normalized: string): string {
  return hmacSha256(pepper, `pair-code:${normalized}`).toString('hex');
}

function deviceCredentialHash(credential: string): string {
  return sha256Hex(`device-credential:${credential}`);
}

/** The exact allowed extension origin of this request, or null. */
function extensionOriginOf(req: FastifyRequest): string | null {
  const origin = req.headers.origin;
  return typeof origin === 'string' && req.server.fos.extensionOrigins.includes(origin) ? origin : null;
}

function requireExtensionOrigin(req: FastifyRequest): string {
  const origin = extensionOriginOf(req);
  if (!origin) throw errors.origin();
  return origin;
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{8,200})$/.exec(header);
  return match?.[1] ?? null;
}

/** Device-credential guard for /api/ext/v1/*. */
async function requireDevice(req: FastifyRequest): Promise<DeviceRow> {
  const { db, clock, sessions } = req.server.fos;
  if (req.cookies[sessions.cookieName] !== undefined) {
    throw new ApiError(401, 'session_cookie_not_accepted', 'Extension endpoints do not accept browser sessions.');
  }
  const token = bearerToken(req);
  if (!token || !isPrefixedCredential(token, 'device')) {
    throw new ApiError(401, 'device_unauthorized', 'This device is not paired.');
  }
  const [row] = await db.select().from(devices).where(eq(devices.credentialHash, deviceCredentialHash(token))).limit(1);
  const now = clock.now();
  if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) {
    throw new ApiError(401, 'device_unauthorized', 'This device is not paired, was revoked, or its access expired.');
  }
  const origin = extensionOriginOf(req);
  if (!origin || origin !== row.extensionOrigin) throw errors.origin();
  req.device = { id: row.id, extensionOrigin: row.extensionOrigin, scopes: row.scopes, revealedFields: row.revealedFields };
  return row;
}

/** Removes every amount the device is not allowed to see, whatever the provider returned. */
export function maskGlance(glance: GlanceResponse, revealed: readonly string[]): GlanceResponse {
  const has = (f: RevealableField) => revealed.includes(f);
  const fields = (['safe_to_spend', 'budget_remaining', 'goal_amounts', 'due_amounts'] as const).filter(has);
  return {
    ...glance,
    privacy: { masked: fields.length === 0, revealedFields: fields },
    spending: {
      ...glance.spending,
      safeToSpend: has('safe_to_spend') ? glance.spending.safeToSpend : null,
      budgetRemaining: has('budget_remaining') ? glance.spending.budgetRemaining : null,
    },
    goals: glance.goals.slice(0, 3).map((g) => ({ ...g, amount: has('goal_amounts') ? g.amount : null })),
    dueSoon: { ...glance.dueSoon, total: has('due_amounts') ? glance.dueSoon.total : null },
  };
}

function applyExtensionCors(req: FastifyRequest, reply: FastifyReply): void {
  const origin = extensionOriginOf(req);
  reply.header('vary', 'Origin');
  if (origin) reply.header('access-control-allow-origin', origin);
}

export function registerExtensionRoutes(app: FastifyInstance): void {
  // --- /api/ext/*: extension origin only, device credentials only -------------------------
  app.register(async (ext) => {
    ext.addHook('onRequest', async (req, reply) => {
      applyExtensionCors(req, reply);
    });

    ext.options('/api/ext/*', async (req, reply) => {
      if (!extensionOriginOf(req)) throw errors.origin();
      return reply
        .code(204)
        .header('access-control-allow-methods', 'GET, POST')
        .header('access-control-allow-headers', 'Authorization, Content-Type')
        .header('access-control-max-age', '600')
        .send();
    });

    ext.post('/api/ext/pair/start', { config: { rateLimit: RATE_LIMITS.pairStart } }, async (req): Promise<PairStartResult> => {
      const extensionOrigin = requireExtensionOrigin(req);
      const { db, clock, pepper, audit, sessions } = req.server.fos;
      if (req.cookies[sessions.cookieName] !== undefined) {
        throw new ApiError(401, 'session_cookie_not_accepted', 'Extension endpoints do not accept browser sessions.');
      }
      const input = parseBody(PairStartInput, req.body);
      const now = clock.now();
      const userCode = generateUserCode();
      const expiresAt = addSeconds(now, PAIRING_TTL_SECONDS);
      const row = await db.transaction(async (tx) => {
        // One open pairing per installation.
        await tx
          .update(devicePairings)
          .set({ deniedAt: now })
          .where(
            and(
              eq(devicePairings.installationId, input.installationId),
              isNull(devicePairings.completedAt),
              isNull(devicePairings.deniedAt),
            ),
          );
        const [inserted] = await tx
          .insert(devicePairings)
          .values({
            installationId: input.installationId,
            verifierChallenge: input.verifierChallenge,
            userCodeHash: userCodeHash(pepper, userCode),
            deviceLabel: input.deviceLabel,
            extensionOrigin,
            extensionVersion: input.extensionVersion,
            createdAt: now,
            expiresAt,
          })
          .returning({ id: devicePairings.id });
        return inserted;
      });
      if (!row) throw new Error('pairing insert returned no row');
      await audit.fromRequest(req, 'device.pairing_started', { type: 'device_pairing', id: row.id }, 'Extension pairing requested', {
        extensionVersion: input.extensionVersion,
      });
      // Opportunistic cleanup.
      await db.delete(devicePairings).where(and(lt(devicePairings.expiresAt, addSeconds(now, -7 * 24 * 3600)), isNull(devicePairings.deviceId)));
      return { pairingId: row.id, userCode, expiresAt: expiresAt.toISOString(), approveUrlPath: '/settings/devices/pair' };
    });

    ext.post('/api/ext/pair/complete', { config: { rateLimit: RATE_LIMITS.pairComplete } }, async (req): Promise<PairCompleteResult> => {
      const extensionOrigin = requireExtensionOrigin(req);
      const { db, clock, audit, sessions } = req.server.fos;
      if (req.cookies[sessions.cookieName] !== undefined) {
        throw new ApiError(401, 'session_cookie_not_accepted', 'Extension endpoints do not accept browser sessions.');
      }
      const input = parseBody(PairCompleteInput, req.body);
      if (!UUID_SHAPE.test(input.pairingId)) throw errors.notFound('pairing_not_found', 'Pairing request not found.');
      const now = clock.now();
      const [pairing] = await db.select().from(devicePairings).where(eq(devicePairings.id, input.pairingId)).limit(1);
      if (!pairing) throw errors.notFound('pairing_not_found', 'Pairing request not found.');
      const bound =
        pairing.extensionOrigin === extensionOrigin &&
        timingSafeEqualString(pairing.installationId, input.installationId) &&
        timingSafeEqualString(pairing.verifierChallenge, sha256Base64Url(input.verifier));
      if (!bound) {
        const attempts = pairing.attempts + 1;
        await db
          .update(devicePairings)
          .set({ attempts, ...(attempts >= PAIRING_MAX_ATTEMPTS && !pairing.completedAt ? { deniedAt: now } : {}) })
          .where(eq(devicePairings.id, pairing.id));
        await audit.fromRequest(req, 'device.pairing_proof_failed', { type: 'device_pairing', id: pairing.id }, 'Pairing completion with wrong installation proof');
        throw errors.forbidden('pairing_proof_invalid', 'This pairing request belongs to another installation.');
      }
      if (pairing.completedAt) throw errors.conflict('pairing_already_completed', 'This pairing was already completed.');
      if (pairing.deniedAt) return { status: 'denied' };
      if (pairing.expiresAt.getTime() <= now.getTime()) return { status: 'expired' };
      if (!pairing.approvedAt) return { status: 'pending', retryAfterSeconds: PAIRING_POLL_SECONDS };

      const credential = generatePrefixedCredential('device');
      const expiresAt = addSeconds(now, (pairing.approvedExpiresDays ?? 30) * 24 * 3600);
      const device = await db.transaction(async (tx) => {
        const claimed = await tx
          .update(devicePairings)
          .set({ completedAt: now })
          .where(and(eq(devicePairings.id, pairing.id), isNull(devicePairings.completedAt), isNull(devicePairings.deniedAt), gt(devicePairings.expiresAt, now)))
          .returning({ id: devicePairings.id });
        if (claimed.length !== 1) return null;
        const [created] = await tx
          .insert(devices)
          .values({
            label: pairing.approvedLabel ?? pairing.deviceLabel,
            kind: 'chrome_extension',
            extensionOrigin: pairing.extensionOrigin,
            installationId: pairing.installationId,
            credentialHash: deviceCredentialHash(credential),
            scopes: [...DEVICE_SCOPES],
            revealedFields: [],
            createdAt: now,
            expiresAt,
          })
          .returning();
        if (!created) throw new Error('device insert returned no row');
        await tx.update(devicePairings).set({ deviceId: created.id }).where(eq(devicePairings.id, pairing.id));
        return created;
      });
      if (!device) throw errors.conflict('pairing_already_completed', 'This pairing was already completed.');
      req.device = { id: device.id, extensionOrigin: device.extensionOrigin, scopes: device.scopes, revealedFields: device.revealedFields };
      await audit.fromRequest(req, 'device.paired', { type: 'device', id: device.id }, `Extension device paired (${device.label})`, {
        expiresAt: device.expiresAt.toISOString(),
      });
      return { status: 'approved', deviceId: device.id, credential, expiresAt: device.expiresAt.toISOString(), scopes: device.scopes };
    });

    ext.get('/api/ext/v1/glance', { config: { rateLimit: RATE_LIMITS.glance } }, async (req): Promise<GlanceResponse> => {
      const device = await requireDevice(req);
      if (!device.scopes.includes('glance:read')) throw errors.forbidden('insufficient_scope', 'This device may not read the glance.');
      const { db, clock, providers, audit } = req.server.fos;
      const now = clock.now();
      const revealed = device.revealedFields.filter((f): f is RevealableField => RevealableField.safeParse(f).success);
      const raw = await providers.glance.getGlance({ revealedFields: revealed, now, deviceId: device.id });
      const parsed = GlanceResponse.safeParse(maskGlance(raw, revealed));
      if (!parsed.success) {
        req.log.error({ issues: parsed.error.issues.map((i) => i.path.join('.')) }, 'glance provider returned an invalid response');
        throw new ApiError(500, 'glance_unavailable', 'The summary is not available right now.');
      }
      await db
        .update(devices)
        .set({ lastAccessAt: now, accessCount: sql`${devices.accessCount} + 1` })
        .where(eq(devices.id, device.id));
      if (!device.lastAccessAt || now.getTime() - device.lastAccessAt.getTime() >= GLANCE_AUDIT_INTERVAL_MS) {
        await audit.fromRequest(req, 'device.glance_read', { type: 'device', id: device.id }, 'Extension read the glance summary', {
          revealedFields: revealed,
        });
      }
      return parsed.data;
    });
  });

  // --- Owner-side device management -----------------------------------------------------
  registerOwnerRoutes(app, (scope) => {
    scope.post('/api/devices/pair/approve', { config: { rateLimit: RATE_LIMITS.pairApprove } }, async (req) => {
      const input = parseBody(PairApproveInput, req.body);
      const { db, clock, pepper, audit } = req.server.fos;
      const now = clock.now();
      const normalized = normalizeUserCode(input.userCode);
      const open = and(isNull(devicePairings.approvedAt), isNull(devicePairings.deniedAt), isNull(devicePairings.completedAt), gt(devicePairings.expiresAt, now));
      const [approved] = normalized
        ? await db
            .update(devicePairings)
            .set({ approvedAt: now, approvedLabel: input.deviceLabel, approvedExpiresDays: input.expiresInDays })
            .where(and(eq(devicePairings.userCodeHash, userCodeHash(pepper, normalized)), open, lt(devicePairings.attempts, PAIRING_MAX_ATTEMPTS)))
            .returning()
        : [];
      if (!approved) {
        // A wrong code counts against every open pairing; after five misses they are denied.
        await db
          .update(devicePairings)
          .set({ attempts: sql`${devicePairings.attempts} + 1` })
          .where(open);
        await db
          .update(devicePairings)
          .set({ deniedAt: now })
          .where(and(open, sql`${devicePairings.attempts} >= ${PAIRING_MAX_ATTEMPTS}`));
        await audit.fromRequest(req, 'device.pairing_approve_failed', { type: 'device_pairing' }, 'Pairing approval with an unknown or expired code');
        throw errors.notFound('pairing_code_invalid', 'That code does not match an open pairing request. Check the code shown in the extension.');
      }
      await audit.fromRequest(req, 'device.pairing_approved', { type: 'device_pairing', id: approved.id }, `Extension pairing approved (${input.deviceLabel})`, {
        expiresInDays: input.expiresInDays,
        session: ownerSessionOf(req).id,
      });
      return pairingApprovalView(approved);
    });

    scope.post('/api/devices/pair/deny', { config: { rateLimit: RATE_LIMITS.pairApprove } }, async (req) => {
      const input = parseBody(z.object({ userCode: PairApproveInput.shape.userCode }), req.body);
      const { db, clock, pepper, audit } = req.server.fos;
      const now = clock.now();
      const normalized = normalizeUserCode(input.userCode);
      const rows = normalized
        ? await db
            .update(devicePairings)
            .set({ deniedAt: now })
            .where(and(eq(devicePairings.userCodeHash, userCodeHash(pepper, normalized)), isNull(devicePairings.completedAt), isNull(devicePairings.deniedAt)))
            .returning({ id: devicePairings.id })
        : [];
      if (rows.length === 0) throw errors.notFound('pairing_code_invalid', 'That code does not match an open pairing request.');
      await audit.fromRequest(req, 'device.pairing_denied', { type: 'device_pairing', id: rows[0]?.id ?? null }, 'Extension pairing denied');
      return { status: 'denied' as const };
    });

    scope.get('/api/devices', async (req): Promise<Device[]> => {
      const rows = await req.server.fos.db.select().from(devices).orderBy(desc(devices.createdAt)).limit(200);
      return rows.map(deviceView);
    });

    scope.put<{ Params: { id: string } }>('/api/devices/:id/privacy', async (req): Promise<Device> => {
      if (!UUID_SHAPE.test(req.params.id)) throw errors.notFound();
      const input = parseBody(DevicePrivacyInput, req.body);
      const { db, audit } = req.server.fos;
      const fields = [...new Set(input.revealedFields)];
      const [row] = await db
        .update(devices)
        .set({ revealedFields: fields })
        .where(and(eq(devices.id, req.params.id), isNull(devices.revokedAt)))
        .returning();
      if (!row) throw errors.notFound('device_not_found', 'Device not found or revoked.');
      await audit.fromRequest(req, 'device.privacy_changed', { type: 'device', id: row.id }, `Extension amount visibility changed (${fields.length ? fields.join(', ') : 'all masked'})`, {
        revealedFields: fields,
        acknowledgedRisk: true,
      });
      return deviceView(row);
    });

    scope.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async (req): Promise<Device> => {
      if (!UUID_SHAPE.test(req.params.id)) throw errors.notFound();
      const { db, clock, audit } = req.server.fos;
      const now = clock.now();
      const [row] = await db
        .update(devices)
        .set({ revokedAt: sql`coalesce(${devices.revokedAt}, ${now.toISOString()}::timestamptz)` })
        .where(eq(devices.id, req.params.id))
        .returning();
      if (!row) throw errors.notFound('device_not_found', 'Device not found.');
      await audit.fromRequest(req, 'device.revoked', { type: 'device', id: row.id }, `Extension device revoked (${row.label})`);
      return deviceView(row);
    });

    scope.post('/api/devices/revoke-all', async (req) => {
      const { db, clock, audit } = req.server.fos;
      const rows = await db
        .update(devices)
        .set({ revokedAt: clock.now() })
        .where(isNull(devices.revokedAt))
        .returning({ id: devices.id });
      await audit.fromRequest(req, 'device.revoked_all', { type: 'device' }, 'All extension devices revoked', { count: rows.length });
      return { revoked: rows.length };
    });

    scope.get('/api/extension/package', async (req, reply) => {
      const { config, audit } = req.server.fos;
      let size: number;
      try {
        const st = statSync(config.extensionPackagePath);
        if (!st.isFile()) throw new Error('not a file');
        size = st.size;
      } catch {
        throw errors.notFound('extension_package_missing', 'The extension package has not been built on this server yet.');
      }
      await audit.fromRequest(req, 'extension.package_downloaded', { type: 'extension_package' }, 'Extension package downloaded', { sizeBytes: size });
      return sendSessionBoundDownload(req, reply, {
        stream: createReadStream(config.extensionPackagePath),
        filename: 'financialos-new-tab.zip',
        contentType: 'application/zip',
        size,
      });
    });
  });
}

/**
 * Approval result. The device itself (and its credential) is created only when the extension
 * completes the pairing with its installation proof.
 */
function pairingApprovalView(row: PairingRow) {
  return {
    pairingId: row.id,
    status: 'approved' as const,
    deviceLabel: row.approvedLabel ?? row.deviceLabel,
    expiresInDays: row.approvedExpiresDays ?? 30,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    extensionVersion: row.extensionVersion,
  };
}
