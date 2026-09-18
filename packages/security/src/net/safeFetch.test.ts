import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpStatusError,
  RequestAbortedError,
  ResponseTooLargeError,
  SsrfBlockedError,
  TimeoutError,
  TooManyRedirectsError,
  checkUrl,
  classifyAddress,
  createSafeFetch,
  parseRetryAfter,
  toFetchLike,
  validateTarget,
  type OutboundPolicy,
} from './index';
import { selfSignedCert, startMockServer, staticResolver, type MockServer } from './testing';

const servers: MockServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});
async function server(...args: Parameters<typeof startMockServer>): Promise<MockServer> {
  const s = await startMockServer(...args);
  servers.push(s);
  return s;
}

const noPolicy: OutboundPolicy = { allowlist: [] };

describe('classifyAddress', () => {
  const blocked: Array<[string, string]> = [
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'this-network'],
    ['10.1.2.3', 'private'],
    ['100.64.0.1', 'carrier-grade-nat'], // privacy-check: allow-generic (synthetic CGNAT boundary fixture)
    ['100.127.255.254', 'carrier-grade-nat'], // privacy-check: allow-generic (synthetic CGNAT boundary fixture)
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'cloud-metadata'],
    ['169.254.10.10', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.8', 'ietf-protocol-assignments'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['224.0.0.251', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'ipv4-mapped:loopback'],
    ['::ffff:7f00:1', 'ipv4-mapped:loopback'],
    ['::ffff:10.0.0.1', 'ipv4-mapped:private'],
    ['::ffff:169.254.169.254', 'ipv4-mapped:cloud-metadata'],
    ['::127.0.0.1', 'ipv4-compatible'],
    ['::ffff:0:192.168.0.1', 'ipv4-translated:private'],
    ['64:ff9b::7f00:1', 'nat64:loopback'],
    ['64:ff9b::a9fe:a9fe', 'nat64:cloud-metadata'],
    ['64:ff9b:1::1', 'nat64-local-use'],
    ['2002:7f00:1::', '6to4:loopback'],
    ['2002:c0a8:101::1', '6to4:private'],
    ['2001:db8::1', 'documentation'],
    ['2001:0:4136:e378::1', 'teredo'],
    ['fec0::1', 'site-local'],
    ['100::1', 'discard-only'],
  ];
  it.each(blocked)('blocks %s (%s)', (address, reason) => {
    const verdict = classifyAddress(address);
    expect(verdict.public).toBe(false);
    expect(verdict.reason).toBe(reason);
  });

  it('treats metadata, unspecified, multicast and broadcast as never allowed', () => {
    for (const a of ['169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', 'ff02::1', 'fd00:ec2::254', '::ffff:169.254.169.254']) {
      expect(classifyAddress(a).neverAllowed, a).toBe(true);
    }
    expect(classifyAddress('127.0.0.1').neverAllowed).toBe(false);
  });

  it.each(['1.1.1.1', '93.184.215.14', '2606:4700:4700::1111', '::ffff:1.1.1.1', '64:ff9b::101:101'])('allows public %s', (address) => {
    expect(classifyAddress(address).public).toBe(true);
  });

  it('rejects non-literals', () => {
    expect(() => classifyAddress('example.com')).toThrow(TypeError);
  });
});

describe('checkUrl', () => {
  it.each([
    ['https://user:pass@api.example.com/', 'credentials in URLs'],
    ['http://api.example.com/', 'plain http'],
    ['ftp://api.example.com/', 'scheme'],
    ['https://api.example.com:8443/', 'port 8443'],
    ['https://localhost/', 'local hostnames'],
    ['https://svc.localhost/', 'local hostnames'],
    ['https://intranet/', 'single-label'],
    ['https://127.0.0.1/', 'loopback'],
    ['https://[::1]/', 'loopback'],
    ['https://[::ffff:127.0.0.1]/', 'ipv4-mapped:loopback'],
    ['https://2130706433/', 'loopback'],
    ['https://0x7f.1/', 'loopback'],
    ['https://169.254.169.254/latest/meta-data', 'cloud-metadata'],
    ['https://100.100.100.100/', 'carrier-grade-nat'], // privacy-check: allow-generic (synthetic CGNAT fixture)
  ])('blocks %s', (url, fragment) => {
    expect(() => checkUrl(url, noPolicy)).toThrow(SsrfBlockedError);
    expect(() => checkUrl(url, noPolicy)).toThrow(fragment);
  });

  it('allows https on 443 to public hostnames', () => {
    expect(checkUrl('https://api.example.com/v1?x=1', noPolicy).port).toBe(443);
  });

  it('allowlists only the exact scheme, host and port', () => {
    const policy: OutboundPolicy = { allowlist: [{ scheme: 'http', host: '127.0.0.1', port: 4000 }] };
    expect(checkUrl('http://127.0.0.1:4000/v1/models', policy).allowlisted).toBe(true);
    expect(() => checkUrl('http://127.0.0.1:4001/', policy)).toThrow(SsrfBlockedError);
    expect(() => checkUrl('https://127.0.0.1:4000/', policy)).toThrow(SsrfBlockedError);
    expect(() => checkUrl('http://127.0.0.2:4000/', policy)).toThrow(SsrfBlockedError);
  });

  it('never allows the metadata address, even when allowlisted', () => {
    const policy: OutboundPolicy = { allowlist: [{ scheme: 'http', host: '169.254.169.254', port: 80 }] };
    expect(() => checkUrl('http://169.254.169.254/', policy)).toThrow('never allowed');
  });
});

