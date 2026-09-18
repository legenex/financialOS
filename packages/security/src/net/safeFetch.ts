import type { LookupAddress } from 'node:dns';
import type { Readable } from 'node:stream';
import { rootCertificates } from 'node:tls';
import { Agent, request as undiciRequest } from 'undici';
import {
  HttpStatusError,
  InvalidRequestError,
  NetworkError,
  OutboundRequestError,
  RequestAbortedError,
  ResponseTooLargeError,
  SsrfBlockedError,
  TimeoutError,
  TooManyRedirectsError,
  redactUrlForError,
} from './errors';
import { type OutboundPolicy, type Resolver, type ValidatedTarget, systemResolver, validateTarget } from './policy';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface RetryOptions {
  /** Total attempts including the first (1–6). */
  maxAttempts: number;
  /**
   * Whether repeating the request is safe. Defaults to true for GET/HEAD/OPTIONS and false otherwise.
   * Non-idempotent requests are never retried unless the caller explicitly sets this.
   */
  idempotent?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Longest Retry-After the client will wait. A longer server request ends retrying and is reported. */
  maxRetryAfterMs?: number;
}

export interface SafeFetchOptions {
  method?: HttpMethod;
  headers?: Record<string, string> | Headers | Array<[string, string]>;
  body?: string | Uint8Array | URLSearchParams | null;
  signal?: AbortSignal;
  /** Default 'follow' (max 3 hops, each re-validated). */
  redirect?: 'follow' | 'manual' | 'error';
  maxRedirects?: number;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  /** Maximum idle time between body chunks. */
  bodyTimeoutMs?: number;
  /** Wall-clock budget for the whole call, including redirects, retries, and reading the body. */
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  retry?: RetryOptions;
  /** Extra header names (case-insensitive) that carry credentials and must be dropped on cross-origin redirects. */
  sensitiveHeaders?: readonly string[];
}

export interface SafeFetchConfig {
  policy: OutboundPolicy;
  resolver?: Resolver;
  maxConcurrencyPerHost?: number;
  userAgent?: string;
  /** Extra trusted CA certificates (PEM) for owner-allowlisted internal HTTPS endpoints. */
  ca?: string | readonly string[];
  /** Test seams. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  defaults?: Partial<Pick<SafeFetchOptions, 'connectTimeoutMs' | 'headersTimeoutMs' | 'bodyTimeoutMs' | 'totalTimeoutMs' | 'maxResponseBytes'>>;
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Final URL. May contain query parameters: never log it; use redactedUrl. */
  url: string;
  redactedUrl: string;
  redirected: boolean;
  attempts: number;
  /** Parsed Retry-After in milliseconds, when the server sent one. */
  retryAfterMs: number | null;
  /** Byte-limited body stream. */
  body: ReadableStream<Uint8Array> | null;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  /** Discards the body and releases the connection. */
  cancel(): Promise<void>;
  /** Throws HttpStatusError (redacted URL) for non-2xx responses, after discarding the body. */
  ensureOk(): Promise<SafeResponse>;
}

export type SafeFetch = (url: string | URL, options?: SafeFetchOptions) => Promise<SafeResponse>;

const DEFAULTS = {
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 30_000,
  bodyTimeoutMs: 30_000,
  totalTimeoutMs: 60_000,
  maxResponseBytes: 10 * 1024 * 1024,
  maxRedirects: 3,
};
const HARD_MAX_REDIRECTS = 3;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALWAYS_SENSITIVE = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'x-auth-token', 'x-access-token'];
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Parses Retry-After (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{1,10}$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

class HostLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  constructor(private readonly limit: number) {}

  async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    const current = this.active.get(key) ?? 0;
    if (current >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const queue = this.waiting.get(key) ?? [];
        const entry = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const q = this.waiting.get(key) ?? [];
          const idx = q.indexOf(entry);
          if (idx >= 0) q.splice(idx, 1);
          reject(signal.reason);
        };
        queue.push(entry);
        this.waiting.set(key, queue);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    } else {
      this.active.set(key, current + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.waiting.get(key);
      const next = queue?.shift();
      if (next) {
        next();
      } else {
        const n = (this.active.get(key) ?? 1) - 1;
        if (n <= 0) this.active.delete(key);
        else this.active.set(key, n);
      }
    };
  }
}

