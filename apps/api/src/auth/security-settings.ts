import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ownerAccount, recoveryCodes } from '@financialos/db';
import {
  PasswordChangeInput,
  SESSION_ABSOLUTE_SECONDS,
  type PasskeyCredential,
  type RecoveryCodes,
  type SecurityOverview,
} from '@financialos/contracts';
import { ApiError, errors } from '../errors';
import { parseBody } from '../validation';
import { hashClientIp } from './audit';
import { ownerSessionOf, registerOwnerRoutes } from './guards';
import { checkOwnerTotp } from './login';
import { PASSWORD_PROBLEM_MESSAGES, hashPassword, passwordProblem, verifyPassword } from './passwords';
import { hashRecoveryCode, newRecoveryCodes } from './recovery';
import { UUID_SHAPE } from './sessions';
import { getOwner } from './store';
import { POLICIES } from './throttle';
import { relyingPartyFor, type CredentialRow } from './webauthn';

const TotpOnlyInput = z.object({ totpCode: z.string().regex(/^\d{6}$/) });
const IdleTimeoutInput = z.object({ seconds: z.number().int().min(60).max(600) });

function passkeyView(row: CredentialRow): PasskeyCredential {
  return {
    id: row.id,
    name: row.name,
    rpId: row.rpId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    backedUp: row.backedUp,
  };
}

function reauthKey(req: FastifyRequest): string {
  return `reauth:${hashClientIp(req.server.fos.pepper, req.ip) ?? 'unknown'}`;
}

/** Re-authentication inside a session is throttled like sign-in. */
async function withReauthThrottle(req: FastifyRequest, action: string, check: () => Promise<boolean>): Promise<void> {
  const { throttle, audit } = req.server.fos;
  const key = reauthKey(req);
  const state = await throttle.check([key]);
  if (state.locked) throw errors.tooManyAttempts(state.retryAfterSeconds);
  if (!(await check())) {
    await throttle.recordFailure(key, POLICIES.reauth);
    await audit.fromRequest(req, `${action}_failed`, { type: 'owner' }, 'Re-authentication failed');
    throw new ApiError(401, 'reauthentication_failed', 'The details you entered are not correct.');
  }
  await throttle.reset([key]);
}

