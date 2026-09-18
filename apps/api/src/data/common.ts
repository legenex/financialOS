/**
 * Shared helpers for the read-model layer.
 *
 * Rules that apply to every function in `apps/api/src/data/**`:
 * - nothing is cached across requests: every call reads the database again;
 * - money crosses this layer as decimal strings and is never turned into a JS number;
 * - unknown stays `null`; it is never coerced to zero;
 * - arithmetic belongs to `@financialos/domain`, never to these modules or the route handlers.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppSettings, type CurrencyCode, type MaybeMoney, type Money } from '@financialos/contracts';
import { currencies, fxRates, settings as settingsTable, type Database, type DbOrTx } from '@financialos/db';
import { FxTable, todayIn, type FxRate, type IsoDate } from '@financialos/domain';
import type { AppContext } from '../context';
import { errors } from '../errors';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params are strings: reject anything that is not a uuid before it reaches a query. */
export function requireUuid(value: string, code = 'not_found'): string {
  if (!UUID_RE.test(value)) throw errors.notFound(code, 'Not found.');
  return value.toLowerCase();
}

/**
 * Shortest exact decimal form of a `numeric(38,18)` value from PostgreSQL
 * ("12.500000000000000000" → "12.5"). Pure string work: no floating point.
 */
export function normalizeDecimal(value: string): string;
export function normalizeDecimal(value: string | null): string | null;
export function normalizeDecimal(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) throw new Error('invalid decimal from database');
  const negative = trimmed.startsWith('-');
  const unsigned = trimmed.replace(/^[+-]/, '');
  const [intRaw = '0', fracRaw = ''] = unsigned.split('.');
  const intPart = intRaw.replace(/^0+(?=\d)/, '');
  const fracPart = fracRaw.replace(/0+$/, '');
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative && body !== '0' ? `-${body}` : body;
}

/** Money only when both parts are known. A half-known amount is not money. */
export function moneyOf(amount: string | null, currency: string | null): Money | null {
  if (amount === null || currency === null) return null;
  return { amount: normalizeDecimal(amount), currency };
}

export function maybeMoneyOf(amount: string | null, currency: string | null): MaybeMoney {
  return { amount: normalizeDecimal(amount), currency };
}

export function iso(value: Date): string;
export function iso(value: Date | null): string | null;
export function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** Opaque keyset cursor over a sort key plus a tiebreaker id. */
export function encodeCursor(key: string, id: string): string {
  return Buffer.from(JSON.stringify({ k: key, i: id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined | null): { key: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { k?: unknown; i?: unknown };
    if (typeof parsed.k !== 'string' || typeof parsed.i !== 'string') throw new Error('bad cursor');
    return { key: parsed.k, id: parsed.i };
  } catch {
    throw errors.badRequest('The paging cursor is not valid.');
  }
}

/**
 * Application settings. Missing or invalid stored values fall back to the documented default so a
 * damaged row never produces an invented number. Mirrors the defaults inserted by migration 0003.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  reportingCurrency: 'USD',
  budgetCurrency: 'ZAR',
  reportingTimezone: 'Africa/Johannesburg',
  safeToSpendHorizonDays: 30,
  safeToSpendHorizonBasis: 'fixed_days',
  includeNearCashInSafeToSpend: false,
  runwayMinimumHistoryMonths: 3,
  staleAfterHours: 48,
  idleTimeoutSeconds: 300,
  privacyModeDefault: true,
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  weekStartsOn: 'monday',
  cloudAiAllowed: false,
  publicMarketDataEnabled: false,
};

const SETTING_KEYS = Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>;

export async function loadSettings(db: DbOrTx): Promise<AppSettings> {
  const rows = await db
    .select({ key: settingsTable.key, value: settingsTable.value })
    .from(settingsTable)
    .where(inArray(settingsTable.key, SETTING_KEYS));
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const result: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const parsed = stored.has(key) ? AppSettings.shape[key].safeParse(stored.get(key)) : null;
    result[key] = parsed?.success ? parsed.data : DEFAULT_APP_SETTINGS[key];
  }
  return AppSettings.parse(result);
}

export async function writeSetting(db: DbOrTx, key: string, value: unknown, updatedBy = 'owner'): Promise<void> {
  const now = new Date();
  await db
    .insert(settingsTable)
    .values({ key, value, updatedBy, updatedAt: now })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedBy, updatedAt: now } });
}

/** Every rate in the table. Small by construction (one row per pair, date, and source). */
export async function loadFxTable(db: DbOrTx, limit = 20_000): Promise<FxTable> {
  const rows = await db
    .select({ base: fxRates.base, quote: fxRates.quote, rate: fxRates.rate, asOf: fxRates.asOf, source: fxRates.source })
    .from(fxRates)
    .orderBy(desc(fxRates.asOf))
    .limit(limit);
  const table = new FxTable();
  for (const row of rows) {
    const rate: FxRate = { base: row.base, quote: row.quote, rate: normalizeDecimal(row.rate), asOf: row.asOf, source: row.source };
    try {
      table.add(rate);
    } catch {
      // A non-positive stored rate is unusable; skipping it leaves the value unconverted (never zero).
    }
  }
  return table;
}

export async function listCurrencyCodes(db: DbOrTx): Promise<CurrencyCode[]> {
  const rows = await db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)).orderBy(asc(currencies.code));
  return rows.map((r) => r.code);
}

/** Today's calendar date in the configured reporting time zone. The server time zone is never used. */
export function reportingToday(settings: AppSettings, now: Date): IsoDate {
  return todayIn(settings.reportingTimezone, now);
}

export interface PeriodRange {
  from: IsoDate;
  to: IsoDate;
}

/** Defaults to the last `days` days ending today when the caller gave no explicit range. */
export function resolvePeriod(query: { from?: string; to?: string }, today: IsoDate, days = 90): PeriodRange {
  const to = query.to ?? today;
  const from = query.from ?? shiftDays(to, -days);
  if (from > to) throw errors.badRequest('The period starts after it ends.');
  return { from, to };
}

export function shiftDays(date: IsoDate, days: number): IsoDate {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** `ctx.db` typed as the root database (repositories in this layer never open their own pool). */
export function dbOf(ctx: AppContext): Database {
  return ctx.db;
}

/** Sorted, de-duplicated ids. Used everywhere an entity scope is built. */
export function uniqueIds(ids: Iterable<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const id of ids) if (id) set.add(id);
  return [...set].sort();
}

export { and, asc, desc, eq, inArray, sql };
