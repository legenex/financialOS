/**
 * Cookie-aware test client over `app.inject`. It behaves like a browser only where that matters
 * for the tests: it keeps a cookie jar, sends `Origin`, and adds the CSRF header on mutations.
 * Every one of those can be suppressed or overridden so the guards can be attacked directly.
 */
import type { InjectOptions, Response as LightMyRequestResponse } from 'light-my-request';
import { randomInt } from 'node:crypto';
import { SESSION_COOKIE_SECURE } from '../auth/sessions';
import { TEST_ORIGIN, type Harness } from './harness';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface RequestOptions {
  /** `undefined` uses the default test origin; `null` omits the header. */
  origin?: string | null;
  /** `undefined` uses the stored token on unsafe methods; `null` omits it; a string is sent verbatim. */
  csrf?: string | null;
  /** Sends `X-FOS-Background: 1`. */
  background?: boolean;
  headers?: Record<string, string>;
  /** Do not send the cookie jar. */
  noCookies?: boolean;
  /** Overrides the client address presented through X-Forwarded-For. */
  ip?: string;
  payload?: unknown;
  query?: Record<string, string>;
  /** Value for Sec-Fetch-Site. */
  secFetchSite?: string;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function randomTestIp(): string {
  // TEST-NET-3 (RFC 5737): documentation range, never routable.
  return `203.0.113.${randomInt(1, 255)}`;
}

export class TestClient {
  readonly cookies = new Map<string, string>();
  csrfToken: string | null = null;
  ip: string;
  readonly #harness: Harness;

  constructor(harness: Harness, options: { ip?: string } = {}) {
    this.#harness = harness;
    this.ip = options.ip ?? randomTestIp();
  }

  get sessionCookie(): string | undefined {
    return this.cookies.get(SESSION_COOKIE_SECURE);
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  #absorb(response: LightMyRequestResponse): void {
    for (const cookie of response.cookies as Array<{ name: string; value: string; expires?: Date; maxAge?: number }>) {
      const cleared = cookie.value === '' || cookie.maxAge === 0 || (cookie.expires instanceof Date && cookie.expires.getTime() <= this.#harness.clock.epochMs);
      if (cleared) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    if (response.headers['content-type']?.toString().includes('application/json')) {
      try {
        const body = response.json() as Record<string, unknown>;
        const session = body?.session as Record<string, unknown> | undefined;
        const token = (session?.csrfToken ?? body?.csrfToken) as unknown;
        if (typeof token === 'string') this.csrfToken = token;
      } catch {
        // Not JSON after all; nothing to learn.
      }
    }
  }

  async request(method: HttpMethod, url: string, options: RequestOptions = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { 'x-forwarded-for': options.ip ?? this.ip };
    if (options.origin !== null) headers.origin = options.origin ?? TEST_ORIGIN;
    if (options.secFetchSite) headers['sec-fetch-site'] = options.secFetchSite;
    if (options.background) headers['x-fos-background'] = '1';
    if (!SAFE.has(method)) {
      if (options.csrf === undefined) {
        if (this.csrfToken) headers['x-csrf-token'] = this.csrfToken;
      } else if (options.csrf !== null) {
        headers['x-csrf-token'] = options.csrf;
      }
    }
    if (!options.noCookies) {
      const cookie = this.cookieHeader();
      if (cookie) headers.cookie = cookie;
    }
    Object.assign(headers, options.headers ?? {});

    const inject: InjectOptions = { method, url, headers, remoteAddress: '127.0.0.1' };
    if (options.query) inject.query = options.query;
    if (options.payload !== undefined) {
      inject.payload = options.payload as InjectOptions['payload'];
      if (typeof options.payload === 'object' && options.payload !== null && !headers['content-type']) {
        headers['content-type'] = 'application/json';
      }
    }
    const response = await this.#harness.app.inject(inject);
    this.#absorb(response);
    return response;
  }

  get(url: string, options: RequestOptions = {}): Promise<LightMyRequestResponse> {
    return this.request('GET', url, options);
  }

  post(url: string, payload?: unknown, options: RequestOptions = {}): Promise<LightMyRequestResponse> {
    return this.request('POST', url, { ...options, ...(payload === undefined ? {} : { payload }) });
  }

  put(url: string, payload?: unknown, options: RequestOptions = {}): Promise<LightMyRequestResponse> {
    return this.request('PUT', url, { ...options, ...(payload === undefined ? {} : { payload }) });
  }

  del(url: string, options: RequestOptions = {}): Promise<LightMyRequestResponse> {
    return this.request('DELETE', url, options);
  }
}

/** Parses the raw `set-cookie` header(s) of a response. */
export function setCookieHeaders(response: LightMyRequestResponse): string[] {
  const raw = response.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

export function setCookieFor(response: LightMyRequestResponse, name: string): string | undefined {
  return setCookieHeaders(response).find((line) => line.startsWith(`${name}=`));
}

export function errorCodeOf(response: LightMyRequestResponse): string | undefined {
  try {
    return (response.json() as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}