export function registerSecuritySettingsRoutes(app: FastifyInstance): void {
  registerOwnerRoutes(app, (scope) => {
    scope.get('/api/security', async (req): Promise<SecurityOverview> => {
      const { db, webauthn, sessions } = req.server.fos;
      const current = ownerSessionOf(req);
      const [owner, passkeys, recent, idle, remaining] = await Promise.all([
        getOwner(db),
        webauthn.activeCredentials(),
        sessions.listRecent(20),
        sessions.idleTimeoutSeconds(),
        db.select({ n: count() }).from(recoveryCodes).where(isNull(recoveryCodes.usedAt)),
      ]);
      return {
        passkeys: passkeys.map(passkeyView),
        totpEnabled: Boolean(owner?.totpEnabledAt),
        recoveryCodesRemaining: Number(remaining[0]?.n ?? 0),
        sessions: recent.map((s) => ({
          id: s.id,
          current: s.id === current.id,
          authMethod: s.authMethod,
          createdAt: s.authenticatedAt.toISOString(),
          absoluteExpiresAt: s.absoluteExpiresAt.toISOString(),
          userAgent: s.userAgent,
          revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
          revokeReason: s.revokeReason,
        })),
        idleTimeoutSeconds: idle,
        absoluteTimeoutSeconds: SESSION_ABSOLUTE_SECONDS,
      };
    });

    scope.post('/api/security/passkeys/options', async (req) => {
      const { db, webauthn } = req.server.fos;
      const owner = await getOwner(db);
      if (!owner) throw errors.conflict('owner_missing', 'No owner account exists.');
      return webauthn.registrationOptions(owner, relyingPartyFor(req), `security:${ownerSessionOf(req).id}`);
    });

    scope.post('/api/security/passkeys/verify', async (req): Promise<PasskeyCredential> => {
      const { webauthn, audit } = req.server.fos;
      const row = await webauthn.verifyRegistration(req.body, relyingPartyFor(req), `security:${ownerSessionOf(req).id}`, 'Passkey');
      await audit.fromRequest(req, 'security.passkey_added', { type: 'webauthn_credential', id: row.id }, 'Passkey added', { rpId: row.rpId });
      return passkeyView(row);
    });

    scope.delete<{ Params: { id: string } }>('/api/security/passkeys/:id', async (req, reply) => {
      const { db, webauthn, audit } = req.server.fos;
      if (!UUID_SHAPE.test(req.params.id)) throw errors.notFound();
      const owner = await getOwner(db);
      // Password + TOTP must remain available as the portable sign-in path.
      if (!owner?.totpEnabledAt || !owner.passwordHash) {
        throw errors.conflict('last_factor', 'Another sign-in method must remain before removing this passkey.');
      }
      if (!(await webauthn.revoke(req.params.id))) throw errors.notFound();
      await audit.fromRequest(req, 'security.passkey_removed', { type: 'webauthn_credential', id: req.params.id }, 'Passkey removed');
      return reply.code(204).send();
    });

    scope.post('/api/security/recovery-codes', async (req): Promise<RecoveryCodes> => {
      const input = parseBody(TotpOnlyInput, req.body);
      await withReauthThrottle(req, 'security.recovery_codes', () => checkOwnerTotp(req, input.totpCode));
      const { db, clock, pepper, audit } = req.server.fos;
      const codes = newRecoveryCodes();
      const batchId = randomUUID();
      const now = clock.now();
      await db.transaction(async (tx) => {
        await tx.delete(recoveryCodes);
        await tx.insert(recoveryCodes).values(codes.map((code) => ({ batchId, codeHash: hashRecoveryCode(pepper, code), createdAt: now })));
      });
      await audit.fromRequest(req, 'security.recovery_codes_regenerated', { type: 'recovery_codes', id: batchId }, 'Recovery codes regenerated; old codes invalidated');
      return { codes };
    });

    scope.post('/api/security/password', async (req, reply) => {
      const input = parseBody(PasswordChangeInput, req.body);
      const { db, clock, sessions, audit } = req.server.fos;
      const owner = await getOwner(db);
      if (!owner?.passwordHash) throw errors.conflict('owner_missing', 'No owner account exists.');
      const passwordHash = owner.passwordHash;
      await withReauthThrottle(req, 'security.password_change', async () => {
        const passwordOk = await verifyPassword(passwordHash, input.currentPassword);
        // Check the code only after the password so failed guesses do not burn TOTP steps.
        return passwordOk && (await checkOwnerTotp(req, input.totpCode));
      });
      const problem = passwordProblem(input.newPassword, [owner.displayName, 'financialos']);
      if (problem) throw new ApiError(400, `password_${problem}`, PASSWORD_PROBLEM_MESSAGES[problem]);
      if (await verifyPassword(passwordHash, input.newPassword)) {
        throw new ApiError(400, 'password_unchanged', 'Choose a password different from the current one.');
      }
      const newHash = await hashPassword(input.newPassword);
      const now = clock.now();
      const current = ownerSessionOf(req);
      const revoked = await db.transaction(async (tx) => {
        await tx.update(ownerAccount).set({ passwordHash: newHash, passwordChangedAt: now, updatedAt: now }).where(eq(ownerAccount.id, owner.id));
        return sessions.revokeAll('password_changed', { exceptId: current.id, tx });
      });
      await audit.fromRequest(req, 'security.password_changed', { type: 'owner', id: owner.id }, 'Password changed; other sessions revoked', { revoked });
      return reply.code(204).send();
    });

    scope.delete<{ Params: { id: string } }>('/api/security/sessions/:id', async (req, reply) => {
      const { sessions, audit } = req.server.fos;
      if (!UUID_SHAPE.test(req.params.id)) throw errors.notFound();
      const revoked = await sessions.revoke(req.params.id, 'revoked_by_owner');
      if (!revoked && !(await sessions.findById(req.params.id))) throw errors.notFound();
      if (req.params.id === ownerSessionOf(req).id) sessions.clearCookie(reply);
      await audit.fromRequest(req, 'security.session_revoked', { type: 'session', id: req.params.id }, 'Session revoked');
      return reply.code(204).send();
    });

    scope.put('/api/security/idle-timeout', async (req) => {
      const input = parseBody(IdleTimeoutInput, req.body);
      const { settings, audit } = req.server.fos;
      await settings.setIdleTimeoutSeconds(input.seconds);
      await audit.fromRequest(req, 'security.idle_timeout_changed', { type: 'setting', id: 'idleTimeoutSeconds' }, `Idle timeout set to ${input.seconds} s`);
      return { idleTimeoutSeconds: input.seconds };
    });
  });
}
