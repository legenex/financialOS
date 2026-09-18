import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { NO_STORE_HEADERS } from '@financialos/security/headers';
import { pathOf } from '../auth/guards';
import { sendError } from './errors';

const NON_APP_PREFIXES = ['/api/', '/assets/', '/launch/', '/mcp', '/healthz', '/readyz'];

export const WEB_BUILD_MISSING_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>FinancialOS</title></head><body><main><h1>FinancialOS is starting</h1>' +
  '<p>The web application has not been built on this server. The API is running.</p></main></body></html>';

/** SPA routes: GET/HEAD for extension-less paths outside the API and asset namespaces. */
export function isAppRoute(req: FastifyRequest): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = pathOf(req.url);
  if (path === '/api' || path.includes('..') || path.includes('\\')) return false;
  if (NON_APP_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))) return false;
  const last = path.split('/').pop() ?? '';
  return !last.includes('.');
}

function noStore(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) reply.header(name, value);
}

/**
 * Serves the built SPA. Hashed assets are immutable, the service worker and manifest are
 * revalidated on every load, and index.html is never stored.
 */
export async function registerStatic(app: FastifyInstance): Promise<void> {
  const root = app.fos.config.webDistDir;
  const indexPath = join(root, 'index.html');
  const available = existsSync(indexPath);

  if (available) {
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      // Without this, a request that resolves to a directory (starting with the site root, "/"
      // itself) gets a 403 from @fastify/static instead of index.html — nobody could ever open
      // the app by visiting its bare origin. Deep SPA routes (e.g. /today) still fall through to
      // setNotFoundHandler below, since they never resolve to a real file or directory.
      index: ['index.html'],
      wildcard: true,
      redirect: false,
      dotfiles: 'deny',
      cacheControl: false,
      etag: true,
      lastModified: true,
      setHeaders(reply, filePath) {
        const name = basename(filePath);
        const rel = filePath.slice(root.length);
        if (name === 'index.html') noStore(reply);
        else if (rel.startsWith('/assets/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
        else reply.header('cache-control', 'no-cache');
      },
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (!isAppRoute(req)) {
      return sendError(req, reply, 404, { error: { code: 'not_found', message: 'Not found.' } });
    }
    noStore(reply);
    if (!available || !existsSync(indexPath)) {
      return reply.code(503).type('text/html; charset=utf-8').send(WEB_BUILD_MISSING_HTML);
    }
    const html = await readFile(indexPath);
    return reply.code(200).type('text/html; charset=utf-8').send(html);
  });
}
