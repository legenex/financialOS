import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { PasskeyCredential } from '@financialos/contracts';
import {
  launchRequests,
  loginThrottle,
  ownerAccount,
  recoveryCodes,
  setupState,
  webauthnChallenges,
  webauthnCredentials,
} from '../schema/security';
import { isPgError } from '../errors';
import { addSeconds, ConflictError, iso, NotFoundError, tx, type DbOrTx } from './_util';

// ---------------------------------------------------------------------------------------
// Owner account (singleton)
// ---------------------------------------------------------------------------------------

export type OwnerAccountRow = typeof ownerAccount.$inferSelect;

export async function getOwnerAccount(db: DbOrTx): Promise<OwnerAccountRow | null> {
  const [row] = await db.select().from(ownerAccount).limit(1);
  return row ?? null;
}

export async function createOwnerAccount(db: DbOrTx, input: { displayName: string; passwordHash: string }): Promise<OwnerAccountRow> {
  try {
    const now = new Date();
    const [row] = await db
      .insert(ownerAccount)
      .values({ displayName: input.displayName, passwordHash: input.passwordHash, passwordChangedAt: now })
      .returning();
    if (!row) throw new Error('owner insert returned no row');
    return row;
  } catch (error) {
    if (isPgError(error, '23505')) throw new ConflictError('An owner account already exists');
    throw error;
  }
}

export async function updateOwnerAccount(
  db: DbOrTx,
  patch: Partial<Pick<OwnerAccountRow, 'displayName' | 'passwordHash' | 'passwordChangedAt' | 'totpSecretCiphertext' | 'totpEnabledAt'>>,
): Promise<OwnerAccountRow> {
  const [row] = await db.update(ownerAccount).set(patch).returning();
  if (!row) throw new NotFoundError('owner account');
  return row;
}

/**
 * Records a used TOTP time step. Returns false when the step (or a later one) was already
 * used, which rejects replayed codes.
 */
