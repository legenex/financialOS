import type { FileCheck } from '@financialos/contracts';

/**
 * Typed integration errors. Messages are safe to show and log: they never contain credentials, query strings,
 * or document text.
 */
export class IntegrationError extends Error {
  override name = 'IntegrationError';
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

/** The provider rejected the stored credential (expired, revoked, or wrong). The owner must replace it. */
export class CredentialExpiredError extends IntegrationError {
  override name = 'CredentialExpiredError';
  constructor(message = 'The provider rejected the stored credential. Replace or reconnect it.') {
    super('credential_expired', message);
  }
}

export class CredentialMissingError extends IntegrationError {
  override name = 'CredentialMissingError';
  constructor(field: string) {
    super('credential_missing', `Missing required credential field: ${field}`);
  }
}

export class ProviderRateLimitedError extends IntegrationError {
  override name = 'ProviderRateLimitedError';
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super('rate_limited', message, { retryable: true });
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderUnavailableError extends IntegrationError {
  override name = 'ProviderUnavailableError';
  constructor(message: string, cause?: unknown) {
    super('provider_unavailable', message, { retryable: true, cause });
  }
}

/** The provider answered with something that does not match its documented shape. */
export class ProviderResponseError extends IntegrationError {
  override name = 'ProviderResponseError';
  constructor(message: string) {
    super('unexpected_response', message);
  }
}

export class ProviderRequestError extends IntegrationError {
  override name = 'ProviderRequestError';
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super('provider_request_failed', message);
    this.status = status;
  }
}

/** A code path tried to do something other than read. Integrations are read-only. */
export class ReadOnlyViolationError extends IntegrationError {
  override name = 'ReadOnlyViolationError';
  constructor(detail: string) {
    super('read_only_violation', `Blocked non-read operation: ${detail}`);
  }
}

export class UnsupportedOperationError extends IntegrationError {
  override name = 'UnsupportedOperationError';
  constructor(message: string) {
    super('unsupported', message);
  }
}

export class InvalidConfigError extends IntegrationError {
  override name = 'InvalidConfigError';
  constructor(message: string) {
    super('invalid_config', message);
  }
}

/** A file failed pre-parse safety checks. */
export class FileRejectedError extends IntegrationError {
  override name = 'FileRejectedError';
  readonly checks: FileCheck[];
  constructor(message: string, checks: FileCheck[]) {
    super('file_rejected', message);
    this.checks = checks;
  }
}

/** The file passed safety checks but its content could not be parsed. */
export class FileParseError extends IntegrationError {
  override name = 'FileParseError';
  constructor(message: string) {
    super('file_parse_failed', message);
  }
}

export class OperationTimeoutError extends IntegrationError {
  override name = 'OperationTimeoutError';
  constructor(message: string) {
    super('timeout', message, { retryable: true });
  }
}
