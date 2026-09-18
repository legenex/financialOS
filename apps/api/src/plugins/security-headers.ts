import type { FastifyInstance } from 'fastify';
import { NO_STORE_HEADERS, securityHeaders } from '@financialos/security/headers';
import { pathOf } from '../auth/guards';

const NO_STORE_EXACT_OR_PREFIX = ['/launch', '/login', '/setup', '/mcp'];

/** Paths whose responses must never be cached: the API, auth screens, and launch redirects. */
export function requiresNoStore(url: string): boolean {
  const path = pathOf(url);
  if (path === '/api' || path.startsWith('/api/')) return true;
  return NO_STORE_EXACT_OR_PREFIX.some((p) => path === p || path.startsWith(`${p}/`));
}

export function registerSecurityHeaders(app: FastifyInstance): void {
  const base = securityHeaders();
  app.addHook('onSend', async (req, reply, payload) => {
    for (const [name, value] of Object.entries(base)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    reply.header('x-request-id', String(req.id));
    if (requiresNoStore(req.url)) {
      for (const [name, value] of Object.entries(NO_STORE_HEADERS)) reply.header(name, value);
    }
    return payload;
  });
}
