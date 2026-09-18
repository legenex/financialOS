/**
 * Launch flow for extension tiles and other external entry points.
 *
 * `GET /launch/:target` never looks at, uses, or extends an existing session and never returns
 * data. It records a short-lived launch request bound to a Lax cookie and sends the browser to
 * the login screen. Only a *new* authentication that happens after the launch was created
 * consumes it, and only then does the login response name the allowlisted destination.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { launchRequests, sessions, type DbOrTx } from '@financialos/db';
import { LAUNCH_TARGETS, type LaunchInfo, type LaunchTarget } from '@financialos/contracts';
import { randomToken, sha256Hex } from '@financialos/security/tokens';
import { addSeconds } from '../clock';
import { errors } from '../errors';
import { RATE_LIMITS } from '../plugins/rate-limit';
import { UUID_SHAPE } from './sessions';

export const LAUNCH_COOKIE = '__Host-fos_launch';
export const LAUNCH_TTL_SECONDS = 300;
export const LOGIN_PATH_FOR_LAUNCH = '/login?launch=1';

type LaunchRow = typeof launchRequests.$inferSelect;

function hashNonce(nonce: string): string {
  return sha256Hex(`launch:${nonce}`);
}

export function isLaunchTarget(value: string): value is LaunchTarget {
  return Object.prototype.hasOwnProperty.call(LAUNCH_TARGETS, value);
}

/** Internal path for a launch target. Only allowlisted paths are ever returned. */
export function launchPath(target: string): string | null {
  return isLaunchTarget(target) ? LAUNCH_TARGETS[target].path : null;
}

function clearLaunchCookie(reply: FastifyReply): void {
  reply.clearCookie(LAUNCH_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
}

async function activeLaunchFromCookie(req: FastifyRequest): Promise<LaunchRow | null> {
  const nonce = req.cookies[LAUNCH_COOKIE];
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
  const { db, clock } = req.server.fos;
  const now = clock.now();
  const [row] = await db
    .select()
    .from(launchRequests)
    .where(and(eq(launchRequests.nonceHash, hashNonce(nonce)), isNull(launchRequests.consumedAt), gt(launchRequests.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/**
 * Called after a successful authentication, inside the login transaction. Consumes the launch
 * only when the cookie, the launch id, and the timing all match. Always clears the cookie.
 */
export async function completeLaunchAfterLogin(
  req: FastifyRequest,
  reply: FastifyReply,
  launchId: string | undefined,
  session: { id: string; authenticatedAt: Date },
  tx: DbOrTx,
): Promise<string | null> {
  const nonce = req.cookies[LAUNCH_COOKIE];
  if (nonce === undefined) return null;
  clearLaunchCookie(reply);
  const { clock, audit } = req.server.fos;
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || !launchId || !UUID_SHAPE.test(launchId)) return null;
  const now = clock.now();
  const [consumed] = await tx
    .update(launchRequests)
    .set({ consumedAt: now, consumedSessionId: session.id })
    .where(
      and(
        eq(launchRequests.id, launchId),
        eq(launchRequests.nonceHash, hashNonce(nonce)),
        isNull(launchRequests.consumedAt),
        gt(launchRequests.expiresAt, now),
        // The authentication must be newer than the launch request.
        lt(launchRequests.createdAt, session.authenticatedAt),
      ),
    )
    .returning();
  if (!consumed) {
    await audit.record(
      { actorType: 'owner', actorId: `session:${session.id}`, action: 'launch.rejected', object: { type: 'launch_request', id: launchId }, summary: 'Launch request was not valid for this sign-in', requestId: String(req.id) },
      tx,
    );
    return null;
  }
  const path = launchPath(consumed.target);
  if (!path) return null;
  await tx.update(sessions).set({ launchRequestId: consumed.id }).where(eq(sessions.id, session.id));
  await audit.record(
    {
      actorType: 'owner',
      actorId: `session:${session.id}`,
      action: 'launch.completed',
      object: { type: 'launch_request', id: consumed.id },
      summary: `Launch to ${consumed.target} completed after fresh sign-in`,
      requestId: String(req.id),
    },
    tx,
  );
  return path;
}

export function registerLaunchRoutes(app: FastifyInstance): void {
  app.get<{ Params: { target: string } }>('/launch/:target', { config: { rateLimit: RATE_LIMITS.launch } }, async (req, reply) => {
    const { target } = req.params;
    if (!isLaunchTarget(target)) throw errors.notFound('launch_target_unknown', 'Unknown destination.');
    const { db, clock, audit } = req.server.fos;
    const nonce = randomToken(32);
    const now = clock.now();
    const [row] = await db
      .insert(launchRequests)
      .values({ nonceHash: hashNonce(nonce), target, createdAt: now, expiresAt: addSeconds(now, LAUNCH_TTL_SECONDS) })
      .returning({ id: launchRequests.id });
    reply.setCookie(LAUNCH_COOKIE, nonce, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: LAUNCH_TTL_SECONDS });
    await audit.fromRequest(req, 'launch.created', { type: 'launch_request', id: row?.id ?? null }, `Launch requested for ${target}`);
    // Opportunistic cleanup of old launch requests.
    await db
      .delete(launchRequests)
      .where(or(lt(launchRequests.expiresAt, addSeconds(now, -24 * 3600)), lt(launchRequests.consumedAt, addSeconds(now, -24 * 3600))));
    return reply.code(303).header('location', LOGIN_PATH_FOR_LAUNCH).send();
  });

  app.get('/api/auth/launch', { config: { rateLimit: RATE_LIMITS.auth } }, async (req, reply): Promise<LaunchInfo> => {
    const row = await activeLaunchFromCookie(req);
    if (!row || !isLaunchTarget(row.target)) {
      if (req.cookies[LAUNCH_COOKIE] !== undefined) clearLaunchCookie(reply);
      throw errors.notFound('launch_not_found', 'This link has expired. Open it again from the extension.');
    }
    return {
      launchId: row.id,
      targetLabel: LAUNCH_TARGETS[row.target].label,
      expiresAt: row.expiresAt.toISOString(),
      requiresFreshAuthentication: true,
    };
  });
}
