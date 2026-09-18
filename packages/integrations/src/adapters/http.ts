import type { HttpMethod, SafeFetch, SafeResponse } from '@financialos/security/net';
import type { AdapterLogger } from '../core/context';
import {
  CredentialExpiredError,
  IntegrationError,
  ProviderRateLimitedError,
  ProviderRequestError,
  ProviderResponseError,
  ProviderUnavailableError,
  ReadOnlyViolationError,
} from '../core/errors';
import { parseJsonLossless } from '../core/json';
import { redactUrl } from '../core/redact';

/**
 * A small JSON client for provider REST APIs. It is deliberately GET-only: the method is not a parameter the
 * caller can widen, so no adapter built on it can reach a payment, transfer, or trading endpoint even by
 * mistake. Bodies are parsed losslessly, so provider amounts never touch binary floating point.
 */

export interface JsonClientConfig {
  safeFetch: SafeFetch;
  /** Absolute base, e.g. https://api.example.com/api/v1 . */
  baseUrl: string;
  /** Sent on every request. Credential headers belong here. */
  headers?: Record<string, string>;
  /** Header names (lower-case) that carry credentials and must be dropped on cross-origin redirects. */
  sensitiveHeaders?: readonly string[];
  /** Secret values to scrub from any message this client produces. */
  secrets?: readonly string[];
  logger?: AdapterLogger;
  signal?: AbortSignal;
  maxResponseBytes?: number;
  totalTimeoutMs?: number;
  /** Total attempts for retryable failures (429/5xx/network). */
  maxAttempts?: number;
  /** Label used in error messages, e.g. "Mercury". */
  providerLabel: string;
}

export interface JsonRequest {
  path: string;
  query?: Record<string, string | number | null | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Overrides the client default for this call. */
  maxResponseBytes?: number;
  /** Accept 404 as an empty result instead of throwing. */
  allowNotFound?: boolean;
}

export interface JsonResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** Losslessly parsed body: JSON numbers arrive as JsonNumber, never as JS floats. */
  data: T;
  /** Raw text, bounded by maxResponseBytes. */
  text: string;
  redactedUrl: string;
}

export interface JsonClient {
  get<T = unknown>(request: JsonRequest): Promise<JsonResponse<T>>;
  /** Fetches a document (XML, CSV) as text. Still GET-only. */
  getText(request: JsonRequest): Promise<{ status: number; headers: Headers; text: string; redactedUrl: string }>;
  /** Absolute URL for a path, for logging only (already redacted). */
  describe(path: string): string;
}

const DEFAULTS = { maxResponseBytes: 8 * 1024 * 1024, totalTimeoutMs: 45_000, maxAttempts: 4 };

/**
 * Resolves a path against the configured base. The result must stay inside the base origin *and* under the
 * base path, so a configured path can never walk out of the endpoint it was scoped to.
 */
export function joinUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const parsedBase = new URL(base);
  const rel = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(rel, parsedBase);
  if (url.origin !== parsedBase.origin || !url.pathname.startsWith(parsedBase.pathname)) {
    throw new ProviderRequestError('Resolved URL left the configured base origin', null);
  }
  return url;
}

/** Maps a provider HTTP status to a typed integration error. Never includes the response body or the query. */
export function statusToError(providerLabel: string, response: { status: number; retryAfterMs: number | null }, redactedUrl: string): IntegrationError {
  const { status } = response;
  if (status === 401) return new CredentialExpiredError(`${providerLabel} rejected the stored credential (HTTP 401). Replace or reconnect it.`);
  if (status === 403) return new CredentialExpiredError(`${providerLabel} refused the stored credential (HTTP 403). Check its permissions, then replace or reconnect it.`);
  if (status === 429) return new ProviderRateLimitedError(`${providerLabel} rate-limited the request (HTTP 429) at ${redactedUrl}`, response.retryAfterMs);
  if (status >= 500) return new ProviderUnavailableError(`${providerLabel} returned HTTP ${status} at ${redactedUrl}`);
  return new ProviderRequestError(`${providerLabel} returned HTTP ${status} at ${redactedUrl}`, status);
}

