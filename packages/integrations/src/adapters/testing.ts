/**
 * Test-only helpers: a local HTTP server on 127.0.0.1 with a random port, and an AdapterContext wired to a
 * safeFetch that may reach only that server. Not exported from the package index and never used at runtime.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSafeFetch, type AllowlistEntry } from '@financialos/security/net';
import { createRedactingLogger, type AdapterContext, type AdapterLogger, type ConfigValue, type LogLevel } from '../core/context';

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

export type MockHandler = (request: RecordedRequest, index: number) => MockResponse | Promise<MockResponse>;

export interface MockServer {
  server: Server;
  port: number;
  origin: string;
  requests: RecordedRequest[];
  allowlistEntry: AllowlistEntry;
  close(): Promise<void>;
}

export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = req.url ?? '/';
      const parsed = new URL(raw, 'http://127.0.0.1');
      const record: RecordedRequest = {
        method: req.method ?? 'GET',
        url: raw,
        path: parsed.pathname,
        query: parsed.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      const index = requests.length;
      requests.push(record);
      Promise.resolve(handler(record, index))
        .then((out) => {
          res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
          res.end(out.body ?? '');
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('mock handler failed');
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    allowlistEntry: { scheme: 'http', host: '127.0.0.1', port },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export interface CapturedLog {
  level: LogLevel;
  message: string;
  fields: Record<string, unknown>;
}

export interface TestContextOptions {
  servers?: MockServer[];
  credentials?: Record<string, string>;
  config?: Record<string, ConfigValue>;
  now?: Date;
  signal?: AbortSignal;
  /** Secrets the logger must scrub, in addition to whatever the adapter adds. */
  logSecrets?: readonly string[];
  extraAllowlist?: readonly AllowlistEntry[];
}

export interface TestContext {
  ctx: AdapterContext;
  logs: CapturedLog[];
  /** Everything the logger emitted, flattened to one string for "the token never appears" assertions. */
  logText(): string;
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const logs: CapturedLog[] = [];
  const allowlist: AllowlistEntry[] = [...(options.servers ?? []).map((s) => s.allowlistEntry), ...(options.extraAllowlist ?? [])];
  const safeFetch = createSafeFetch({
    policy: { allowlist },
    // 127.0.0.1 is an IP literal, so no DNS lookup happens; any other host fails the policy before resolving.
    resolver: async (hostname) => {
      throw Object.assign(new Error(`unexpected DNS lookup for ${hostname}`), { code: 'ENOTFOUND' });
    },
    defaults: { totalTimeoutMs: 15_000, connectTimeoutMs: 5_000, headersTimeoutMs: 10_000, bodyTimeoutMs: 10_000 },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
  });
  const logger: AdapterLogger = createRedactingLogger((level, message, fields) => {
    logs.push({ level, message, fields });
  }, options.logSecrets ?? []);
  const controller = new AbortController();
  const ctx: AdapterContext = {
    credentials: Object.freeze({ ...(options.credentials ?? {}) }),
    config: Object.freeze({ ...(options.config ?? {}) }),
    safeFetch,
    clock: { now: () => options.now ?? new Date('2026-09-18T12:00:00.000Z') },
    logger,
    signal: options.signal ?? controller.signal,
    allowlist,
  };
  return {
    ctx,
    logs,
    logText: () => logs.map((l) => `${l.level} ${l.message} ${JSON.stringify(l.fields)}`).join('\n'),
  };
}

export function json(value: unknown, extra: Omit<MockResponse, 'body'> = {}): MockResponse {
  return { status: 200, ...extra, body: JSON.stringify(value) };
}
