import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errors } from '../errors';
import { SAFE_METHODS, pathOf } from '../auth/guards';

/**
 * Cross-site top-level navigations that must still reach the server (they carry no session:
 * the session cookie is SameSite=Strict). Provider OAuth redirects land here.
 */
const CROSS_SITE_GET_ALLOWED = new Set(['/api/oauth/callback']);

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? undefined : value;
}

/**
 * Global request-origin policy for /api/* and /mcp:
 * - `Sec-Fetch-Site: cross-site` is refused for every method;
 * - unsafe methods must send an Origin that exactly matches a configured origin;
 * - /api/ext/* is handled by the extension routes (extension origins only);
 * - bearer-authenticated agent endpoints may omit Origin, but a browser Origin must match.
 */
export function registerOriginGuard(app: FastifyInstance): void {
  const allowed = new Set(app.fos.config.allowedOrigins);
  app.addHook('onRequest', async (req) => {
    const path = pathOf(req.url);
    const isApi = path === '/api' || path.startsWith('/api/');
    const isMcp = path === '/mcp';
    if (!isApi && !isMcp) return;
    if (path.startsWith('/api/ext/')) return;
    const origin = headerValue(req, 'origin');
    const site = headerValue(req, 'sec-fetch-site');
    if (site === 'cross-site' && !(req.method === 'GET' && CROSS_SITE_GET_ALLOWED.has(path))) throw errors.origin();
    if (isMcp || path.startsWith('/api/agent/')) {
      if (origin !== undefined && !allowed.has(origin)) throw errors.origin();
      return;
    }
    if (!SAFE_METHODS.has(req.method) && (origin === undefined || !allowed.has(origin))) throw errors.origin();
  });
}
