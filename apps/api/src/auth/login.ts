import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, count, eq, isNull, lt, or } from 'drizzle-orm';
import { ownerAccount, recoveryCodes, type DbOrTx } from '@financialos/db';
import { PasskeyLoginFinishInput, PasswordLoginInput, type LoginResult, type SessionInfo } from '@financialos/contracts';
import { errors } from '../errors';
import { RATE_LIMITS } from '../plugins/rate-limit';
import { parseBody } from '../validation';
import { hashClientIp } from './audit';
import { requireOwner, ownerSessionOf } from './guards';
import { completeLaunchAfterLogin } from './launch';
import { verifyPassword } from './passwords';
import { recoveryCodeLookupHash } from './recovery';
import type { AuthMethod } from './sessions';
import { getOwner, getSetupState } from './store';
import { POLICIES } from './throttle';
import { TOTP_AAD, verifyTotp } from './totp';
import { relyingPartyFor } from './webauthn';

export function loginThrottleKeys(req: FastifyRequest): { client: string; global: string } {
  const ipHash = hashClientIp(req.server.fos.pepper, req.ip) ?? 'unknown';
  return { client: `login:client:${ipHash}`, global: 'login:global' };
}

async function enforceLoginThrottle(req: FastifyRequest): Promise<{ client: string; global: string }> {
  const keys = loginThrottleKeys(req);
  const state = await req.server.fos.throttle.check([keys.client, keys.global]);
  if (state.locked) {
    await req.server.fos.audit.fromRequest(req, 'auth.login_locked', { type: 'owner' }, 'Sign-in refused while locked out', {
      retryAfterSeconds: state.retryAfterSeconds,
    });
    throw errors.tooManyAttempts(state.retryAfterSeconds);
  }
  return keys;
}

async function recordLoginFailure(req: FastifyRequest, keys: { client: string; global: string }, method: string, reason: string): Promise<never> {
  const { throttle, audit } = req.server.fos;
  await throttle.recordFailure(keys.client, POLICIES.loginClient);
  await throttle.recordFailure(keys.global, POLICIES.loginGlobal);
  await audit.fromRequest(req, 'auth.login_failed', { type: 'owner' }, `Sign-in failed (${method})`, { method, reason });
  throw errors.invalidCredentials();
}

/** Consumes a TOTP step exactly once, even under concurrent requests. */
async function claimTotpStep(db: DbOrTx, ownerId: string, step: number): Promise<boolean> {
  const rows = await db
    .update(ownerAccount)
    .set({ totpLastUsedStep: step })
    .where(and(eq(ownerAccount.id, ownerId), or(isNull(ownerAccount.totpLastUsedStep), lt(ownerAccount.totpLastUsedStep, step))))
    .returning({ id: ownerAccount.id });
  return rows.length === 1;
}

async function unusedRecoveryCodeCount(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ n: count() }).from(recoveryCodes).where(isNull(recoveryCodes.usedAt));
  return Number(row?.n ?? 0);
}

/**
 * Verifies a TOTP code for the owner with replay protection. Shared by login and
 * re-authentication inside a session.
 */
export async function checkOwnerTotp(req: FastifyRequest, code: string): Promise<boolean> {
  const { db, keyring, clock } = req.server.fos;
  const owner = await getOwner(db);
  if (!owner?.totpSecretCiphertext || !owner.totpEnabledAt) return false;
  const secret = keyring.decryptString(owner.totpSecretCiphertext, TOTP_AAD);
  const check = await verifyTotp(secret, code, clock.now(), owner.totpLastUsedStep);
  return check.ok && (await claimTotpStep(db, owner.id, check.step));
}

export async function ownerSessionInfo(req: FastifyRequest): Promise<SessionInfo> {
  const { db, sessions, settings } = req.server.fos;
  const owner = await getOwner(db);
  return sessions.toInfo(ownerSessionOf(req), owner?.displayName ?? 'Owner', await settings.getPrivacyModeDefault());
}

/** Creates the new session (revoking all others), completes a pending launch, and sets the cookie. */
async function startSession(req: FastifyRequest, reply: FastifyReply, authMethod: AuthMethod, launchId: string | undefined): Promise<LoginResult> {
  const { db, sessions, audit, pepper, webauthn } = req.server.fos;
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
  const { token, row, redirectTo } = await db.transaction(async (tx) => {
    const created = await sessions.create({ authMethod, userAgent, ipHash: hashClientIp(pepper, req.ip), origin }, tx);
    const redirect = await completeLaunchAfterLogin(req, reply, launchId, created.row, tx);
    await audit.record(
      {
        actorType: 'owner',
        actorId: `session:${created.row.id}`,
        action: 'auth.login_succeeded',
        object: { type: 'session', id: created.row.id },
        summary: `Signed in (${authMethod})`,
        details: { authMethod, launch: redirect !== null },
        requestId: String(req.id),
        ipHash: hashClientIp(pepper, req.ip),
      },
      tx,
    );
    return { ...created, redirectTo: redirect };
  });
  sessions.setCookie(reply, token, row.absoluteExpiresAt);
  req.session = sessions.toOwnerSession(row);
  try {
    await sessions.housekeeping();
    await webauthn.housekeeping();
  } catch (err) {
    req.log.warn({ err }, 'session housekeeping failed');
  }
  return { session: await ownerSessionInfo(req), redirectTo };
}