function toHeaderRecord(input: SafeFetchOptions['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  const entries: Iterable<[string, string]> = input instanceof Headers ? input.entries() : Array.isArray(input) ? input : Object.entries(input);
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) throw new InvalidRequestError('invalid header name', null);
    if (/[\r\n\0]/.test(v)) throw new InvalidRequestError('invalid header value', null);
    out[key] = v;
  }
  return out;
}

function toWebHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.append(k, v);
  }
  return headers;
}

/** Destroys an undici body without surfacing its synthetic abort error as an uncaught exception. */
function discard(body: Readable): void {
  body.on('error', () => undefined);
  body.destroy();
}

function errorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function mapError(err: unknown, redacted: string, signals: { total: AbortSignal; caller: AbortSignal | undefined }, limit: number): OutboundRequestError {
  if (err instanceof OutboundRequestError) return err;
  if (signals.total.aborted && !(signals.caller?.aborted ?? false)) return new TimeoutError('total', redacted);
  if (signals.caller?.aborted) return new RequestAbortedError(redacted);
  const code = errorCode(err);
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return new TimeoutError('connect', redacted);
  if (code === 'UND_ERR_HEADERS_TIMEOUT') return new TimeoutError('headers', redacted);
  if (code === 'UND_ERR_BODY_TIMEOUT') return new TimeoutError('body', redacted);
  if (code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE') return new ResponseTooLargeError(limit, redacted);
  if (code === 'UND_ERR_ABORTED' || (err instanceof Error && err.name === 'AbortError')) return new RequestAbortedError(redacted);
  return new NetworkError(code, redacted, err);
}

function pinnedLookup(target: ValidatedTarget) {
  const pinned: LookupAddress = { address: target.pinned.address, family: target.pinned.family };
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: (...args: unknown[]) => void) => {
    const cb = typeof options === 'function' ? (options as (...args: unknown[]) => void) : callback;
    if (hostname.toLowerCase().replace(/\.$/, '') !== target.host) {
      cb(new SsrfBlockedError('unexpected hostname during connect', redactUrlForError(target.url)));
      return;
    }
    const all = typeof options === 'object' && options !== null && options.all === true;
    if (all) cb(null, [pinned]);
    else cb(null, pinned.address, pinned.family);
  };
}

interface AttemptResult {
  status: number;
  headers: Headers;
  body: Readable;
  agent: Agent;
  release: () => void;
  target: ValidatedTarget;
}

/**
 * Creates an SSRF-guarded fetch bound to an outbound policy. Every call resolves DNS itself, validates each
 * address, pins the connection to a validated address (preventing DNS rebinding), and re-validates each
 * redirect hop.
 */
