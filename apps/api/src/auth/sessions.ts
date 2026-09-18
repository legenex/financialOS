/**
 * Owner web sessions.
 *
 * Invariants (see docs/ARCHITECTURE.md "Session rules"):
 * - The token is 256 random bits, sent only in the `__Host-fos_session` cookie; the database
 *   stores its SHA-256.
 * - `absolute_expires_at = authenticated_at + 600 s`, fixed at creation and never updated.
 * - The idle deadline moves only on non-background requests and never passes the absolute one.
 * - A session is valid iff not revoked AND now < absolute AND now < idle.
 * - A new authentication revokes every other session.
 */
import type { FastifyReply } from 'fastify';
import { and, desc, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import { sessions, type Database, type DbOrTx } from '@financialos/db';
import { SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_MAX_SECONDS, type SessionInfo } from '@financialos/contracts';
import { hmacSha256Base64Url, randomToken, sha256Hex, timingSafeEqualString } from '@financialos/security/tokens';
import { addSeconds, minDate, type Clock } from '../clock';
import type { OwnerSession } from '../context';
import type { SettingsStore } from './store';

/**
 * `__Host-`-prefixed cookies are rejected by every real browser unless set over HTTPS (the prefix
 * itself requires `Secure`, `Path=/`, and no `Domain` — this is enforced by the browser, not just a
 * convention). Production is always served over HTTPS, so it gets the full `__Host-` + `Secure`
 * treatment. A deployment that is only reachable over plain HTTP so far (dev/e2e stacks; a fresh
 * production deploy before the owner finishes the Tailscale HTTPS step and canonicalOrigin still
 * points at loopback) would otherwise be unable to sign in with a real browser at all: the
 * Set-Cookie header would simply be dropped. See sessionCookieName().
 */
export const SESSION_COOKIE_SECURE = '__Host-fos_session';
export const SESSION_COOKIE_INSECURE = 'fos_session';

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_INSECURE;
}
export const BACKGROUND_HEADER = 'x-fos-background';
export const CSRF_HEADER = 'x-csrf-token';

export type SessionRow = typeof sessions.$inferSelect;
export type AuthMethod = OwnerSession['authMethod'];

export type RevokeReason =
  | 'superseded'
  | 'logout'
  | 'logout_all'
  | 'password_changed'
  | 'revoked_by_owner'
  | 'ops_revoke_all';

export interface CreateSessionInput {
  authMethod: AuthMethod;
  userAgent: string | null;
  ipHash: string | null;
  origin: string | null;
  launchRequestId?: string | null;
}

export type ValidationResult =
  | { valid: true; row: SessionRow }
  | { valid: false; reason: 'not_found' | 'revoked' | 'absolute_expired' | 'idle_expired'; row: SessionRow | null };