async function requireSealed(req: FastifyRequest): Promise<void> {
  const state = await getSetupState(req.server.fos.db);
  if (state?.state !== 'sealed') throw errors.conflict('setup_incomplete', 'Finish setup before signing in.');
}

export function registerLoginRoutes(app: FastifyInstance): void {
  const limited = { config: { rateLimit: RATE_LIMITS.auth } };

  app.post('/api/auth/login/password', limited, async (req, reply) => {
    const input = parseBody(PasswordLoginInput, req.body);
    const keys = await enforceLoginThrottle(req);
    const { db, clock, pepper, audit, dummyPasswordHash } = req.server.fos;
    const [setup, owner] = await Promise.all([getSetupState(db), getOwner(db)]);
    // Always do the expensive hash so timing does not reveal whether an owner exists.
    const passwordOk = owner?.passwordHash
      ? await verifyPassword(owner.passwordHash, input.password)
      : (await verifyPassword(dummyPasswordHash, input.password)) && false;
    const hasTotp = Boolean(input.totpCode);
    const hasRecovery = Boolean(input.recoveryCode);
    const method = hasRecovery ? 'password_recovery_code' : 'password_totp';
    if (!passwordOk || !owner || setup?.state !== 'sealed') return recordLoginFailure(req, keys, method, 'password');
    if (hasTotp === hasRecovery) return recordLoginFailure(req, keys, method, 'second_factor_missing');

    let recoveryCodesRemaining: number | null = null;
    if (hasTotp) {
      if (!(await checkOwnerTotp(req, input.totpCode as string))) return recordLoginFailure(req, keys, method, 'totp');
    } else {
      const lookup = recoveryCodeLookupHash(pepper, input.recoveryCode as string);
      const used = lookup
        ? await db
            .update(recoveryCodes)
            .set({ usedAt: clock.now() })
            .where(and(eq(recoveryCodes.codeHash, lookup), isNull(recoveryCodes.usedAt)))
            .returning({ id: recoveryCodes.id, batchId: recoveryCodes.batchId })
        : [];
      if (used.length !== 1) return recordLoginFailure(req, keys, method, 'recovery_code');
      recoveryCodesRemaining = await unusedRecoveryCodeCount(db);
      await audit.fromRequest(req, 'auth.recovery_code_used', { type: 'recovery_code', id: used[0]?.id ?? null }, 'A recovery code was used to sign in', {
        remaining: recoveryCodesRemaining,
      });
    }
    await req.server.fos.throttle.reset([keys.client, keys.global]);
    const result = await startSession(req, reply, method, input.launchId);
    return recoveryCodesRemaining === null ? result : { ...result, recoveryCodesRemaining };
  });

  app.post('/api/auth/passkey/options', limited, async (req) => {
    await enforceLoginThrottle(req);
    await requireSealed(req);
    return req.server.fos.webauthn.authenticationOptions(relyingPartyFor(req));
  });

  app.post('/api/auth/passkey/verify', limited, async (req, reply) => {
    const input = parseBody(PasskeyLoginFinishInput, req.body);
    const keys = await enforceLoginThrottle(req);
    await requireSealed(req);
    const rp = relyingPartyFor(req);
    const result = await req.server.fos.webauthn.verifyAuthentication(input.response, rp);
    if (!result.ok) {
      if (result.reason === 'counter_regression') {
        await req.server.fos.audit.fromRequest(
          req,
          'auth.passkey_counter_regression',
          { type: 'webauthn_credential', id: result.credentialId },
          'Warning: passkey signature counter went backwards (possible cloned authenticator); sign-in refused',
          { rpId: rp.rpId },
        );
      }
      return recordLoginFailure(req, keys, 'passkey', result.reason);
    }
    await req.server.fos.throttle.reset([keys.client, keys.global]);
    return startSession(req, reply, 'passkey', input.launchId);
  });

  // Never counts as activity (see isBackgroundRequest).
  app.get('/api/auth/session', { onRequest: requireOwner }, async (req) => ownerSessionInfo(req));

  app.post('/api/auth/logout', { onRequest: requireOwner }, async (req, reply) => {
    const { sessions, audit } = req.server.fos;
    const session = ownerSessionOf(req);
    await sessions.revoke(session.id, 'logout');
    sessions.clearCookie(reply);
    await audit.fromRequest(req, 'auth.logout', { type: 'session', id: session.id }, 'Signed out');
    return reply.code(204).header('clear-site-data', '"cache"').send();
  });

  app.post('/api/auth/logout-all', { onRequest: requireOwner }, async (req, reply) => {
    const { sessions, audit } = req.server.fos;
    const revoked = await sessions.revokeAll('logout_all');
    sessions.clearCookie(reply);
    await audit.fromRequest(req, 'auth.logout_all', { type: 'session' }, 'Signed out everywhere', { revoked });
    return reply.code(204).header('clear-site-data', '"cache"').send();
  });
}
