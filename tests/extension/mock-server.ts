/**
 * Test-only FinancialOS stand-in for the extension runtime test.
 *
 * It implements the three endpoints the extension talks to — `/api/ext/pair/start`,
 * `/api/ext/pair/complete`, `/api/ext/v1/glance` — plus the public `/launch/:target` redirect,
 * exactly as `packages/contracts/src/extension.ts` and `apps/api/src/routes/extension.ts` define
 * them, including the CORS handling for the paired extension origin.
 *
 * It is a fixture, not a second implementation: it stores nothing, signs nothing, and serves only
 * synthetic data. The `/__test/*` routes exist only here, so the spec can play the part of the
 * owner approving a pairing or revoking a device.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GlanceResponse, RevealableField } from '@financialos/contracts';
import { calmGlance, sampleGlance } from '../../apps/extension/src/lib/fixtures';

export const LAUNCH_PATHS: Record<string, string> = {
  today: '/today',
  plan: '/plan',
  goals: '/plan/goals',
  commitments: '/plan/commitments',
  money: '/money',
  coach: '/coach',
  inbox: '/inbox',
  connections: '/connections',
};

const base64url = (buffer: Buffer) =>
  buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const challengeOf = (verifier: string) => base64url(createHash('sha256').update(verifier, 'utf8').digest());

interface Pairing {
  id: string;
  installationId: string;
  verifierChallenge: string;
  deviceLabel: string;
  userCode: string;
  expiresAt: number;
  approved: boolean;
  denied: boolean;
  completed: boolean;
}

export interface MockServerState {
  /** Set by `/__test/approve`; the extension only learns of it on its next poll. */
  pairings: Map<string, Pairing>;
  credential: string | null;
  deviceId: string;
  revoked: boolean;
  revealedFields: RevealableField[];
  /** Forces the glance endpoint to fail, to exercise the offline and locked states. */
  glanceStatus: number | null;
  /** Swaps in the quiet fixture. */
  calm: boolean;
  /** How long the server says a glance stays valid. */
  validForSeconds: number;
  glanceRequests: number;
  pairStartRequests: number;
  pairCompleteRequests: number;
  launchRequests: string[];
}

export interface MockServer {
  origin: string;
  port: number;
  state: MockServerState;
  /** Everything the server saw, so the spec can assert what was and was not sent. */
  requests: Array<{
    method: string;
    path: string;
    origin: string | undefined;
    authorization: string | undefined;
    cookie: string | undefined;
  }>;
  /** Stops listening on the port, so the extension sees a server that is simply not there. */
  suspend(): Promise<void>;
  /** Listens again on the same port, with all state intact. */
  resume(): Promise<void>;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 64_000) chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
  });
}

/** A user code in the shape the owner types into FinancialOS: `ABCD-2345`. */
function userCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return `${pick()}-${pick()}`;
}

export interface MockServerOptions {
  /** The only origin CORS is granted to, e.g. `chrome-extension://pafnoe…`. */
  extensionOrigin: string;
  validForSeconds?: number;
}