export function createSafeFetch(config: SafeFetchConfig): SafeFetch {
  const resolver = config.resolver ?? systemResolver;
  const limiter = new HostLimiter(Math.max(1, config.maxConcurrencyPerHost ?? 4));
  const sleep = config.sleep ?? defaultSleep;
  const now = config.now ?? Date.now;
  const random = config.random ?? Math.random;
  // Extra CAs are added to (never substituted for) Node's bundled roots.
  const extraCa = config.ca ? [...rootCertificates, ...(typeof config.ca === 'string' ? [config.ca] : config.ca)] : null;

  async function attempt(
    target: ValidatedTarget,
    method: HttpMethod,
    headers: Record<string, string>,
    body: string | Uint8Array | null,
    opts: Required<Pick<SafeFetchOptions, 'connectTimeoutMs' | 'headersTimeoutMs' | 'bodyTimeoutMs' | 'maxResponseBytes'>>,
    signal: AbortSignal,
  ): Promise<AttemptResult> {
    const release = await limiter.acquire(`${target.scheme}://${target.host}:${target.port}`, signal);
    const agent = new Agent({
      connect: {
        timeout: opts.connectTimeoutMs,
        lookup: pinnedLookup(target) as never,
        ...(target.literal ? {} : { servername: target.host }),
        ...(extraCa ? { ca: extraCa } : {}),
      },
      allowH2: false,
      connections: 1,
      pipelining: 0,
      headersTimeout: opts.headersTimeoutMs,
      bodyTimeout: opts.bodyTimeoutMs,
      maxResponseSize: opts.maxResponseBytes,
    });
    try {
      const res = await undiciRequest(target.url, {
        method,
        headers,
        body: body ?? undefined,
        signal,
        dispatcher: agent,
        headersTimeout: opts.headersTimeoutMs,
        bodyTimeout: opts.bodyTimeoutMs,
      });
      return {
        status: res.statusCode,
        headers: toWebHeaders(res.headers as Record<string, string | string[] | undefined>),
        body: res.body as unknown as Readable,
        agent,
        release,
        target,
      };
    } catch (err) {
      release();
      agent.destroy().catch(() => undefined);
      throw err;
    }
  }

  return async function safeFetch(input, options = {}) {
    const method = (options.method ?? 'GET').toUpperCase() as HttpMethod;
    const initialRedacted = redactUrlForError(typeof input === 'string' ? input : input.href);
    const opts = {
      connectTimeoutMs: options.connectTimeoutMs ?? config.defaults?.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      headersTimeoutMs: options.headersTimeoutMs ?? config.defaults?.headersTimeoutMs ?? DEFAULTS.headersTimeoutMs,
      bodyTimeoutMs: options.bodyTimeoutMs ?? config.defaults?.bodyTimeoutMs ?? DEFAULTS.bodyTimeoutMs,
      maxResponseBytes: options.maxResponseBytes ?? config.defaults?.maxResponseBytes ?? DEFAULTS.maxResponseBytes,
    };
    const totalTimeoutMs = options.totalTimeoutMs ?? config.defaults?.totalTimeoutMs ?? DEFAULTS.totalTimeoutMs;
    const maxRedirects = Math.min(options.maxRedirects ?? DEFAULTS.maxRedirects, HARD_MAX_REDIRECTS);
    const redirectMode = options.redirect ?? 'follow';
    const sensitive = new Set([...ALWAYS_SENSITIVE, ...(options.sensitiveHeaders ?? []).map((h) => h.toLowerCase())]);

    const baseHeaders = toHeaderRecord(options.headers);
    if (config.userAgent && !baseHeaders['user-agent']) baseHeaders['user-agent'] = config.userAgent;
    let baseBody: string | Uint8Array | null = null;
    if (options.body instanceof URLSearchParams) {
      baseBody = options.body.toString();
      baseHeaders['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (options.body !== undefined && options.body !== null) {
      baseBody = options.body;
    }
    if (baseBody !== null && (method === 'GET' || method === 'HEAD')) throw new InvalidRequestError('GET/HEAD requests cannot have a body', initialRedacted);

    const retry = options.retry;
    const idempotent = retry?.idempotent ?? (method === 'GET' || method === 'HEAD' || method === 'OPTIONS');
    const maxAttempts = retry && idempotent ? Math.min(Math.max(1, retry.maxAttempts), 6) : 1;
    const baseDelay = retry?.baseDelayMs ?? 500;
    const maxDelay = retry?.maxDelayMs ?? 10_000;
    const maxRetryAfter = retry?.maxRetryAfterMs ?? 30_000;

    const totalController = new AbortController();
    const totalTimer = setTimeout(() => totalController.abort(new TimeoutError('total', initialRedacted)), totalTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, totalController.signal]) : totalController.signal;
    const signals = { total: totalController.signal, caller: options.signal };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(totalTimer);
    };

    const performWithRedirects = async (): Promise<AttemptResult & { redirected: boolean }> => {
      let currentUrl: URL = typeof input === 'string' ? new URL(input) : new URL(input.href);
      let currentMethod = method;
      let currentBody = baseBody;
      let headers = { ...baseHeaders };
      let redirected = false;
      for (let hop = 0; ; hop += 1) {
        const target = await validateTarget(currentUrl, config.policy, resolver);
        const result = await attempt(target, currentMethod, headers, currentBody, opts, signal);
        const location = result.headers.get('location');
        if (redirectMode === 'manual' || !REDIRECT_STATUSES.has(result.status) || !location) {
          return { ...result, redirected };
        }
        // Redirect handling: discard this body before following.
        discard(result.body);
        result.release();
        result.agent.destroy().catch(() => undefined);
        const redacted = redactUrlForError(currentUrl);
        if (redirectMode === 'error') throw new SsrfBlockedError('redirects are not allowed for this request', redacted);
        if (hop >= maxRedirects) throw new TooManyRedirectsError(maxRedirects, redacted);
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          throw new SsrfBlockedError('invalid redirect location', redacted);
        }
        if (currentUrl.protocol === 'https:' && next.protocol !== 'https:') {
          throw new SsrfBlockedError('redirect from https to a non-https URL was refused', redacted);
        }
        if (next.origin !== currentUrl.origin) {
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !sensitive.has(k)));
        }
        if (result.status === 303 || ((result.status === 301 || result.status === 302) && currentMethod === 'POST')) {
          if (currentMethod !== 'HEAD') currentMethod = 'GET';
          currentBody = null;
          delete headers['content-type'];
          delete headers['content-length'];
        }
        currentUrl = next;
        redirected = true;
      }
    };

    try {
      let attemptNo = 0;
      for (;;) {
        attemptNo += 1;
        let result: (AttemptResult & { redirected: boolean }) | null = null;
        let failure: OutboundRequestError | null = null;
        try {
          result = await performWithRedirects();
        } catch (err) {
          failure = mapError(err, initialRedacted, signals, opts.maxResponseBytes);
        }
        if (failure) {
          const retryable = failure instanceof NetworkError || (failure instanceof TimeoutError && failure.phase !== 'total');
          const code = failure instanceof NetworkError ? failure.networkCode : null;
          const networkRetryable = failure instanceof TimeoutError || (code !== null && RETRYABLE_NETWORK_CODES.has(code)) || code === null;
          if (retryable && networkRetryable && attemptNo < maxAttempts) {
            await sleep(backoff(attemptNo), signal).catch((e: unknown) => {
              throw mapError(e, initialRedacted, signals, opts.maxResponseBytes);
            });
            continue;
          }
          throw failure;
        }
        const res = result!;
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), now());
        if (RETRY_STATUSES.has(res.status) && attemptNo < maxAttempts && (retryAfterMs === null || retryAfterMs <= maxRetryAfter)) {
          discard(res.body);
          res.release();
          res.agent.destroy().catch(() => undefined);
          const wait = retryAfterMs ?? backoff(attemptNo);
          await sleep(wait, signal).catch((e: unknown) => {
            throw mapError(e, initialRedacted, signals, opts.maxResponseBytes);
          });
          continue;
        }
        return wrapResponse(res, attemptNo, retryAfterMs);
      }
    } catch (err) {
      finish();
      throw err;
    }

    function backoff(attemptNo: number): number {
      const exp = Math.min(maxDelay, baseDelay * 2 ** (attemptNo - 1));
      return Math.round(exp / 2 + random() * (exp / 2));
    }

    function wrapResponse(res: AttemptResult & { redirected: boolean }, attempts: number, retryAfterMs: number | null): SafeResponse {
      const finalUrl = res.target.url.href;
      const redacted = redactUrlForError(res.target.url);
      const limit = opts.maxResponseBytes;
      let cleaned = false;
      const cleanup = (destroy: boolean) => {
        if (cleaned) return;
        cleaned = true;
        res.release();
        finish();
        if (destroy) res.agent.destroy().catch(() => undefined);
        else res.agent.close().catch(() => undefined);
      };
      const noBody = method === 'HEAD' || res.status === 204 || res.status === 205 || res.status === 304;
      let received = 0;
      const iterator = (res.body as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
      const stream: ReadableStream<Uint8Array> | null = noBody
        ? null
        : new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { value, done } = await iterator.next();
                if (done) {
                  controller.close();
                  cleanup(false);
                  return;
                }
                received += value.byteLength;
                if (received > limit) {
                  discard(res.body);
                  cleanup(true);
                  controller.error(new ResponseTooLargeError(limit, redacted));
                  return;
                }
                controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
              } catch (err) {
                cleanup(true);
                controller.error(mapError(err, redacted, signals, limit));
              }
            },
            cancel() {
              discard(res.body);
              cleanup(true);
            },
          });
      if (noBody) {
        discard(res.body);
        cleanup(false);
      }
      const declared = res.headers.get('content-length');
      if (stream && declared && /^\d+$/.test(declared) && Number(declared) > limit) {
        discard(res.body);
        cleanup(true);
        throw new ResponseTooLargeError(limit, redacted);
      }
      let used = false;
      const readAll = async (): Promise<Uint8Array> => {
        if (used) throw new InvalidRequestError('response body already consumed', redacted);
        used = true;
        if (!stream) return new Uint8Array(0);
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          size += value.byteLength;
        }
        const out = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.byteLength;
        }
        return out;
      };
      const response: SafeResponse = {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers: res.headers,
        url: finalUrl,
        redactedUrl: redacted,
        redirected: res.redirected,
        attempts,
        retryAfterMs,
        body: stream,
        bytes: readAll,
        text: async () => new TextDecoder('utf-8', { fatal: false }).decode(await readAll()),
        json: async <T>() => {
          const text = new TextDecoder('utf-8', { fatal: false }).decode(await readAll());
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new InvalidRequestError('response was not valid JSON', redacted);
          }
        },
        cancel: async () => {
          if (stream && !used) {
            used = true;
            await stream.cancel().catch(() => undefined);
          }
          cleanup(true);
        },
        ensureOk: async () => {
          if (response.ok) return response;
          await response.cancel();
          throw new HttpStatusError(res.status, redacted, retryAfterMs);
        },
      };
      return response;
    }
  };
}

