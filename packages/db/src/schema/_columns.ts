import { sql } from 'drizzle-orm';
import { customType, date, jsonb, numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Shared column builders. Every money or quantity column is numeric(38,18) mapped to a
 * decimal string, never a JS number. Unknown values stay NULL.
 */
export const money = (name: string) => numeric(name, { precision: 38, scale: 18, mode: 'string' });

/** A ratio or rate (for example 0.10 for ten percent). Same precision as money. */
export const rate = (name: string) => numeric(name, { precision: 38, scale: 18, mode: 'string' });

/** Primary key: uuid with a server-side default. */
export const pk = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

/** timestamptz mapped to Date. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => tstz('created_at').notNull().defaultNow();
export const updatedAt = () => tstz('updated_at').notNull().defaultNow();

/** Calendar date mapped to an ISO `YYYY-MM-DD` string. */
export const isoDate = (name: string) => date(name, { mode: 'string' });

/** Currency codes are plain text referencing `currencies.code`. */
export const provenance = () =>
  jsonb('provenance').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`);

export const jsonObject = (name: string) =>
  jsonb(name).$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`);

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
  },
});

/** SQL fragment for `text IN (...)` check constraints. */
export function inList(column: string, values: readonly string[]) {
  const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
  return sql.raw(`${column} IN (${list})`);
}