function buildUrl(baseUrl: string, request: JsonRequest): URL {
  const url = joinUrl(baseUrl, request.path);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * Creates a GET-only JSON client. The HTTP verb is not a caller-supplied parameter; the single internal
 * request function refuses anything but GET with ReadOnlyViolationError.
 */
export function createJsonClient(config: JsonClientConfig): JsonClient {
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
  const totalTimeoutMs = config.totalTimeoutMs ?? DEFAULTS.totalTimeoutMs;
  const maxAttempts = Math.min(Math.max(1, config.maxAttempts ?? DEFAULTS.maxAttempts), 6);

  const perform = async (method: HttpMethod, request: JsonRequest): Promise<{ response: SafeResponse; text: string; redactedUrl: string }> => {
    if (method !== 'GET') throw new ReadOnlyViolationError(`${config.providerLabel} client attempted ${method}`);
    const url = buildUrl(config.baseUrl, request);
    const redactedUrl = redactUrl(url);
    const signal = request.signal ?? config.signal;
    let response: SafeResponse;
    try {
      response = await config.safeFetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...config.headers, ...request.headers },
        ...(signal ? { signal } : {}),
        maxResponseBytes: request.maxResponseBytes ?? maxResponseBytes,
        totalTimeoutMs,
        redirect: 'follow',
        ...(config.sensitiveHeaders ? { sensitiveHeaders: config.sensitiveHeaders } : {}),
        retry: { maxAttempts, idempotent: true },
      });
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      const name = err instanceof Error ? err.name : 'Error';
      if (name === 'AbortError') throw err;
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'http_status') {
        const status = (err as { status?: number }).status ?? 0;
        throw statusToError(config.providerLabel, { status, retryAfterMs: (err as { retryAfterMs?: number | null }).retryAfterMs ?? null }, redactedUrl);
      }
      throw new ProviderUnavailableError(`${config.providerLabel} could not be reached (${name}) at ${redactedUrl}`, err);
    }
    if (response.status === 404 && request.allowNotFound) {
      await response.cancel();
      return { response, text: '', redactedUrl };
    }
    if (!response.ok) {
      await response.cancel();
      config.logger?.warn('provider request failed', { provider: config.providerLabel, status: response.status, url: redactedUrl });
      throw statusToError(config.providerLabel, response, redactedUrl);
    }
    const text = await response.text();
    return { response, text, redactedUrl };
  };

  return {
    async get<T>(request: JsonRequest): Promise<JsonResponse<T>> {
      const { response, text, redactedUrl } = await perform('GET', request);
      if (response.status === 404 && request.allowNotFound) {
        return { status: 404, headers: response.headers, data: null as T, text: '', redactedUrl };
      }
      let data: unknown;
      try {
        data = text.trim() === '' ? null : parseJsonLossless(text);
      } catch {
        throw new ProviderResponseError(`${config.providerLabel} returned a body that is not valid JSON at ${redactedUrl}`);
      }
      return { status: response.status, headers: response.headers, data: data as T, text, redactedUrl };
    },
    async getText(request: JsonRequest) {
      const { response, text, redactedUrl } = await perform('GET', request);
      return { status: response.status, headers: response.headers, text, redactedUrl };
    },
    describe(path: string): string {
      try {
        return redactUrl(joinUrl(config.baseUrl, path));
      } catch {
        return '[invalid-url]';
      }
    },
  };
}

// The point of this class is to match control characters, so the lint rule that forbids them is waived here.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2066-\\u2069\\uFEFF]', 'g');

/**
 * Reduces provider-supplied free text to inert data: control characters, bidirectional overrides, and
 * zero-width marks are removed and the length is bounded. Provider text is never instructions.
 */
export function inertText(value: unknown, max = 500): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed;
}
