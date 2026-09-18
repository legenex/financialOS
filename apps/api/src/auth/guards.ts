import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, errors } from '../errors';
import { BACKGROUND_HEADER, CSRF_HEADER } from './sessions';

export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Path without query string. */
export function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? undefined : value;
}

/**
 * Background requests (polling, status checks) never count as owner activity.
 * `GET /api/auth/session` is always background.
 */
export function isBackgroundRequest(req: FastifyRequest): boolean {
  if (req.method === 'GET' && pathOf(req.url) === '/api/auth/session') return true;
  return headerValue(req, BACKGROUND_HEADER) === '1';
}

/**
 * Owner-session guard (use as `onRequest` or `preHandler`).
 * - accepts only the session cookie; any Authorization header is refused (device and agent
 *   credentials never work on owner routes);
 * - validates the session (revoked / absolute / idle), clearing the cookie when it is not valid;
 * - requires the CSRF header on every unsafe method;
 * - records activity unless the request is a background request;
 * - attaches `req.session`.
 */
export async function requireOwner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { sessions } = req.server.fos;
  if (req.headers.authorization !== undefined) {
    throw new ApiError(401, 'credential_not_accepted', 'This endpoint accepts only a signed-in owner session.');
  }
  const token = req.cookies[sessions.cookieName];
  if (!token) throw errors.unauthenticated();
  const result = await sessions.validateToken(token);
  if (!result.valid) {
    sessions.clearCookie(reply);
    throw errors.sessionExpired();
  }
  let row = result.row;
  if (!SAFE_METHODS.has(req.method) && !sessions.verifyCsrf(row.tokenHash, headerValue(req, CSRF_HEADER))) {
    throw errors.csrf();
  }
  if (!isBackgroundRequest(req)) {
    const touched = await sessions.touch(row);
    if (!touched) {
      sessions.clearCookie(reply);
      throw errors.sessionExpired();
    }
    row = touched;
  }
  req.session = sessions.toOwnerSession(row);
}

/**
 * Re-reads the session. Call it immediately before delivering the result of any long-running
 * operation, before streaming a download, and before every server-sent event. It never records
 * activity. Throws `401 session_expired` (and clears the cookie when a reply is given).
 */
export async function assertSessionStillValid(req: FastifyRequest, reply?: FastifyReply): Promise<void> {
  const current = req.session;
  if (!current) throw errors.unauthenticated();
  const { sessions } = req.server.fos;
  const result = await sessions.validateById(current.id);
  if (!result.valid) {
    if (reply && !reply.sent) sessions.clearCookie(reply);
    throw errors.sessionExpired();
  }
  req.session = sessions.toOwnerSession(result.row);
}

/** The session attached by `requireOwner`. Throws if the route forgot the guard. */
export function ownerSessionOf(req: FastifyRequest) {
  if (!req.session) throw errors.unauthenticated();
  return req.session;
}

export type RouteRegistrar = (scope: FastifyInstance) => void | Promise<void>;

/**
 * Registers a group of private owner routes. Every route inside `register` requires a valid
 * session, and every unsafe method also requires the CSRF header (Origin is checked globally).
 *
 *   registerOwnerRoutes(app, (scope) => {
 *     scope.get('/api/today', async (req) => ...);
 *   });
 */
export function registerOwnerRoutes(app: FastifyInstance, register: RouteRegistrar, options: { prefix?: string } = {}): void {
  app.register(
    async (scope) => {
      scope.addHook('onRequest', requireOwner);
      await register(scope);
    },
    options.prefix ? { prefix: options.prefix } : {},
  );
}
