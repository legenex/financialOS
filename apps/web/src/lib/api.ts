import { z } from 'zod';
import { ApiError as ApiErrorBody } from '@financialos/contracts';

/**
 * Fetch wrapper for the FinancialOS API.
 *
 * - Same-origin cookies only; no tokens in storage.
 * - Mutations carry X-CSRF-Token from the in-memory session.
 * - Background polling sends X-FOS-Background: 1 so it never counts as activity.
 * - Responses are validated with the shared zod contracts.
 * - Any 401 from a private endpoint triggers the global lock (see session.tsx).
 */

export type ApiErrorKind = 'network' | 'aborted' | 'session' | 'not_available' | 'client' | 'server' | 'invalid_response' | 'locked';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, message: string, details?: unknown, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get kind(): ApiErrorKind {
    if (this.code === 'aborted') return 'aborted';
    if (this.code === 'session_locked') return 'locked';
    if (this.status === 0) return 'network';
    if (this.status === 401) return 'session';
    if (this.status === 404 || this.status === 405 || this.status === 501 || this.code === 'not_implemented') return 'not_available';
    if (this.code === 'invalid_response') return 'invalid_response';
    if (this.status >= 500) return 'server';
    return 'client';
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  schema?: z.ZodType<T>;
  query?: Record<string, QueryValue>;
  /** Polling / status checks. Never counts as session activity on the server. */
  background?: boolean;
  signal?: AbortSignal;
  /** Public endpoints (setup, login, launch) neither need nor end a session. */
  public?: boolean;
}

const state = {
  csrfToken: null as string | null,
  privateEnabled: true,
  onSessionEnded: null as ((error: ApiError) => void) | null,
  inflight: new Set<AbortController>(),
};

export function setCsrfToken(token: string | null): void {
  state.csrfToken = token;
}

/** Closes the gate for private requests while locked, so nothing new is sent after expiry. */
export function setPrivateRequestsEnabled(enabled: boolean): void {
  state.privateEnabled = enabled;
}

export function setSessionEndedHandler(handler: ((error: ApiError) => void) | null): void {
  state.onSessionEnded = handler;
}

/** Aborts every in-flight request (used on lock and logout). */
export function abortAllRequests(): void {
  for (const controller of state.inflight) controller.abort();
  state.inflight.clear();
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

function statusCode(status: number): string {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'session_expired';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 410) return 'gone';
  if (status === 429) return 'rate_limited';
  if (status === 501) return 'not_implemented';
  return status >= 500 ? 'server_error' : 'request_failed';
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Your session has ended.';
  if (status === 403) return 'This action is not allowed.';
  if (status === 404 || status === 405) return 'This part of FinancialOS is not available on this server yet.';
  if (status === 429) return 'Too many attempts. Wait a moment and try again.';
  if (status === 501) return 'This feature is not implemented on the server yet.';
  if (status >= 500) return 'FinancialOS hit a server error. Try again shortly.';
  return 'The request could not be completed.';
}

function retryAfterFromDetails(details: unknown): number | null {
  if (details && typeof details === 'object' && 'retryAfterSeconds' in details) {
    const value = (details as { retryAfterSeconds: unknown }).retryAfterSeconds;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export async function api<T = unknown>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const method = options.method ?? 'GET';
  if (!options.public && !state.privateEnabled) {
    throw new ApiError(401, 'session_locked', 'The session has ended. Sign in again to continue.');
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  if (options.background) headers['X-FOS-Background'] = '1';

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  state.inflight.add(controller);

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new ApiError(0, 'aborted', 'The request was cancelled.');
    throw new ApiError(0, 'network_error', 'Could not reach FinancialOS. Check your connection and try again.', String(error));
  } finally {
    state.inflight.delete(controller);
    options.signal?.removeEventListener('abort', onAbort);
  }

  const retryAfterHeader = response.headers.get('Retry-After');
  const retryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number.parseInt(retryAfterHeader, 10) : null;
  const contentType = response.headers.get('Content-Type') ?? '';
  let json: unknown = undefined;
  if (response.status !== 204 && contentType.includes('json')) {
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
  }

  if (!response.ok) {
    const parsed = ApiErrorBody.safeParse(json);
    const code = parsed.success ? parsed.data.error.code : statusCode(response.status);
    const message = parsed.success ? parsed.data.error.message : defaultMessage(response.status);
    const details = parsed.success ? parsed.data.error.details : undefined;
    const error = new ApiError(response.status, code, message, details, retryAfter ?? retryAfterFromDetails(details));
    if (response.status === 401 && !options.public) state.onSessionEnded?.(error);
    throw error;
  }

  if (response.status === 204) return undefined as T;
  if (json === undefined) {
    if (!options.schema) return undefined as T;
    throw new ApiError(response.status, 'invalid_response', 'FinancialOS returned a response this screen cannot read.');
  }
  if (!options.schema) return json as T;
  const result = options.schema.safeParse(json);
  if (!result.success) {
    throw new ApiError(response.status, 'invalid_response', 'FinancialOS returned data this screen does not understand.', z.prettifyError(result.error));
  }
  return result.data;
}

/**
 * Multipart upload (statement imports, documents). Same cookie/CSRF/session handling as `api()`, but the
 * browser sets the multipart Content-Type (with boundary) itself, so `form` is sent as-is with no headers set.
 */
export async function apiUpload<T = unknown>(path: string, form: FormData, options: { schema?: z.ZodType<T>; signal?: AbortSignal } = {}): Promise<T> {
  if (!state.privateEnabled) {
    throw new ApiError(401, 'session_locked', 'The session has ended. Sign in again to continue.');
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  state.inflight.add(controller);

  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', headers, body: form, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ApiError(0, 'aborted', 'The request was cancelled.');
    throw new ApiError(0, 'network_error', 'Could not reach FinancialOS. Check your connection and try again.', String(error));
  } finally {
    state.inflight.delete(controller);
    options.signal?.removeEventListener('abort', onAbort);
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  let json: unknown = undefined;
  if (response.status !== 204 && contentType.includes('json')) {
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
  }

  if (!response.ok) {
    const parsed = ApiErrorBody.safeParse(json);
    const code = parsed.success ? parsed.data.error.code : statusCode(response.status);
    const message = parsed.success ? parsed.data.error.message : defaultMessage(response.status);
    const error = new ApiError(response.status, code, message, parsed.success ? parsed.data.error.details : undefined);
    if (response.status === 401) state.onSessionEnded?.(error);
    throw error;
  }
  if (response.status === 204) return undefined as T;
  if (!options.schema) return json as T;
  const result = options.schema.safeParse(json);
  if (!result.success) {
    throw new ApiError(response.status, 'invalid_response', 'FinancialOS returned data this screen does not understand.', z.prettifyError(result.error));
  }
  return result.data;
}

/** Accepts either a bare array or `{ items: [...] }`, the two list shapes used by the API. */
export function listOf<S extends z.ZodType>(item: S) {
  return z
    .union([z.array(item), z.object({ items: z.array(item) }).loose()])
    .transform((value): z.infer<S>[] => (Array.isArray(value) ? value : (value.items as z.infer<S>[])));
}

export function userMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