/**
 * Adapts a SafeFetch to the WHATWG fetch signature (for libraries such as the MCP SDK that accept a custom
 * fetch). Streaming bodies are preserved.
 */
export function toFetchLike(safeFetch: SafeFetch, defaults: SafeFetchOptions = {}): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input;
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() as HttpMethod;
    const headers: Record<string, string> = {};
    const sourceHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((v, k) => sourceHeaders.set(k, v));
    sourceHeaders.forEach((v, k) => {
      headers[k] = v;
    });
    let body: string | Uint8Array | URLSearchParams | null = null;
    const rawBody = init.body;
    if (typeof rawBody === 'string' || rawBody instanceof URLSearchParams) body = rawBody;
    else if (rawBody instanceof Uint8Array) body = rawBody;
    else if (rawBody instanceof ArrayBuffer) body = new Uint8Array(rawBody);
    else if (rawBody !== undefined && rawBody !== null) throw new InvalidRequestError('unsupported request body type', null);
    const res = await safeFetch(url, {
      ...defaults,
      method,
      headers,
      body,
      signal: init.signal ?? defaults.signal,
      redirect: init.redirect === 'manual' ? 'manual' : init.redirect === 'error' ? 'error' : (defaults.redirect ?? 'follow'),
    });
    const nullBody = res.status === 204 || res.status === 205 || res.status === 304 || method === 'HEAD';
    if (nullBody) await res.cancel();
    return new Response(nullBody ? null : res.body, { status: res.status, headers: res.headers });
  };
}