export async function claimTotpStep(db: DbOrTx, step: number): Promise<boolean> {
  const rows = await db
    .update(ownerAccount)
    .set({ totpLastUsedStep: step })
    .where(or(isNull(ownerAccount.totpLastUsedStep), lt(ownerAccount.totpLastUsedStep, step)))
    .returning({ id: ownerAccount.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------
// Setup state (singleton row id = 1)
// ---------------------------------------------------------------------------------------

export type SetupStateRow = typeof setupState.$inferSelect;

export async function getSetupState(db: DbOrTx): Promise<SetupStateRow> {
  await db.insert(setupState).values({ id: 1 }).onConflictDoNothing({ target: setupState.id });
  const [row] = await db.select().from(setupState).where(eq(setupState.id, 1));
  if (!row) throw new NotFoundError('setup state');
  return row;
}

export type SetupStatePatch = Partial<Omit<SetupStateRow, 'id' | 'updatedAt'>>;

export async function updateSetupState(db: DbOrTx, patch: SetupStatePatch): Promise<SetupStateRow> {
  await getSetupState(db);
  const [row] = await db.update(setupState).set(patch).where(eq(setupState.id, 1)).returning();
  if (!row) throw new NotFoundError('setup state');
  return row;
}

/**
 * Updates the setup state only while it is not sealed. Returns null if setup is sealed.
 * Use this for every setup step so a sealed installation cannot be modified.
 */
export async function updateUnsealedSetupState(db: DbOrTx, patch: SetupStatePatch): Promise<SetupStateRow | null> {
  await getSetupState(db);
  const [row] = await db
    .update(setupState)
    .set(patch)
    .where(and(eq(setupState.id, 1), sql`${setupState.state} <> 'sealed'`))
    .returning();
  return row ?? null;
}

/** Counts a failed bootstrap-secret attempt and locks after `maxAttempts`. */
export async function recordSetupFailure(
  db: DbOrTx,
  options: { maxAttempts: number; lockSeconds: number; now?: Date },
): Promise<SetupStateRow> {
  const now = options.now ?? new Date();
  await getSetupState(db);
  const lockUntil = addSeconds(now, options.lockSeconds);
  const [row] = await db
    .update(setupState)
    .set({
      failedAttempts: sql`${setupState.failedAttempts} + 1`,
      lockedUntil: sql`CASE WHEN ${setupState.failedAttempts} + 1 >= ${options.maxAttempts} THEN ${lockUntil.toISOString()}::timestamptz ELSE ${setupState.lockedUntil} END`,
    })
    .where(eq(setupState.id, 1))
    .returning();
  if (!row) throw new NotFoundError('setup state');
  return row;
}

export async function resetSetupFailures(db: DbOrTx): Promise<void> {
  await db.update(setupState).set({ failedAttempts: 0, lockedUntil: null }).where(eq(setupState.id, 1));
}

// ---------------------------------------------------------------------------------------
// WebAuthn credentials and challenges
// ---------------------------------------------------------------------------------------

export type WebauthnCredentialRow = typeof webauthnCredentials.$inferSelect;

export async function insertWebauthnCredential(
  db: DbOrTx,
  input: {
    credentialId: string;
    publicKey: Buffer;
    counter: number;
    transports: string[];
    deviceType: string;
    backedUp: boolean;
    rpId: string;
    name: string;
  },
): Promise<WebauthnCredentialRow> {
  try {
    const [row] = await db.insert(webauthnCredentials).values(input).returning();
    if (!row) throw new Error('credential insert returned no row');
    return row;
  } catch (error) {
    if (isPgError(error, '23505')) throw new ConflictError('This passkey is already registered');
    throw error;
  }
}

export async function listWebauthnCredentials(
  db: DbOrTx,
  options: { includeRevoked?: boolean; rpId?: string } = {},
): Promise<WebauthnCredentialRow[]> {
  const conditions = [];
  if (!options.includeRevoked) conditions.push(isNull(webauthnCredentials.revokedAt));
  if (options.rpId) conditions.push(eq(webauthnCredentials.rpId, options.rpId));
  return db
    .select()
    .from(webauthnCredentials)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(webauthnCredentials.createdAt));
}

export async function getActiveWebauthnCredential(db: DbOrTx, credentialId: string): Promise<WebauthnCredentialRow | null> {
  const [row] = await db
    .select()
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.credentialId, credentialId), isNull(webauthnCredentials.revokedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Stores the new signature counter after a successful assertion. Rejects (returns false)
 * a counter that went backwards, except for authenticators that always report zero.
 */
export async function recordWebauthnUse(db: DbOrTx, id: string, newCounter: number, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(webauthnCredentials)
    .set({ counter: newCounter, lastUsedAt: now })
    .where(
      and(
        eq(webauthnCredentials.id, id),
        isNull(webauthnCredentials.revokedAt),
        or(
          lt(webauthnCredentials.counter, newCounter),
          and(eq(webauthnCredentials.counter, 0), sql`${newCounter} = 0`),
        ),
      ),
    )
    .returning({ id: webauthnCredentials.id });
  return rows.length > 0;
}

export async function revokeWebauthnCredential(db: DbOrTx, id: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(webauthnCredentials)
    .set({ revokedAt: now })
    .where(and(eq(webauthnCredentials.id, id), isNull(webauthnCredentials.revokedAt)))
    .returning({ id: webauthnCredentials.id });
  return rows.length > 0;
}

export function toPasskeyCredential(row: WebauthnCredentialRow): PasskeyCredential {
  return {
    id: row.id,
    name: row.name,
    rpId: row.rpId,
    createdAt: iso(row.createdAt),
    lastUsedAt: iso(row.lastUsedAt),
    backedUp: row.backedUp,
  };
}

export type WebauthnChallengeRow = typeof webauthnChallenges.$inferSelect;

export async function createWebauthnChallenge(
  db: DbOrTx,
  input: {
    purpose: 'register' | 'authenticate';
    challenge: string;
    rpId: string;
    origin: string;
    binding?: string | null;
    ttlSeconds: number;
    now?: Date;
  },
): Promise<WebauthnChallengeRow> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(webauthnChallenges)
    .values({
      purpose: input.purpose,
      challenge: input.challenge,
      rpId: input.rpId,
      origin: input.origin,
      binding: input.binding ?? null,
      createdAt: now,
      expiresAt: addSeconds(now, input.ttlSeconds),
    })
    .returning();
  if (!row) throw new Error('challenge insert returned no row');
  return row;
}

/** Atomically consumes an unexpired, unused challenge. Returns null otherwise. */
export async function consumeWebauthnChallenge(
  db: DbOrTx,
  input: { challenge: string; purpose: 'register' | 'authenticate'; binding?: string | null; now?: Date },
): Promise<WebauthnChallengeRow | null> {
  const now = input.now ?? new Date();
  const conditions = [
    eq(webauthnChallenges.challenge, input.challenge),
    eq(webauthnChallenges.purpose, input.purpose),
    isNull(webauthnChallenges.consumedAt),
    gt(webauthnChallenges.expiresAt, now),
  ];
  if (input.binding !== undefined) {
    conditions.push(input.binding === null ? isNull(webauthnChallenges.binding) : eq(webauthnChallenges.binding, input.binding));
  }
  const [row] = await db
    .update(webauthnChallenges)
    .set({ consumedAt: now })
    .where(and(...conditions))
    .returning();
  return row ?? null;
}

export async function deleteExpiredWebauthnChallenges(db: DbOrTx, now = new Date()): Promise<number> {
  const rows = await db
    .delete(webauthnChallenges)
    .where(or(lte(webauthnChallenges.expiresAt, now), sql`${webauthnChallenges.consumedAt} IS NOT NULL`))
    .returning({ id: webauthnChallenges.id });
  return rows.length;
}

// ---------------------------------------------------------------------------------------
// Recovery codes (stored hashed)
// ---------------------------------------------------------------------------------------

/** Replaces all recovery codes with a new batch. Returns the batch id. */
export async function replaceRecoveryCodes(db: DbOrTx, codeHashes: string[]): Promise<string> {
  if (codeHashes.length === 0) throw new ConflictError('At least one recovery code is required');
  return tx(db, async (t) => {
    await t.delete(recoveryCodes);
    const batchId = randomUUID();
    await t.insert(recoveryCodes).values(codeHashes.map((codeHash) => ({ batchId, codeHash })));
    return batchId;
  });
}

/** For deterministic hashes: atomically marks the matching unused code as used. */
export async function consumeRecoveryCodeByHash(db: DbOrTx, codeHash: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(recoveryCodes)
    .set({ usedAt: now })
    .where(and(eq(recoveryCodes.codeHash, codeHash), isNull(recoveryCodes.usedAt)))
    .returning({ id: recoveryCodes.id });
  return rows.length > 0;
}

/** For salted hashes: the caller verifies each candidate, then calls markRecoveryCodeUsed. */
export async function listUnusedRecoveryCodes(db: DbOrTx): Promise<Array<{ id: string; codeHash: string }>> {
  return db
    .select({ id: recoveryCodes.id, codeHash: recoveryCodes.codeHash })
    .from(recoveryCodes)
    .where(isNull(recoveryCodes.usedAt));
}

export async function markRecoveryCodeUsed(db: DbOrTx, id: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(recoveryCodes)
    .set({ usedAt: now })
    .where(and(eq(recoveryCodes.id, id), isNull(recoveryCodes.usedAt)))
    .returning({ id: recoveryCodes.id });
  return rows.length > 0;
}

export async function countUnusedRecoveryCodes(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ n: count() }).from(recoveryCodes).where(isNull(recoveryCodes.usedAt));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------------------

export type LoginThrottleRow = typeof loginThrottle.$inferSelect;

export async function getLoginThrottle(db: DbOrTx, key: string): Promise<LoginThrottleRow | null> {
  const [row] = await db.select().from(loginThrottle).where(eq(loginThrottle.key, key)).limit(1);
  return row ?? null;
}

/** True when `key` is currently locked out. */
export async function isLoginLocked(db: DbOrTx, key: string, now = new Date()): Promise<boolean> {
  const row = await getLoginThrottle(db, key);
  return Boolean(row?.lockedUntil && row.lockedUntil > now);
}

/**
 * Counts a failure inside a rolling window and sets `locked_until` once `maxFailures`
 * is reached. Atomic under concurrency.
 */
export async function recordLoginFailure(
  db: DbOrTx,
  key: string,
  policy: { maxFailures: number; windowSeconds: number; lockSeconds: number },
  now = new Date(),
): Promise<LoginThrottleRow> {
  const windowStart = addSeconds(now, -policy.windowSeconds);
  const lockUntil = addSeconds(now, policy.lockSeconds);
  const expired = sql`${loginThrottle.firstFailureAt} < ${windowStart.toISOString()}::timestamptz`;
  const nextFailures = sql`CASE WHEN ${expired} THEN 1 ELSE ${loginThrottle.failures} + 1 END`;
  const [row] = await db
    .insert(loginThrottle)
    .values({
      key,
      failures: 1,
      firstFailureAt: now,
      lastFailureAt: now,
      lockedUntil: policy.maxFailures <= 1 ? lockUntil : null,
    })
    .onConflictDoUpdate({
      target: loginThrottle.key,
      set: {
        failures: nextFailures,
        firstFailureAt: sql`CASE WHEN ${expired} THEN ${now.toISOString()}::timestamptz ELSE ${loginThrottle.firstFailureAt} END`,
        lastFailureAt: now,
        lockedUntil: sql`CASE WHEN ${nextFailures} >= ${policy.maxFailures} THEN ${lockUntil.toISOString()}::timestamptz ELSE ${loginThrottle.lockedUntil} END`,
      },
    })
    .returning();
  if (!row) throw new Error('throttle upsert returned no row');
  return row;
}

export async function clearLoginThrottle(db: DbOrTx, key: string): Promise<void> {
  await db.delete(loginThrottle).where(eq(loginThrottle.key, key));
}

export async function deleteStaleLoginThrottles(db: DbOrTx, olderThanSeconds: number, now = new Date()): Promise<number> {
  const cutoff = addSeconds(now, -olderThanSeconds);
  const rows = await db
    .delete(loginThrottle)
    .where(and(lt(loginThrottle.lastFailureAt, cutoff), or(isNull(loginThrottle.lockedUntil), lt(loginThrottle.lockedUntil, now))))
    .returning({ key: loginThrottle.key });
  return rows.length;
}

// ---------------------------------------------------------------------------------------
// Launch requests (extension → fresh authentication)
// ---------------------------------------------------------------------------------------

export type LaunchRequestRow = typeof launchRequests.$inferSelect;

export async function createLaunchRequest(
  db: DbOrTx,
  input: { nonceHash: string; target: string; ttlSeconds: number; now?: Date },
): Promise<LaunchRequestRow> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(launchRequests)
    .values({ nonceHash: input.nonceHash, target: input.target, createdAt: now, expiresAt: addSeconds(now, input.ttlSeconds) })
    .returning();
  if (!row) throw new Error('launch insert returned no row');
  return row;
}

export async function getPendingLaunchRequest(db: DbOrTx, nonceHash: string, now = new Date()): Promise<LaunchRequestRow | null> {
  const [row] = await db
    .select()
    .from(launchRequests)
    .where(and(eq(launchRequests.nonceHash, nonceHash), isNull(launchRequests.consumedAt), gt(launchRequests.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/** Atomically consumes a pending launch request and links it to the new session. */
export async function consumeLaunchRequest(
  db: DbOrTx,
  input: { nonceHash: string; sessionId: string | null; now?: Date },
): Promise<LaunchRequestRow | null> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(launchRequests)
    .set({ consumedAt: now, consumedSessionId: input.sessionId })
    .where(and(eq(launchRequests.nonceHash, input.nonceHash), isNull(launchRequests.consumedAt), gt(launchRequests.expiresAt, now)))
    .returning();
  return row ?? null;
}

export async function deleteExpiredLaunchRequests(db: DbOrTx, retainSeconds = 86_400, now = new Date()): Promise<number> {
  const rows = await db
    .delete(launchRequests)
    .where(lt(launchRequests.expiresAt, addSeconds(now, -retainSeconds)))
    .returning({ id: launchRequests.id });
  return rows.length;
}
