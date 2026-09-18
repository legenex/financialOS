/**
 * One-time owner bootstrap.
 *
 *   awaiting_bootstrap_secret --begin(secret)--> in_progress --seal--> sealed
 *
 * The bootstrap secret is generated on the host; only its SHA-256 is given to the server. A
 * correct secret is consumed immediately and exchanged for a 30-minute setup cookie. Setup
 * creates exactly one owner; there is no public registration. After sealing, every setup
 * endpoint except status answers 410, and sealing does not sign anyone in.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { ownerAccount, recoveryCodes, setupState, type DbOrTx } from '@financialos/db';
import { SetupBeginInput, SetupOwnerInput, TotpVerifyInput, type RecoveryCodes, type SetupStatus, type TotpEnrollment } from '@financialos/contracts';
import { randomToken, sha256Hex, timingSafeEqualHex } from '@financialos/security/tokens';
import { randomUUID } from 'node:crypto';
import { addSeconds } from '../clock';
import { ApiError, errors } from '../errors';
import { parseBody } from '../validation';
import { RATE_LIMITS } from '../plugins/rate-limit';
import { PASSWORD_PROBLEM_MESSAGES, hashPassword, passwordProblem } from './passwords';
import { hashRecoveryCode, newRecoveryCodes } from './recovery';
import { getOwner, getSetupState, type OwnerRow, type SetupStateRow } from './store';
import { TOTP_AAD, formatManualKey, newTotpSecret, totpQrSvg, totpUri, verifyTotp } from './totp';
import { relyingPartyFor } from './webauthn';

export const SETUP_COOKIE = '__Host-fos_setup';
export const SETUP_TOKEN_TTL_SECONDS = 30 * 60;
export const SETUP_MAX_FAILURES = 5;
export const SETUP_LOCK_SECONDS = 15 * 60;

function hashSetupToken(token: string): string {
  return sha256Hex(`setup-token:${token}`);
}

/** Relying party shown in status: the request origin when it is configured, else the canonical origin. */
function displayedOrigin(req: FastifyRequest): string {
  const { allowedOrigins, canonicalOrigin } = req.server.fos.config;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && allowedOrigins.includes(origin)) return origin;
  return canonicalOrigin;
}

function statusOf(req: FastifyRequest, state: SetupStateRow | null): SetupStatus {
  const origin = displayedOrigin(req);
  return {
    state: state?.state ?? 'awaiting_bootstrap_secret',
    steps: {
      owner: Boolean(state?.ownerCreatedAt),
      totp: Boolean(state?.totpVerifiedAt),
      recoveryCodes: Boolean(state?.recoveryCodesIssuedAt),
      passkey: Boolean(state?.passkeyEnrolledAt),
    },
    rpId: new URL(origin).hostname,
    origin,
  };
}

function setSetupCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SETUP_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: SETUP_TOKEN_TTL_SECONDS });
}

