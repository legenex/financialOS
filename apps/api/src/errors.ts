/** Errors that are safe to show to clients. Anything else becomes a generic 500. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;
  readonly headers: Record<string, string>;

  constructor(statusCode: number, code: string, message: string, options: { details?: unknown; headers?: Record<string, string> } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}

export const errors = {
  badRequest: (message = 'The request is not valid.', details?: unknown) => new ApiError(400, 'invalid_request', message, { details }),
  unauthenticated: () => new ApiError(401, 'unauthenticated', 'Sign in to continue.'),
  sessionExpired: () => new ApiError(401, 'session_expired', 'Your session has ended. Sign in again.'),
  invalidCredentials: () => new ApiError(401, 'invalid_credentials', 'Sign-in failed. Check your details and try again.'),
  forbidden: (code = 'forbidden', message = 'This request is not allowed.') => new ApiError(403, code, message),
  csrf: () => new ApiError(403, 'csrf_failed', 'The request could not be verified. Reload the page and try again.'),
  origin: () => new ApiError(403, 'origin_not_allowed', 'Requests from this origin are not allowed.'),
  notFound: (code = 'not_found', message = 'Not found.') => new ApiError(404, code, message),
  conflict: (code: string, message: string) => new ApiError(409, code, message),
  gone: (code = 'setup_sealed', message = 'Setup is complete. This endpoint is no longer available.') => new ApiError(410, code, message),
  tooManyAttempts: (retryAfterSeconds: number) =>
    new ApiError(429, 'too_many_attempts', 'Too many attempts. Wait before trying again.', {
      details: { retryAfterSeconds },
      headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    }),
  unavailable: (code: string, message: string) => new ApiError(503, code, message),
};
