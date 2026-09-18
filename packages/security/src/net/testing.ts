/**
 * Test-only helpers: local HTTP/HTTPS servers on 127.0.0.1 with random ports and a matching outbound policy.
 * Not exported from the package index.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AllowlistEntry, Resolver } from './policy';

export type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => unknown;

export interface MockServer {
  server: Server;
  port: number;
  /** Base URL using the synthetic hostname (resolve it with `resolver`). */
  url: string;
  host: string;
  scheme: 'http' | 'https';
  requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }>;
  allowlistEntry: AllowlistEntry;
  close(): Promise<void>;
}

export async function startMockServer(handler: Handler, options: { host?: string; tls?: { key: string; cert: string } } = {}): Promise<MockServer> {
  const host = options.host ?? 'mock.financialos.test';
  const requests: MockServer['requests'] = [];
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      Promise.resolve(handler(req, res, body)).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
    });
  };
  const server = options.tls ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, listener) : createHttpServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const scheme = options.tls ? 'https' : 'http';
  return {
    server,
    port,
    host,
    scheme,
    url: `${scheme}://${host}:${port}`,
    requests,
    allowlistEntry: { scheme, host, port },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Resolver mapping synthetic test hostnames to fixed addresses. Unknown names fail like NXDOMAIN. */
export function staticResolver(map: Record<string, string | string[]>): Resolver {
  return async (hostname) => {
    const value = map[hostname];
    if (value === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    const list = Array.isArray(value) ? value : [value];
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

/** Generates a throwaway self-signed certificate for the given names with the system openssl. */
export function selfSignedCert(names: string[]): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'fos-tls-'));
  try {
    const san = names.map((n) => (/^[\d.]+$/.test(n) ? `IP:${n}` : `DNS:${n}`)).join(',');
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', path.join(dir, 'k'), '-out', path.join(dir, 'c'), '-days', '1',
        '-subj', `/CN=${names[0] ?? 'localhost'}`, '-addext', `subjectAltName=${san}`,
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(path.join(dir, 'k'), 'utf8'), cert: readFileSync(path.join(dir, 'c'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
