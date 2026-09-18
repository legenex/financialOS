/** SQLSTATE codes raised by the integrity triggers (migrations/0001_integrity_triggers.sql). */
export const DB_ERROR_CODES = {
  appendOnly: 'FS001',
  ledgerImmutable: 'FS002',
  journalUnbalanced: 'FS003',
  sourceRecordImmutable: 'FS004',
  journalEntryTooFewLines: 'FS005',
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  insufficientPrivilege: '42501',
} as const;
export type DbErrorCode = (typeof DB_ERROR_CODES)[keyof typeof DB_ERROR_CODES];

/** Extracts the SQLSTATE from a postgres-js error (possibly wrapped by Drizzle). */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isPgError(error: unknown, code: string): boolean {
  return pgErrorCode(error) === code;
}

/** Name of the violated constraint, when PostgreSQL reported one. */
export function pgConstraintName(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const name = (current as { constraint_name?: unknown }).constraint_name;
    if (typeof name === 'string') return name;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