function clearSetupCookie(reply: FastifyReply): void {
  reply.clearCookie(SETUP_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
}

/** Guard for setup steps: setup must be in progress and the setup cookie must match. */
async function requireSetupToken(req: FastifyRequest, reply: FastifyReply): Promise<SetupStateRow> {
  const { db, clock } = req.server.fos;
  const state = await getSetupState(db);
  if (!state || state.state === 'awaiting_bootstrap_secret') {
    throw new ApiError(401, 'setup_not_started', 'Enter the bootstrap secret to start setup.');
  }
  if (state.state === 'sealed') {
    clearSetupCookie(reply);
    throw errors.gone();
  }
  const token = req.cookies[SETUP_COOKIE];
  const now = clock.now();
  const valid =
    typeof token === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(token) &&
    state.setupTokenHash !== null &&
    state.setupTokenExpiresAt !== null &&
    now.getTime() < state.setupTokenExpiresAt.getTime() &&
    timingSafeEqualHex(hashSetupToken(token), state.setupTokenHash);
  if (!valid) {
    clearSetupCookie(reply);
    throw new ApiError(401, 'setup_token_invalid', 'The setup session has ended. Ask the operator to restart setup.');
  }
  return state;
}

async function requireOwnerRow(db: DbOrTx): Promise<OwnerRow> {
  const owner = await getOwner(db);
  if (!owner) throw errors.conflict('setup_owner_missing', 'Create the owner account first.');
  return owner;
}

export function registerSetupRoutes(app: FastifyInstance): void {
  const limited = { config: { rateLimit: RATE_LIMITS.setup } };

  app.get('/api/setup/status', limited, async (req) => {
    return statusOf(req, await getSetupState(req.server.fos.db));
  });

  // Every setup endpoint except status is gone once setup is sealed.
  app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      const state = await getSetupState(req.server.fos.db);
      if (state?.state === 'sealed') {
        clearSetupCookie(reply);
        throw errors.gone();
      }
    });

    scope.post('/api/setup/begin', limited, async (req, reply) => {
      const { db, clock, audit } = req.server.fos;
      const input = parseBody(SetupBeginInput, req.body);
      const now = clock.now();
      const state = await getSetupState(db);
      if (!state) throw errors.unavailable('setup_unavailable', 'Setup is not available.');
      if (state.state !== 'awaiting_bootstrap_secret') {
        throw errors.conflict('setup_already_started', 'Setup has already started. The bootstrap secret cannot be used again.');
      }
      if (state.lockedUntil && state.lockedUntil.getTime() > now.getTime()) {
        await audit.fromRequest(req, 'setup.begin_locked', { type: 'setup' }, 'Setup attempt refused while locked');
        throw errors.tooManyAttempts((state.lockedUntil.getTime() - now.getTime()) / 1000);
      }
      if (!state.bootstrapSecretHash) {
        throw errors.unavailable('setup_unavailable', 'No bootstrap secret is configured. Ask the operator to generate one.');
      }
      const matches = timingSafeEqualHex(sha256Hex(input.bootstrapSecret), state.bootstrapSecretHash);
      if (!matches) {
        const failures = state.failedAttempts + 1;
        const lock = failures >= SETUP_MAX_FAILURES;
        await db
          .update(setupState)
          .set({
            failedAttempts: lock ? 0 : failures,
            lockedUntil: lock ? addSeconds(now, SETUP_LOCK_SECONDS) : state.lockedUntil,
            updatedAt: now,
          })
          .where(and(eq(setupState.id, 1), eq(setupState.state, 'awaiting_bootstrap_secret')));
        await audit.fromRequest(req, 'setup.begin_failed', { type: 'setup' }, lock ? 'Wrong bootstrap secret; setup locked for 15 minutes' : 'Wrong bootstrap secret', {
          failures,
          locked: lock,
        });
        if (lock) throw errors.tooManyAttempts(SETUP_LOCK_SECONDS);
        throw new ApiError(401, 'bootstrap_secret_invalid', 'The bootstrap secret is not correct.');
      }
      const token = randomToken(32);
      const [updated] = await db
        .update(setupState)
        .set({
          state: 'in_progress',
          bootstrapConsumedAt: now,
          bootstrapSecretHash: null,
          setupTokenHash: hashSetupToken(token),
          setupTokenExpiresAt: addSeconds(now, SETUP_TOKEN_TTL_SECONDS),
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(and(eq(setupState.id, 1), eq(setupState.state, 'awaiting_bootstrap_secret')))
        .returning();
      if (!updated) throw errors.conflict('setup_already_started', 'Setup has already started. The bootstrap secret cannot be used again.');
      setSetupCookie(reply, token);
      await audit.fromRequest(req, 'setup.begin', { type: 'setup' }, 'Bootstrap secret accepted; setup started');
      return statusOf(req, updated);
    });

    scope.post('/api/setup/owner', limited, async (req, reply) => {
      await requireSetupToken(req, reply);
      const { db, clock, audit } = req.server.fos;
      const input = parseBody(SetupOwnerInput, req.body);
      const problem = passwordProblem(input.password, [input.displayName, 'financialos']);
      if (problem) throw new ApiError(400, `password_${problem}`, PASSWORD_PROBLEM_MESSAGES[problem]);
      if (await getOwner(db)) throw errors.conflict('owner_exists', 'The owner account already exists.');
      const passwordHash = await hashPassword(input.password);
      const now = clock.now();
      const state = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(ownerAccount)
          .values({ displayName: input.displayName.trim(), passwordHash, passwordChangedAt: now, createdAt: now, updatedAt: now })
          .onConflictDoNothing()
          .returning({ id: ownerAccount.id });
        if (inserted.length !== 1) throw errors.conflict('owner_exists', 'The owner account already exists.');
        const [row] = await tx
          .update(setupState)
          .set({ ownerCreatedAt: now, updatedAt: now })
          .where(and(eq(setupState.id, 1), eq(setupState.state, 'in_progress')))
          .returning();
        if (!row) throw errors.conflict('setup_state_changed', 'Setup state changed. Reload and try again.');
        await audit.record(
          { actorType: 'anonymous', action: 'setup.owner_created', object: { type: 'owner', id: inserted[0]?.id ?? null }, summary: 'Owner account created', requestId: String(req.id) },
          tx,
        );
        return row;
      });
      return statusOf(req, state);
    });

    scope.post('/api/setup/totp/start', limited, async (req, reply): Promise<TotpEnrollment> => {
      const state = await requireSetupToken(req, reply);
      const { db, clock, keyring, config, audit } = req.server.fos;
      if (state.totpVerifiedAt) throw errors.conflict('totp_already_verified', 'The authenticator app is already set up.');
      const owner = await requireOwnerRow(db);
      const secret = newTotpSecret();
      await db
        .update(ownerAccount)
        .set({ totpSecretCiphertext: keyring.encryptString(secret, TOTP_AAD), totpEnabledAt: null, totpLastUsedStep: null, updatedAt: clock.now() })
        .where(eq(ownerAccount.id, owner.id));
      const uri = totpUri(config.rpName, owner.displayName, secret);
      await audit.fromRequest(req, 'setup.totp_started', { type: 'owner', id: owner.id }, 'Authenticator enrollment started');
      return { otpauthUri: uri, qrSvg: await totpQrSvg(uri), manualKey: formatManualKey(secret) };
    });

    scope.post('/api/setup/totp/verify', limited, async (req, reply) => {
      const state = await requireSetupToken(req, reply);
      const { db, clock, keyring, audit } = req.server.fos;
      const input = parseBody(TotpVerifyInput, req.body);
      if (state.totpVerifiedAt) throw errors.conflict('totp_already_verified', 'The authenticator app is already set up.');
      const owner = await requireOwnerRow(db);
      if (!owner.totpSecretCiphertext) throw errors.conflict('totp_not_started', 'Start authenticator enrollment first.');
      const secret = keyring.decryptString(owner.totpSecretCiphertext, TOTP_AAD);
      const now = clock.now();
      const check = await verifyTotp(secret, input.code, now, owner.totpLastUsedStep);
      if (!check.ok) {
        await audit.fromRequest(req, 'setup.totp_failed', { type: 'owner', id: owner.id }, 'Authenticator code rejected during setup');
        throw new ApiError(400, 'totp_invalid', 'That code is not valid. Check the time on your device and try again.');
      }
      const updated = await db.transaction(async (tx) => {
        await tx.update(ownerAccount).set({ totpEnabledAt: now, totpLastUsedStep: check.step, updatedAt: now }).where(eq(ownerAccount.id, owner.id));
        const [row] = await tx
          .update(setupState)
          .set({ totpVerifiedAt: now, updatedAt: now })
          .where(and(eq(setupState.id, 1), eq(setupState.state, 'in_progress')))
          .returning();
        return row;
      });
      await audit.fromRequest(req, 'setup.totp_verified', { type: 'owner', id: owner.id }, 'Authenticator app verified');
      return statusOf(req, updated ?? state);
    });

    scope.post('/api/setup/recovery-codes', limited, async (req, reply): Promise<RecoveryCodes> => {
      await requireSetupToken(req, reply);
      const { db, clock, pepper, audit } = req.server.fos;
      const owner = await requireOwnerRow(db);
      const codes = newRecoveryCodes();
      const batchId = randomUUID();
      const now = clock.now();
      await db.transaction(async (tx) => {
        await tx.delete(recoveryCodes);
        await tx.insert(recoveryCodes).values(codes.map((code) => ({ batchId, codeHash: hashRecoveryCode(pepper, code), createdAt: now })));
        await tx
          .update(setupState)
          .set({ recoveryCodesIssuedAt: now, updatedAt: now })
          .where(and(eq(setupState.id, 1), eq(setupState.state, 'in_progress')));
      });
      await audit.fromRequest(req, 'setup.recovery_codes_issued', { type: 'owner', id: owner.id }, 'Recovery codes issued', { batchId, count: codes.length });
      return { codes };
    });

    scope.post('/api/setup/passkey/options', limited, async (req, reply) => {
      await requireSetupToken(req, reply);
      const { db, webauthn } = req.server.fos;
      const owner = await requireOwnerRow(db);
      return webauthn.registrationOptions(owner, relyingPartyFor(req), 'setup');
    });

    scope.post('/api/setup/passkey/verify', limited, async (req, reply) => {
      await requireSetupToken(req, reply);
      const { db, clock, webauthn, audit } = req.server.fos;
      await requireOwnerRow(db);
      const credential = await webauthn.verifyRegistration(req.body, relyingPartyFor(req), 'setup', 'Passkey');
      const now = clock.now();
      const [updated] = await db
        .update(setupState)
        .set({ passkeyEnrolledAt: now, updatedAt: now })
        .where(and(eq(setupState.id, 1), eq(setupState.state, 'in_progress')))
        .returning();
      await audit.fromRequest(req, 'setup.passkey_enrolled', { type: 'webauthn_credential', id: credential.id }, 'Passkey enrolled during setup', {
        rpId: credential.rpId,
      });
      return statusOf(req, updated ?? null);
    });

    scope.post('/api/setup/seal', limited, async (req, reply) => {
      const state = await requireSetupToken(req, reply);
      const { db, clock, audit } = req.server.fos;
      if (!state.ownerCreatedAt || !state.totpVerifiedAt || !state.recoveryCodesIssuedAt) {
        throw errors.conflict('setup_incomplete', 'Create the owner, verify the authenticator app, and save recovery codes before finishing.');
      }
      const owner = await requireOwnerRow(db);
      if (!owner.passwordHash || !owner.totpEnabledAt) throw errors.conflict('setup_incomplete', 'The owner account is not complete.');
      const now = clock.now();
      const [sealed] = await db
        .update(setupState)
        .set({ state: 'sealed', sealedAt: now, setupTokenHash: null, setupTokenExpiresAt: null, bootstrapSecretHash: null, updatedAt: now })
        .where(and(eq(setupState.id, 1), eq(setupState.state, 'in_progress'), isNull(setupState.sealedAt)))
        .returning();
      if (!sealed) throw errors.conflict('setup_state_changed', 'Setup state changed. Reload and try again.');
      clearSetupCookie(reply);
      await audit.fromRequest(req, 'setup.sealed', { type: 'setup' }, 'Setup sealed');
      return statusOf(req, sealed);
    });
  });
}
