import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../client';
import { DB_ERROR_CODES, pgConstraintName, pgErrorCode } from '../errors';

export type { DbOrTx };

export class RepoError extends Error {
  override name = 'RepoError';
  constructor(
    readonly code: 'not_found' | 'conflict' | 'invalid' | 'forbidden',
    message: string,
  ) {
    super(message);
  }
}

export class NotFoundError extends RepoError {
  override name = 'NotFoundError';
  constructor(what: string) {
    super('not_found', `${what} not found`);
  }
}

export class ConflictError extends RepoError {
  override name = 'ConflictError';
  constructor(message: string) {
    super('conflict', message);
  }
}

export class InvalidError extends RepoError {
  override name = 'InvalidError';
  constructor(message: string) {
    super('invalid', message);
  }
}

export function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new NotFoundError(what);
  return row;
}

/** Why the database refused a write, derived from the FS* SQLSTATEs of migration 0001. */
export type IntegrityReason =
  | 'append_only'
  | 'ledger_immutable'
  | 'journal_unbalanced'
  | 'source_record_immutable'
  | 'journal_entry_too_few_lines';

/**
 * A write refused by an integrity trigger. `reason` is stable; `sqlState` is the raw
 * SQLSTATE so callers can log it without re-deriving anything.
 */
export class IntegrityError extends RepoError {
  override name = 'IntegrityError';
  constructor(
    readonly reason: IntegrityReason,
    readonly sqlState: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super('conflict', message);
  }
}

const INTEGRITY_BY_SQLSTATE: Record<string, { reason: IntegrityReason; message: string }> = {
  [DB_ERROR_CODES.appendOnly]: { reason: 'append_only', message: 'That table is append-only; the row cannot be changed or deleted' },
  [DB_ERROR_CODES.ledgerImmutable]: {
    reason: 'ledger_immutable',
    message: 'A posted journal entry is immutable; correct it with a reversal plus a replacement',
  },
  [DB_ERROR_CODES.journalUnbalanced]: { reason: 'journal_unbalanced', message: 'The journal entry does not balance in every currency' },
  [DB_ERROR_CODES.sourceRecordImmutable]: {
    reason: 'source_record_immutable',
    message: 'A source record is immutable; only last_seen_at, superseded_by and deleted_upstream_at may change',
  },
  [DB_ERROR_CODES.journalEntryTooFewLines]: {
    reason: 'journal_entry_too_few_lines',
    message: 'A posted journal entry needs at least two lines',
  },
};

/**
 * Translates a PostgreSQL error into a typed repository error. FS001–FS005 become
 * `IntegrityError`; unique, foreign-key, check and not-null violations become
 * `ConflictError` / `InvalidError`. Anything else is returned unchanged.
 */
export function toRepoError(error: unknown, context?: string): unknown {
  const code = pgErrorCode(error);
  if (!code) return error;
  const where = context ? ` (${context})` : '';
  const integrity = INTEGRITY_BY_SQLSTATE[code];
  if (integrity) return new IntegrityError(integrity.reason, code, `${integrity.message}${where}`, error);
  const constraint = pgConstraintName(error);
  const named = constraint ? ` [${constraint}]` : '';
  switch (code) {
    case DB_ERROR_CODES.uniqueViolation:
      return new ConflictError(`A row with the same unique key already exists${named}${where}`);
    case DB_ERROR_CODES.foreignKeyViolation:
      return new InvalidError(`A referenced row does not exist${named}${where}`);
    case DB_ERROR_CODES.checkViolation:
      return new InvalidError(`A database check constraint rejected the value${named}${where}`);
    case DB_ERROR_CODES.notNullViolation:
      return new InvalidError(`A required column was null${named}${where}`);
    default:
      return error;
  }
}

/** Runs `fn`, rethrowing PostgreSQL errors as typed repository errors. */
export async function mapErrors<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toRepoError(error, context);
  }
}

/** Date → ISO-8601 string; null stays null. */
export function iso(value: Date): string;
export function iso(value: Date | null): string | null;
export function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Normalises a numeric(38,18) string as returned by PostgreSQL ("12.500000000000000000")
 * to its shortest exact decimal form ("12.5"). Pure string manipulation, no floats.
 */
export function normalizeDecimal(value: string): string;
export function normalizeDecimal(value: string | null): string | null;
export function normalizeDecimal(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new InvalidError('Invalid decimal value from database');
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intRaw = '0', fracRaw = ''] = unsigned.split('.');
  const intPart = intRaw.replace(/^0+(?=\d)/, '');
  const fracPart = fracRaw.replace(/0+$/, '');
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative && body !== '0' ? `-${body}` : body;
}

/** Validates that a string is a decimal literal suitable for numeric(38,18). */
export function assertDecimal(value: string, what = 'amount'): string {
  if (!/^-?\d{1,20}(\.\d{1,18})?$/.test(value)) throw new InvalidError(`${what} must be a decimal string`);
  return value;
}

export function money(amount: string | null, currency: string | null): { amount: string; currency: string } | null {
  if (amount === null || currency === null) return null;
  return { amount: normalizeDecimal(amount), currency };
}

export function maybeMoney(amount: string | null, currency: string | null): { amount: string | null; currency: string | null } {
  return { amount: normalizeDecimal(amount), currency };
}

/** Opaque keyset cursor over (timestamp, id). */
export interface Cursor {
  at: string;
  id: string;
}

export function encodeCursor(at: Date, id: string | number): string {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id: String(id) }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined | null): Cursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') throw new Error('bad cursor');
    if (Number.isNaN(Date.parse(parsed.at))) throw new Error('bad cursor');
    return { at: parsed.at, id: parsed.id };
  } catch {
    throw new InvalidError('Invalid cursor');
  }
}

export function clampLimit(limit: number | undefined, fallback = 50, max = 200): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

/** Runs `fn` in a transaction (a savepoint when `db` is already a transaction). */
export function tx<T>(db: DbOrTx, fn: (t: DbOrTx) => Promise<T>): Promise<T> {
  return (db as { transaction: (cb: (t: DbOrTx) => Promise<T>) => Promise<T> }).transaction(fn);
}

/**
 * Forces the deferred constraint triggers (balanced entry, minimum line count) to run now
 * instead of at commit, so their FS00x errors surface inside the current transaction and can
 * be mapped to typed errors.
 *
 * The constraints are set back to deferred immediately afterwards: without that, the next
 * entry written in the same transaction would be checked after its first line, which can
 * never balance on its own.
 */
export async function flushDeferredConstraints(db: DbOrTx): Promise<void> {
  const runner = db as { execute: (query: SQL) => Promise<unknown> };
  // A failure here aborts the transaction, which is rolled back; there is nothing to reset.
  await runner.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await runner.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
}

/**
 * Drops `undefined` properties so a partial patch never overwrites a column with
 * `undefined`. `null` is kept: it is the explicit "unknown" value.
 */
export function pickDefined<T extends object>(patch: T): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) values[key] = value;
  return values;
}

export function nowDate(): Date {
  return new Date();
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDaysTo(date: Date, days: number): Date {
  return addSeconds(date, days * 86_400);
}
