/**
 * Persistent failure throttling with exponential lockout (login, re-authentication).
 * Rate limiting in memory (@fastify/rate-limit) is a second, coarser layer.
 */
import { eq, inArray } from 'drizzle-orm';
import { loginThrottle, type Database } from '@financialos/db';
import { addSeconds, type Clock } from '../clock';

export interface ThrottlePolicy {
  /** Failures allowed before the first lockout. */
  threshold: number;
  /** First lockout length; doubles with every further failure. */
  baseLockSeconds: number;
  maxLockSeconds: number;
  /** Failures older than this (with no active lock) are forgotten. */
  windowSeconds: number;
}

export const POLICIES = {
  /** Per client address. */
  loginClient: { threshold: 5, baseLockSeconds: 60, maxLockSeconds: 3600, windowSeconds: 24 * 3600 },
  /** Across all clients: slows distributed guessing without locking the owner out for long. */
  loginGlobal: { threshold: 30, baseLockSeconds: 30, maxLockSeconds: 900, windowSeconds: 3600 },
  /** Re-authentication inside a session (password change, recovery-code regeneration). */
  reauth: { threshold: 5, baseLockSeconds: 300, maxLockSeconds: 3600, windowSeconds: 24 * 3600 },
} satisfies Record<string, ThrottlePolicy>;

export function lockSecondsFor(failures: number, policy: ThrottlePolicy): number {
  if (failures < policy.threshold) return 0;
  const exponent = Math.min(failures - policy.threshold, 20);
  return Math.min(policy.baseLockSeconds * 2 ** exponent, policy.maxLockSeconds);
}

export interface ThrottleState {
  locked: boolean;
  retryAfterSeconds: number;
}

export class ThrottleService {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Returns the longest active lock among the keys. */
  async check(keys: string[]): Promise<ThrottleState> {
    if (keys.length === 0) return { locked: false, retryAfterSeconds: 0 };
    const now = this.#clock.now();
    const rows = await this.#db.select().from(loginThrottle).where(inArray(loginThrottle.key, keys));
    let retry = 0;
    for (const row of rows) {
      if (row.lockedUntil && row.lockedUntil.getTime() > now.getTime()) {
        retry = Math.max(retry, (row.lockedUntil.getTime() - now.getTime()) / 1000);
      }
    }
    return { locked: retry > 0, retryAfterSeconds: Math.ceil(retry) };
  }

  async recordFailure(key: string, policy: ThrottlePolicy): Promise<void> {
    const now = this.#clock.now();
    await this.#db.transaction(async (tx) => {
      await tx
        .insert(loginThrottle)
        .values({ key, failures: 0, firstFailureAt: now, lastFailureAt: now, lockedUntil: null })
        .onConflictDoNothing();
      const [row] = await tx.select().from(loginThrottle).where(eq(loginThrottle.key, key)).for('update');
      if (!row) return;
      const lockActive = row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime();
      const stale = !lockActive && now.getTime() - row.lastFailureAt.getTime() > policy.windowSeconds * 1000;
      const failures = (stale ? 0 : row.failures) + 1;
      const lockSeconds = lockSecondsFor(failures, policy);
      await tx
        .update(loginThrottle)
        .set({
          failures,
          firstFailureAt: stale || row.failures === 0 ? now : row.firstFailureAt,
          lastFailureAt: now,
          lockedUntil: lockSeconds > 0 ? addSeconds(now, lockSeconds) : row.lockedUntil,
        })
        .where(eq(loginThrottle.key, key));
    });
  }

  async reset(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.#db.delete(loginThrottle).where(inArray(loginThrottle.key, keys));
  }
}
