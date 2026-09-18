import type { Logger, LoggerOptions } from 'pino';
import { pino } from 'pino';
import { PINO_REDACT_PATHS, REDACTED, isSecretKey, redactText, redactValue } from '@financialos/security/redact';

function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: redactText(String(err)) };
  const out: Record<string, unknown> = { type: err.name, message: redactText(err.message) };
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') out.code = code;
  if (err.stack) out.stack = redactText(err.stack);
  return out;
}

function isPlainData(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Scrubs a log line's fields before it is serialised. Never log secrets or raw statement contents. */
export function scrubLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretKey(key)) out[key] = REDACTED;
    else if (typeof value === 'string') out[key] = redactText(value);
    else if (isPlainData(value)) out[key] = redactValue(value);
    else out[key] = value;
  }
  return out;
}

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { service: 'financialos-worker' },
    redact: { paths: PINO_REDACT_PATHS, censor: '[redacted]' },
    serializers: { err: serializeError, error: serializeError },
    formatters: { log: scrubLogObject },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? redactText(a) : a)) as Parameters<typeof method>;
        return method.apply(this, scrubbed);
      },
    },
  };
}

export function createLogger(level: string): Logger {
  return pino(loggerOptions(level));
}