describe('validateTarget (DNS)', () => {
  it('blocks a public name that resolves to a private address', async () => {
    const resolver = staticResolver({ 'api.example.com': '10.0.0.5' });
    await expect(validateTarget('https://api.example.com/', noPolicy, resolver)).rejects.toThrow('private');
  });

  it('blocks when any one of several addresses is private', async () => {
    const resolver = staticResolver({ 'api.example.com': ['93.184.215.14', '::ffff:192.168.0.10'] });
    await expect(validateTarget('https://api.example.com/', noPolicy, resolver)).rejects.toThrow(SsrfBlockedError);
  });

  it('pins the first validated address', async () => {
    const resolver = staticResolver({ 'api.example.com': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'] });
    const target = await validateTarget('https://api.example.com/', noPolicy, resolver);
    expect(target.pinned).toEqual({ address: '93.184.215.14', family: 4 });
  });

  it('reports unresolvable names as blocked without leaking the query string', async () => {
    const err = await validateTarget('https://nope.example.com/path?token=SECRET', noPolicy, staticResolver({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SsrfBlockedError);
    expect(String((err as Error).message)).not.toContain('SECRET');
  });
});

describe('safeFetch against local mock servers', () => {
  it('reaches an allowlisted exact host:port and pins the connection to the validated address', async () => {
    const s = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    // The synthetic hostname does not exist in real DNS: success proves the pinned address was used.
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }) });
    const res = await fetch(`${s.url}/hello`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(s.requests[0]?.headers.host).toBe(`${s.host}:${s.port}`);
  });

  it('blocks the same loopback server when the port differs from the allowlist entry', async () => {
    const s = await server((_req, res) => res.end('x'));
    const fetch = createSafeFetch({
      policy: { allowlist: [{ ...s.allowlistEntry, port: s.port + 1 }] },
      resolver: staticResolver({ [s.host]: '127.0.0.1' }),
    });
    await expect(fetch(`${s.url}/`)).rejects.toThrow(SsrfBlockedError);
    expect(s.requests).toHaveLength(0);
  });

  it('blocks a redirect to the metadata address', async () => {
    const s = await server((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }) });
    await expect(fetch(`${s.url}/start`)).rejects.toThrow(SsrfBlockedError);
  });

  it('blocks a redirect to a public name that resolves privately', async () => {
    const s = await server((_req, res) => {
      res.writeHead(307, { location: 'https://rebind.example.com/' });
      res.end();
    });
    const fetch = createSafeFetch({
      policy: { allowlist: [s.allowlistEntry] },
      resolver: staticResolver({ [s.host]: '127.0.0.1', 'rebind.example.com': '127.0.0.1' }),
    });
    await expect(fetch(`${s.url}/`)).rejects.toThrow('loopback');
  });

  it('refuses an https to http downgrade redirect', async () => {
    const tls = selfSignedCert(['secure.financialos.test']);
    const plain = await server((_req, res) => res.end('plain'), { host: 'plain.financialos.test' });
    const secure = await server(
      (_req, res) => {
        res.writeHead(302, { location: `${plain.url}/landing` });
        res.end();
      },
      { host: 'secure.financialos.test', tls },
    );
    const fetch = createSafeFetch({
      policy: { allowlist: [secure.allowlistEntry, plain.allowlistEntry] },
      resolver: staticResolver({ [secure.host]: '127.0.0.1', [plain.host]: '127.0.0.1' }),
      ca: tls.cert,
    });
    await expect(fetch(`${secure.url}/`)).rejects.toThrow('non-https');
    expect(plain.requests).toHaveLength(0);
  });

  it('verifies TLS certificates against the hostname (SNI kept)', async () => {
    const tls = selfSignedCert(['secure.financialos.test']);
    const secure = await server((_req, res) => res.end('hi'), { host: 'secure.financialos.test', tls });
    const trusted = createSafeFetch({ policy: { allowlist: [secure.allowlistEntry] }, resolver: staticResolver({ [secure.host]: '127.0.0.1' }), ca: tls.cert });
    expect(await (await trusted(`${secure.url}/`)).text()).toBe('hi');
    const untrusted = createSafeFetch({ policy: { allowlist: [secure.allowlistEntry] }, resolver: staticResolver({ [secure.host]: '127.0.0.1' }) });
    await expect(untrusted(`${secure.url}/`)).rejects.toThrow('Network error');
  });

  it('strips credentials on a cross-origin redirect but keeps them on the same origin', async () => {
    const other = await server((_req, res) => res.end('other'), { host: 'other.financialos.test' });
    const origin = await server((req, res) => {
      if (req.url === '/same') {
        res.writeHead(302, { location: '/cross' });
      } else if (req.url === '/cross') {
        res.writeHead(302, { location: `${other.url}/final` });
      } else {
        res.writeHead(200);
      }
      res.end();
    });
    const fetch = createSafeFetch({
      policy: { allowlist: [origin.allowlistEntry, other.allowlistEntry] },
      resolver: staticResolver({ [origin.host]: '127.0.0.1', [other.host]: '127.0.0.1' }),
    });
    const res = await fetch(`${origin.url}/same`, {
      headers: { authorization: 'Bearer synthetic-token', 'x-custom-key': 'k', 'x-trace': 't' },
      sensitiveHeaders: ['x-custom-key'],
    });
    expect(await res.text()).toBe('other');
    expect(res.redirected).toBe(true);
    expect(origin.requests[1]?.headers.authorization).toBe('Bearer synthetic-token');
    expect(other.requests[0]?.headers.authorization).toBeUndefined();
    expect(other.requests[0]?.headers['x-custom-key']).toBeUndefined();
    expect(other.requests[0]?.headers['x-trace']).toBe('t');
  });

  it('stops after three redirects', async () => {
    const s = await server((req, res) => {
      const n = Number((req.url ?? '/0').slice(1));
      res.writeHead(302, { location: `/${n + 1}` });
      res.end();
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }) });
    await expect(fetch(`${s.url}/0`)).rejects.toThrow(TooManyRedirectsError);
    expect(s.requests).toHaveLength(4);
  });

  it('aborts an oversized response while streaming (no content-length)', async () => {
    const s = await server((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 97);
      let sent = 0;
      const pump = () => {
        while (sent < 40) {
          sent += 1;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }) });
    const res = await fetch(`${s.url}/big`, { maxResponseBytes: 256 * 1024 });
    await expect(res.bytes()).rejects.toThrow(ResponseTooLargeError);
  });

  it('rejects an oversized response declared by content-length', async () => {
    const s = await server((_req, res) => {
      const body = Buffer.alloc(2048, 98);
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }) });
    await expect(fetch(`${s.url}/big`, { maxResponseBytes: 1024 })).rejects.toThrow(ResponseTooLargeError);
  });

  it('times out slow headers', async () => {
    const s = await server((_req, res) => {
      setTimeout(() => res.end('late'), 2_000);
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }) });
    const err = await fetch(`${s.url}/slow`, { headersTimeoutMs: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).phase).toBe('headers');
  });

  it('enforces the total timeout across the whole call', async () => {
    const s = await server((_req, res) => {
      res.writeHead(200);
      res.write('start');
      setTimeout(() => res.end('end'), 2_000);
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }) });
    const res = await fetch(`${s.url}/slow-body`, { totalTimeoutMs: 300 });
    const err = await res.text().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).phase).toBe('total');
  });

  it('honours a caller AbortSignal', async () => {
    const s = await server((_req, res) => {
      setTimeout(() => res.end('late'), 2_000);
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }) });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(fetch(`${s.url}/`, { signal: controller.signal })).rejects.toThrow(RequestAbortedError);
  });

  it('retries idempotent requests on 503 with backoff and succeeds', async () => {
    let calls = 0;
    const s = await server((_req, res) => {
      calls += 1;
      res.writeHead(calls < 3 ? 503 : 200);
      res.end(calls < 3 ? 'busy' : 'ok');
    });
    const sleeps: number[] = [];
    const fetch = createSafeFetch({
      policy: { allowlist: [s.allowlistEntry] },
      resolver: staticResolver({ [s.host]: '127.0.0.1' }),
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
    });
    const res = await fetch(`${s.url}/`, { retry: { maxAttempts: 4, baseDelayMs: 100 } });
    expect(await res.text()).toBe('ok');
    expect(res.attempts).toBe(3);
    expect(sleeps).toEqual([75, 150]);
  });

  it('never retries a POST unless the caller marks it idempotent', async () => {
    const s = await server((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }), sleep: async () => undefined });
    const res = await fetch(`${s.url}/`, { method: 'POST', body: '{}', retry: { maxAttempts: 3 } });
    expect(res.status).toBe(503);
    expect(res.attempts).toBe(1);
    await res.cancel();
    expect(s.requests).toHaveLength(1);
  });

  it('waits for a short Retry-After and gives up on one above the cap', async () => {
    let calls = 0;
    const s = await server((req, res) => {
      calls += 1;
      if (req.url === '/long') {
        res.writeHead(429, { 'retry-after': '3600' });
        return void res.end();
      }
      if (calls === 1) {
        res.writeHead(429, { 'retry-after': '2' });
        return void res.end();
      }
      res.end('ok');
    });
    const sleeps: number[] = [];
    const fetch = createSafeFetch({
      policy: { allowlist: [s.allowlistEntry] },
      resolver: staticResolver({ [s.host]: '127.0.0.1' }),
      sleep: async (ms) => void sleeps.push(ms),
    });
    const short = await fetch(`${s.url}/short`, { retry: { maxAttempts: 3, maxRetryAfterMs: 5_000 } });
    expect(await short.text()).toBe('ok');
    expect(sleeps).toEqual([2000]);

    const long = await fetch(`${s.url}/long`, { retry: { maxAttempts: 3, maxRetryAfterMs: 5_000 } });
    expect(long.status).toBe(429);
    expect(long.attempts).toBe(1);
    expect(long.retryAfterMs).toBe(3_600_000);
    const err = await long.ensureOk().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect((err as HttpStatusError).retryAfterMs).toBe(3_600_000);
    expect(sleeps).toEqual([2000]);
  });

  it('retries network errors for idempotent requests', async () => {
    let calls = 0;
    const s = await server((req, res) => {
      calls += 1;
      if (calls === 1) {
        req.socket.destroy();
        return;
      }
      res.end('recovered');
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }), sleep: async () => undefined });
    const res = await fetch(`${s.url}/`, { retry: { maxAttempts: 2 } });
    expect(await res.text()).toBe('recovered');
  });

  it('keeps query strings and auth headers out of HTTP errors', async () => {
    const s = await server((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }) });
    const res = await fetch(`${s.url}/statement?t=SYNTHETIC-SECRET&q=1`, { headers: { authorization: 'Bearer SYNTHETIC-SECRET' } });
    const err = (await res.ensureOk().catch((e: unknown) => e)) as HttpStatusError;
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.message).toContain('/statement');
    expect(`${err.message} ${err.redactedUrl} ${JSON.stringify(err)}`).not.toContain('SYNTHETIC-SECRET');
  });

  it('limits concurrency per host', async () => {
    let active = 0;
    let peak = 0;
    const s = await server((_req, res) => {
      active += 1;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        res.end('ok');
      }, 50);
    });
    const fetch = createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }), maxConcurrencyPerHost: 2 });
    const results = await Promise.all(Array.from({ length: 6 }, () => fetch(`${s.url}/`).then((r) => r.text())));
    expect(results).toEqual(Array(6).fill('ok'));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('adapts to a WHATWG fetch with streaming bodies', async () => {
    const s = await server((req, res, body) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${req.method}:${body}`);
    });
    const fetch = toFetchLike(createSafeFetch({ policy: { allowlist: [s.allowlistEntry] }, resolver: staticResolver({ [s.host]: '127.0.0.1' }) }));
    const res = await fetch(`${s.url}/echo`, { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } });
    expect(res).toBeInstanceOf(Response);
    expect(await res.text()).toBe('POST:payload');
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(10_000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});
