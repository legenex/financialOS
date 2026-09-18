/**
 * Typed outbound-request errors. Messages carry only a redacted URL (origin + path): never query strings,
 * userinfo, fragments, or header values.
 */

/** Reduces a URL to origin + path so tokens in query strings or userinfo never reach logs or errors. */
export function redactUrlForError(input: string | URL): string {
  try {
    const url = typeof input === 'string' ? new URL(input) : input;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

export class OutboundRequestError extends Error {
  override name = 'OutboundRequestError';
  readonly code: string;
  readonly redactedUrl: string | null;
  constructor(code: string, message: string, redactedUrl: string | null, options?: { cause?: unknown }) {
    super(redactedUrl ? `${message} (${redactedUrl})` : message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.redactedUrl = redactedUrl;
  }
}

/** The destination, a redirect target, or a resolved address is not permitted by the outbound policy. */
export class SsrfBlockedError extends OutboundRequestError {
  override name = 'SsrfBlockedError';
  readonly reason: string;
  constructor(reason: string, redactedUrl: string | null) {
    super('ssrf_blocked', `Outbound request blocked: ${reason}`, redactedUrl);
    this.reason = reason;
  }
}

export class ResponseTooLargeError extends OutboundRequestError {
  override name = 'ResponseTooLargeError';
  readonly limitBytes: number;
  constructor(limitBytes: number, redactedUrl: string | null) {
    super('response_too_large', `Response exceeded ${limitBytes} bytes`, redactedUrl);
    this.limitBytes = limitBytes;
  }
}

export type TimeoutPhase = 'connect' | 'headers' | 'body' | 'total';

export class TimeoutError extends OutboundRequestError {
  override name = 'TimeoutError';
  readonly phase: TimeoutPhase;
  constructor(phase: TimeoutPhase, redactedUrl: string | null) {
    super('timeout', `Outbound request timed out (${phase})`, redactedUrl);
    this.phase = phase;
  }
}

export class HttpStatusError extends OutboundRequestError {
  override name = 'HttpStatusError';
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, redactedUrl: string | null, retryAfterMs: number | null = null) {
    super('http_status', `HTTP ${status}`, redactedUrl);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class TooManyRedirectsError extends OutboundRequestError {
  override name = 'TooManyRedirectsError';
  constructor(max: number, redactedUrl: string | null) {
    super('too_many_redirects', `More than ${max} redirects`, redactedUrl);
  }
}

export class NetworkError extends OutboundRequestError {
  override name = 'NetworkError';
  readonly networkCode: string | null;
  constructor(networkCode: string | null, redactedUrl: string | null, cause?: unknown) {
    super('network_error', `Network error${networkCode ? ` ${networkCode}` : ''}`, redactedUrl, { cause: sanitizeCause(cause) });
    this.networkCode = networkCode;
  }
}

export class RequestAbortedError extends OutboundRequestError {
  override name = 'AbortError';
  constructor(redactedUrl: string | null) {
    super('aborted', 'Outbound request aborted', redactedUrl);
  }
}

export class InvalidRequestError extends OutboundRequestError {
  override name = 'InvalidRequestError';
  constructor(message: string, redactedUrl: string | null) {
    super('invalid_request', message, redactedUrl);
  }
}

/** Keeps only the error class and code of a low-level cause; undici messages can embed hostnames and paths. */
function sanitizeCause(cause: unknown): unknown {
  if (!(cause instanceof Error)) return undefined;
  const code = (cause as { code?: unknown }).code;
  const clean = new Error(typeof code === 'string' ? code : cause.name);
  clean.name = cause.name;
  return clean;
}
