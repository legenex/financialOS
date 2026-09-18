import { and, desc, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_MAX_SECONDS, type SessionListItem } from '@financialos/contracts';
import { sessions } from '../schema/security';
import { addSeconds, clampLimit, InvalidError, iso, tx, type DbOrTx } from './_util';

export type SessionRow = typeof sessions.$inferSelect;

export interface CreateSessionInput {
  tokenHash: string;
  authMethod: string;
  authenticatedAt?: Date;
  /** Idle timeout in seconds (60–600). */
  idleTimeoutSeconds: number;
  userAgent?: string | null;
  ipHash?: string | null;
  origin?: string | null;
  launchRequestId?: string | null;
  /** Revoke every other active session (a new authentication replaces the old session). Default true. */
  revokeOthers?: boolean;
}

function idleSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 60 || value > SESSION_IDLE_MAX_SECONDS) {
    throw new InvalidError(`idle timeout must be an integer between 60 and ${SESSION_IDLE_MAX_SECONDS}`);
  }
  return value;
}

/** Creates a session with the hard 600-second absolute lifetime. */
export async function createSession(db: DbOrTx, input: CreateSessionInput): Promise<SessionRow> {
  const authenticatedAt = input.authenticatedAt ?? new Date();
  const absoluteExpiresAt = addSeconds(authenticatedAt, SESSION_ABSOLUTE_SECONDS);
  const idleCandidate = addSeconds(authenticatedAt, idleSeconds(input.idleTimeoutSeconds));
  const idleExpiresAt = idleCandidate < absoluteExpiresAt ? idleCandidate : absoluteExpiresAt;
  return tx(db, async (t) => {
    const [row] = await t
      .insert(sessions)
      .values({
        tokenHash: input.tokenHash,
        authMethod: input.authMethod,
        authenticatedAt,
        absoluteExpiresAt,
        idleExpiresAt,
        lastActivityAt: authenticatedAt,
        userAgent: input.userAgent ?? null,
        ipHash: input.ipHash ?? null,
        origin: input.origin ?? null,
        launchRequestId: input.launchRequestId ?? null,
      })
      .returning();
    if (!row) throw new Error('session insert returned no row');
    if (input.revokeOthers !== false) {
      await t
        .update(sessions)
        .set({ revokedAt: authenticatedAt, revokeReason: 'superseded' })
        .where(and(ne(sessions.id, row.id), isNull(sessions.revokedAt)));
    }
    return row;
  });
}

/** Returns the session only if it is not revoked and neither expiry has passed. */
export async function findActiveSessionByTokenHash(db: DbOrTx, tokenHash: string, now = new Date()): Promise<SessionRow | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.absoluteExpiresAt, now),
        gt(sessions.idleExpiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getSession(db: DbOrTx, id: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return row ?? null;
}

/**
 * Records owner activity. The idle expiry moves forward but never past the absolute
 * expiry, which never moves. Returns null if the session is no longer active.
 */
export async function touchSession(db: DbOrTx, id: string, idleTimeoutSeconds: number, now = new Date()): Promise<SessionRow | null> {
  const idleUntil = addSeconds(now, idleSeconds(idleTimeoutSeconds));
  const [row] = await db
    .update(sessions)
    .set({
      lastActivityAt: now,
      idleExpiresAt: sql`least(${idleUntil.toISOString()}::timestamptz, ${sessions.absoluteExpiresAt})`,
    })
    .where(
      and(
        eq(sessions.id, id),
        isNull(sessions.revokedAt),
        gt(sessions.absoluteExpiresAt, now),
        gt(sessions.idleExpiresAt, now),
      ),
    )
    .returning();
  return row ?? null;
}

export async function revokeSession(db: DbOrTx, id: string, reason: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now, revokeReason: reason })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

export async function revokeSessionByTokenHash(db: DbOrTx, tokenHash: string, reason: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now, revokeReason: reason })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

export async function revokeAllSessions(db: DbOrTx, reason: string, now = new Date()): Promise<number> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now, revokeReason: reason })
    .where(isNull(sessions.revokedAt))
    .returning({ id: sessions.id });
  return rows.length;
}

export async function listSessions(db: DbOrTx, options: { limit?: number } = {}): Promise<SessionRow[]> {
  return db
    .select()
    .from(sessions)
    .orderBy(desc(sessions.createdAt))
    .limit(clampLimit(options.limit, 20, 100));
}

/** Housekeeping: removes sessions that ended more than `retainSeconds` ago. */
export async function deleteEndedSessions(db: DbOrTx, retainSeconds = 30 * 86_400, now = new Date()): Promise<number> {
  const cutoff = addSeconds(now, -retainSeconds);
  const rows = await db
    .delete(sessions)
    .where(or(lt(sessions.absoluteExpiresAt, cutoff), lt(sessions.revokedAt, cutoff)))
    .returning({ id: sessions.id });
  return rows.length;
}

export function toSessionListItem(row: SessionRow, currentSessionId: string | null): SessionListItem {
  return {
    id: row.id,
    current: row.id === currentSessionId,
    authMethod: row.authMethod,
    createdAt: iso(row.createdAt),
    absoluteExpiresAt: iso(row.absoluteExpiresAt),
    userAgent: row.userAgent,
    revokedAt: iso(row.revokedAt),
    revokeReason: row.revokeReason,
  };
}