/** Cookie tokens are 32 random bytes in base64url (43 characters). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkValidity(row: SessionRow, now: Date): ValidationResult {
  if (row.revokedAt) return { valid: false, reason: 'revoked', row };
  if (now.getTime() >= row.absoluteExpiresAt.getTime()) return { valid: false, reason: 'absolute_expired', row };
  if (now.getTime() >= row.idleExpiresAt.getTime()) return { valid: false, reason: 'idle_expired', row };
  return { valid: true, row };
}

export class SessionService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #pepper: Buffer;
  readonly #settings: SettingsStore;
  readonly #secure: boolean;

  /** `secure` should be `new URL(config.canonicalOrigin).protocol === 'https:'`. */
  constructor(db: Database, clock: Clock, pepper: Buffer, settings: SettingsStore, secure: boolean) {
    this.#db = db;
    this.#clock = clock;
    this.#pepper = pepper;
    this.#settings = settings;
    this.#secure = secure;
  }

  /** The cookie name this deployment actually uses; read requests must check this one, not a fixed constant. */
  get cookieName(): string {
    return sessionCookieName(this.#secure);
  }

  hashToken(token: string): string {
    return sha256Hex(`session:${token}`);
  }

  csrfTokenFor(tokenHash: string): string {
    return hmacSha256Base64Url(this.#pepper, `csrf:${tokenHash}`);
  }

  verifyCsrf(tokenHash: string, presented: string | undefined): boolean {
    if (typeof presented !== 'string' || presented.length === 0 || presented.length > 128) return false;
    return timingSafeEqualString(this.csrfTokenFor(tokenHash), presented);
  }

  async idleTimeoutSeconds(): Promise<number> {
    const configured = await this.#settings.getIdleTimeoutSeconds();
    return Math.max(60, Math.min(configured, SESSION_IDLE_MAX_SECONDS));
  }

  /**
   * Creates a new session and revokes every other active session in the same transaction.
   * Returns the clear token exactly once.
   */
  async create(input: CreateSessionInput, tx?: DbOrTx): Promise<{ token: string; row: SessionRow }> {
    const token = randomToken(32);
    const tokenHash = this.hashToken(token);
    const now = this.#clock.now();
    const absoluteExpiresAt = addSeconds(now, SESSION_ABSOLUTE_SECONDS);
    const idle = await this.idleTimeoutSeconds();
    const idleExpiresAt = minDate(addSeconds(now, idle), absoluteExpiresAt);
    const run = async (db: DbOrTx) => {
      await db
        .update(sessions)
        .set({ revokedAt: now, revokeReason: 'superseded' })
        .where(isNull(sessions.revokedAt));
      const [row] = await db
        .insert(sessions)
        .values({
          tokenHash,
          authMethod: input.authMethod,
          authenticatedAt: now,
          absoluteExpiresAt,
          idleExpiresAt,
          lastActivityAt: now,
          createdAt: now,
          userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
          ipHash: input.ipHash,
          origin: input.origin,
          launchRequestId: input.launchRequestId ?? null,
        })
        .returning();
      if (!row) throw new Error('session insert returned no row');
      return row;
    };
    const row = tx ? await run(tx) : await this.#db.transaction(run);
    return { token, row };
  }

  async findByToken(token: string | undefined): Promise<SessionRow | null> {
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
    const [row] = await this.#db.select().from(sessions).where(eq(sessions.tokenHash, this.hashToken(token))).limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<SessionRow | null> {
    if (!UUID_SHAPE.test(id)) return null;
    const [row] = await this.#db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row ?? null;
  }

  async validateToken(token: string | undefined): Promise<ValidationResult> {
    const row = await this.findByToken(token);
    if (!row) return { valid: false, reason: 'not_found', row: null };
    return checkValidity(row, this.#clock.now());
  }

  async validateById(id: string): Promise<ValidationResult> {
    const row = await this.findById(id);
    if (!row) return { valid: false, reason: 'not_found', row: null };
    return checkValidity(row, this.#clock.now());
  }

  /**
   * Records owner activity. Only the idle deadline moves, and never past the absolute deadline.
   * The update is conditional so a concurrent revocation or expiry wins.
   */
  async touch(row: SessionRow): Promise<SessionRow | null> {
    const now = this.#clock.now();
    const idle = await this.idleTimeoutSeconds();
    const nextIdle = minDate(addSeconds(now, idle), row.absoluteExpiresAt);
    const [updated] = await this.#db
      .update(sessions)
      .set({ lastActivityAt: now, idleExpiresAt: nextIdle })
      .where(
        and(
          eq(sessions.id, row.id),
          isNull(sessions.revokedAt),
          gt(sessions.absoluteExpiresAt, now),
          gt(sessions.idleExpiresAt, now),
        ),
      )
      .returning();
    return updated ?? null;
  }

  async revoke(id: string, reason: RevokeReason): Promise<boolean> {
    const now = this.#clock.now();
    const rows = await this.#db
      .update(sessions)
      .set({ revokedAt: now, revokeReason: reason })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  /** Revokes every active session, optionally keeping one. Returns the number revoked. */
  async revokeAll(reason: RevokeReason, options: { exceptId?: string; tx?: DbOrTx } = {}): Promise<number> {
    const now = this.#clock.now();
    const where = options.exceptId ? and(isNull(sessions.revokedAt), ne(sessions.id, options.exceptId)) : isNull(sessions.revokedAt);
    const rows = await (options.tx ?? this.#db)
      .update(sessions)
      .set({ revokedAt: now, revokeReason: reason })
      .where(where)
      .returning({ id: sessions.id });
    return rows.length;
  }

  /** Deletes sessions that ended more than seven days ago. */
  async housekeeping(): Promise<number> {
    const cutoff = addSeconds(this.#clock.now(), -7 * 24 * 3600);
    const rows = await this.#db
      .delete(sessions)
      .where(or(lt(sessions.absoluteExpiresAt, cutoff), lt(sessions.revokedAt, cutoff)))
      .returning({ id: sessions.id });
    return rows.length;
  }

  async listRecent(limit = 20): Promise<SessionRow[]> {
    return this.#db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.authenticatedAt))
      .limit(limit);
  }

  toOwnerSession(row: SessionRow): OwnerSession {
    return {
      id: row.id,
      tokenHash: row.tokenHash,
      authMethod: row.authMethod as AuthMethod,
      authenticatedAt: row.authenticatedAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
      idleExpiresAt: row.idleExpiresAt,
      csrfToken: this.csrfTokenFor(row.tokenHash),
    };
  }

  toInfo(session: OwnerSession, ownerName: string, privacyMode: boolean): SessionInfo {
    return {
      authenticated: true,
      sessionId: session.id,
      ownerName,
      authenticatedAt: session.authenticatedAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      idleExpiresAt: session.idleExpiresAt.toISOString(),
      serverNow: this.#clock.now().toISOString(),
      csrfToken: session.csrfToken,
      authMethod: session.authMethod,
      privacyMode,
    };
  }

  /** Seconds until the absolute deadline, rounded down so the cookie never outlives the session. */
  remainingAbsoluteSeconds(absoluteExpiresAt: Date): number {
    return Math.max(0, Math.floor((absoluteExpiresAt.getTime() - this.#clock.now().getTime()) / 1000));
  }

  setCookie(reply: FastifyReply, token: string, absoluteExpiresAt: Date): void {
    reply.setCookie(this.cookieName, token, {
      httpOnly: true,
      secure: this.#secure,
      sameSite: 'strict',
      path: '/',
      maxAge: this.remainingAbsoluteSeconds(absoluteExpiresAt),
    });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(this.cookieName, { httpOnly: true, secure: this.#secure, sameSite: 'strict', path: '/' });
  }
}
