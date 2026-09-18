import type { AllowlistEntry, SafeFetch } from '@financialos/security/net';
import { redactFields, redactText } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AdapterLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type LogSink = (level: LogLevel, message: string, fields: Record<string, unknown>) => void;

/** Wraps a sink so every message and field is scrubbed of the given secrets and token-shaped strings. */
export function createRedactingLogger(sink: LogSink, secrets: readonly string[] = []): AdapterLogger {
  const emit = (level: LogLevel) => (message: string, fields: Record<string, unknown> = {}) => {
    sink(level, redactText(message, secrets), redactFields(fields, secrets) as Record<string, unknown>);
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger: AdapterLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Adds another redaction pass to an existing logger. Adapters use it for credentials the worker could not know
 * about in advance (an IBKR Flex token in a URL, a derived bearer token), so a value can never reach a sink
 * even if the caller built the logger without it.
 */
export function withRedactedSecrets(logger: AdapterLogger, secrets: readonly string[]): AdapterLogger {
  const clean = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  if (clean.length === 0) return logger;
  const wrap = (level: LogLevel) => (message: string, fields: Record<string, unknown> = {}) => {
    logger[level](redactText(message, clean), redactFields(fields, clean) as Record<string, unknown>);
  };
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type ConfigValue = string | number | boolean | null;

/**
 * Everything an adapter may use. Adapters never read environment variables, files, or the database; the worker
 * supplies decrypted credentials, non-secret config, and an SSRF-guarded fetch bound to the owner allowlist.
 */
export interface AdapterContext {
  credentials: Readonly<Record<string, string>>;
  config: Readonly<Record<string, ConfigValue>>;
  safeFetch: SafeFetch;
  clock: Clock;
  /** Must be a redacting logger (see createRedactingLogger). */
  logger: AdapterLogger;
  signal: AbortSignal;
  allowlist: readonly AllowlistEntry[];
}

export function configString(ctx: Pick<AdapterContext, 'config'>, key: string): string | null {
  const v = ctx.config[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export function configNumber(ctx: Pick<AdapterContext, 'config'>, key: string): number | null {
  const v = ctx.config[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

export function configBoolean(ctx: Pick<AdapterContext, 'config'>, key: string): boolean | null {
  const v = ctx.config[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/** Sleeps for `ms`, rejecting early when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
