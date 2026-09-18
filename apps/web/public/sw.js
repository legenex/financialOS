/*
 * FinancialOS service worker (plain JS).
 *
 * Caches ONLY the public app shell: index.html, hashed /assets/*, icons and fonts, so the app can show a
 * neutral offline or locked screen. It never caches /api/*, /launch/*, or any non-GET request, and never
 * stores financial data. The build stamps VERSION and PRECACHE (see apps/web/vite.config.ts).
 */
const VERSION = /*__FOS_VERSION__*/'dev';
const PRECACHE = /*__FOS_PRECACHE__*/[];
const SHELL_CACHE = `fos-shell-${VERSION}`;
const CACHE_PREFIX = 'fos-shell-';
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const urls = PRECACHE.length ? PRECACHE : ['/', SHELL_URL];
      // Fetch individually so one missing file does not abort the install.
      await Promise.all(
        urls.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'reload', credentials: 'omit' });
            if (isCacheableShellResponse(response)) await cache.put(url === '/' ? SHELL_URL : url, response);
          } catch {
            /* offline during install: the next visit retries */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith('fos-') && key !== SHELL_CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

function isPrivatePath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/launch' || pathname.startsWith('/launch/') || pathname === '/mcp' || pathname.startsWith('/oauth') || pathname.startsWith('/healthz') || pathname.startsWith('/readyz');
}

function isCacheableShellResponse(response) {
  if (!response || !response.ok || response.type !== 'basic' || response.redirected) return false;
  const cacheControl = response.headers.get('Cache-Control') || '';
  return !/no-store|private/i.test(cacheControl) || /text\/html/.test(response.headers.get('Content-Type') || '');
}

function isStaticAsset(pathname) {
  return pathname.startsWith('/assets/') || pathname.startsWith('/icons/') || pathname === '/manifest.webmanifest';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never touch mutations
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isPrivatePath(url.pathname)) return; // network only, never cached
  if (request.headers.has('Authorization')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // The HTML shell contains no financial data (D-001); keep the latest copy for offline display.
    if (response.ok && response.type === 'basic' && /text\/html/.test(response.headers.get('Content-Type') || '')) {
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FinancialOS</title><p>Offline — FinancialOS needs a connection.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheableShellResponse(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}