export async function startMockServer(options: MockServerOptions): Promise<MockServer> {
  const state: MockServerState = {
    pairings: new Map(),
    credential: null,
    deviceId: '2f1c8a44-9e2b-4f7d-9d0a-5c6b7e8f9a01',
    revoked: false,
    revealedFields: [],
    glanceStatus: null,
    calm: false,
    validForSeconds: options.validForSeconds ?? 600,
    glanceRequests: 0,
    pairStartRequests: 0,
    pairCompleteRequests: 0,
    launchRequests: [],
  };
  const requests: MockServer['requests'] = [];

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'mock_server_error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const origin = req.headers.origin;
    requests.push({
      method: req.method ?? 'GET',
      path,
      origin: typeof origin === 'string' ? origin : undefined,
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      cookie: typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
    });

    // --- Extension surface: the paired extension origin only ---------------------------------
    if (path.startsWith('/api/ext/')) {
      const allowed = origin === options.extensionOrigin;
      res.setHeader('vary', 'Origin');
      if (allowed) res.setHeader('access-control-allow-origin', options.extensionOrigin);

      if (req.method === 'OPTIONS') {
        if (!allowed) return send(res, 403, { error: 'origin_not_allowed' });
        res.writeHead(204, {
          'access-control-allow-methods': 'GET, POST',
          'access-control-allow-headers': 'Authorization, Content-Type',
          'access-control-max-age': '600',
        });
        res.end();
        return;
      }
      // CORS headers are a browser courtesy; the origin is checked here as authorization would be.
      //
      // One deliberate difference from apps/api today: Chrome omits the `Origin` header on a GET
      // once the owner has granted the extension host access to this address (the request is then
      // not a CORS request at all; POSTs still carry it). A GET with no Origin therefore cannot
      // come from a web page, and is authorized on the device credential alone. See the note filed
      // under "extension →" in the coordination log.
      const originMissingOnGet = origin === undefined && req.method === 'GET';
      if (!allowed && !originMissingOnGet)
        return send(res, 403, { error: 'origin_not_allowed', message: 'This extension is not allowed.' });
      // Extension endpoints never accept a browser session.
      if (req.headers.cookie) return send(res, 401, { error: 'session_cookie_not_accepted' });

      if (path === '/api/ext/pair/start' && req.method === 'POST') return pairStart(req, res);
      if (path === '/api/ext/pair/complete' && req.method === 'POST') return pairComplete(req, res);
      if (path === '/api/ext/v1/glance' && req.method === 'GET') return glance(req, res);
      return send(res, 404, { error: 'not_found' });
    }

    // --- Public launch flow -------------------------------------------------------------------
    const launch = /^\/launch\/([a-z]+)$/.exec(path);
    if (launch && req.method === 'GET') {
      const target = launch[1] ?? '';
      if (!Object.hasOwn(LAUNCH_PATHS, target)) return send(res, 404, { error: 'unknown_launch_target' });
      state.launchRequests.push(target);
      // The real server records a short-lived launch request, then asks for fresh authentication.
      res.writeHead(303, {
        location: `/login?launch=1`,
        'cache-control': 'no-store',
        'set-cookie': 'fos_launch=synthetic; Path=/; HttpOnly; SameSite=Lax',
      });
      res.end();
      return;
    }

    if (path === '/login') {
      const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in to FinancialOS</title></head><body><h1 id="login">Sign in to continue</h1><p data-launch-target="${state.launchRequests.at(-1) ?? ''}">Fresh authentication is required.</p></body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    if (path === '/settings/devices/pair') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pair a device</title></head><body><h1>Pair a device</h1></body></html>',
      );
      return;
    }

    // --- Test control (this fixture only) -----------------------------------------------------
    if (path.startsWith('/__test/')) return control(path, url, res);

    return send(res, 404, { error: 'not_found' });
  }

  async function pairStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    state.pairStartRequests += 1;
    const body = (await readJson(req)) as Record<string, string> | undefined;
    if (
      !body ||
      !/^[A-Za-z0-9_-]{22,64}$/.test(body.installationId ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.verifierChallenge ?? '')
    ) {
      return send(res, 400, { error: 'invalid_body' });
    }
    // One open pairing per installation, as the real server enforces.
    for (const pairing of state.pairings.values())
      if (pairing.installationId === body.installationId && !pairing.completed) pairing.denied = true;
    const pairing: Pairing = {
      id: randomUUID(),
      installationId: body.installationId ?? '',
      verifierChallenge: body.verifierChallenge ?? '',
      deviceLabel: body.deviceLabel ?? '',
      userCode: userCode(),
      expiresAt: Date.now() + 600_000,
      approved: false,
      denied: false,
      completed: false,
    };
    state.pairings.set(pairing.id, pairing);
    send(res, 200, {
      pairingId: pairing.id,
      userCode: pairing.userCode,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
      approveUrlPath: '/settings/devices/pair',
    });
  }

  async function pairComplete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    state.pairCompleteRequests += 1;
    const body = (await readJson(req)) as Record<string, string> | undefined;
    const pairing = body ? state.pairings.get(body.pairingId ?? '') : undefined;
    if (!pairing) return send(res, 404, { error: 'pairing_not_found' });
    const bound =
      pairing.installationId === body?.installationId &&
      pairing.verifierChallenge === challengeOf(body?.verifier ?? '');
    if (!bound) return send(res, 403, { error: 'pairing_proof_invalid' });
    if (pairing.completed) return send(res, 409, { error: 'pairing_already_completed' });
    if (pairing.denied) return send(res, 200, { status: 'denied' });
    if (pairing.expiresAt <= Date.now()) return send(res, 200, { status: 'expired' });
    if (!pairing.approved) return send(res, 200, { status: 'pending', retryAfterSeconds: 3 });

    pairing.completed = true;
    state.credential = `device_${base64url(createHash('sha256').update(pairing.id).digest()).slice(0, 32)}`;
    state.revoked = false;
    send(res, 200, {
      status: 'approved',
      deviceId: state.deviceId,
      credential: state.credential,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
      scopes: ['glance:read'],
    });
  }

  function glance(req: IncomingMessage, res: ServerResponse): void {
    state.glanceRequests += 1;
    const authorization = req.headers.authorization;
    const token = typeof authorization === 'string' ? /^Bearer (.+)$/.exec(authorization)?.[1] : undefined;
    if (!token || state.revoked || !state.credential || token !== state.credential) {
      return send(res, 401, { error: 'device_unauthorized', message: 'This device is not paired.' });
    }
    if (state.glanceStatus !== null) return send(res, state.glanceStatus, { error: 'glance_unavailable' });
    const now = new Date();
    const build = state.calm ? calmGlance : sampleGlance;
    const glanceBody: GlanceResponse = build({
      generatedAt: now.toISOString(),
      validForSeconds: state.validForSeconds,
      revealedFields: [...state.revealedFields],
    });
    send(res, 200, glanceBody);
  }

  function control(path: string, url: URL, res: ServerResponse): void {
    switch (path) {
      case '/__test/approve': {
        const open = [...state.pairings.values()].find((p) => !p.completed && !p.denied);
        if (open) open.approved = true;
        return send(res, 200, { approved: !!open, userCode: open?.userCode ?? null });
      }
      case '/__test/deny': {
        for (const pairing of state.pairings.values()) if (!pairing.completed) pairing.denied = true;
        return send(res, 200, { denied: true });
      }
      case '/__test/revoke':
        state.revoked = true;
        return send(res, 200, { revoked: true });
      case '/__test/reveal': {
        const fields = (url.searchParams.get('fields') ?? '').split(',').filter(Boolean) as RevealableField[];
        state.revealedFields = fields;
        return send(res, 200, { revealedFields: fields });
      }
      case '/__test/glance-status': {
        const value = url.searchParams.get('status');
        state.glanceStatus = value ? Number(value) : null;
        return send(res, 200, { glanceStatus: state.glanceStatus });
      }
      case '/__test/calm':
        state.calm = url.searchParams.get('on') !== '0';
        return send(res, 200, { calm: state.calm });
      case '/__test/state':
        return send(res, 200, {
          glanceRequests: state.glanceRequests,
          pairStartRequests: state.pairStartRequests,
          pairCompleteRequests: state.pairCompleteRequests,
          launchRequests: state.launchRequests,
          revoked: state.revoked,
        });
      case '/__test/reset-counters':
        state.glanceRequests = 0;
        state.pairCompleteRequests = 0;
        state.launchRequests = [];
        return send(res, 200, { reset: true });
      default:
        return send(res, 404, { error: 'unknown_control' });
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const stop = () =>
    new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    state,
    requests,
    suspend: stop,
    resume: () => new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: stop,
  };
}
