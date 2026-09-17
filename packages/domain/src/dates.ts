/**
 * Calendar-date helpers. Financial effective dates are plain ISO dates (YYYY-MM-DD) with no time zone;
 * instants are converted to a local calendar date using an explicit IANA time zone.
 * Internally dates are handled as UTC midnight so arithmetic never crosses a DST boundary.
 */

export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class DateError extends Error {
  override name = 'DateError';
}

export function parseIsoDate(value: IsoDate): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(value);
  if (!match) throw new DateError(`Invalid ISO date: ${value}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new DateError(`Invalid calendar date: ${value}`);
  return { y, m, d };
}

export function isValidIsoDate(value: string): boolean {
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

export function makeDate(y: number, m: number, d: number): IsoDate {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new DateError(`Invalid calendar date: ${y}-${m}-${d}`);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function toEpochDay(value: IsoDate): number {
  const { y, m, d } = parseIsoDate(value);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

function fromEpochDay(day: number): IsoDate {
  const dt = new Date(day * 86_400_000);
  return makeDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(value: IsoDate, days: number): IsoDate {
  return fromEpochDay(toEpochDay(value) + days);
}

/** Adds calendar months, clamping the day to the end of the target month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(value: IsoDate, months: number, preferredDay?: number): IsoDate {
  const { y, m, d } = parseIsoDate(value);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return makeDate(ny, nm, Math.min(preferredDay ?? d, daysInMonth(ny, nm)));
}

export function diffDays(a: IsoDate, b: IsoDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

export function isBetween(value: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return value >= from && value <= to;
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
export function isoWeekday(value: IsoDate): number {
  const day = new Date(toEpochDay(value) * 86_400_000).getUTCDay();
  return day === 0 ? 7 : day;
}

export function startOfWeek(value: IsoDate, weekStartsOn: 'monday' | 'sunday' = 'monday'): IsoDate {
  const wd = isoWeekday(value);
  const offset = weekStartsOn === 'monday' ? wd - 1 : wd % 7;
  return addDays(value, -offset);
}

export function startOfMonth(value: IsoDate): IsoDate {
  const { y, m } = parseIsoDate(value);
  return makeDate(y, m, 1);
}

export function endOfMonth(value: IsoDate): IsoDate {
  const { y, m } = parseIsoDate(value);
  return makeDate(y, m, daysInMonth(y, m));
}

export function monthKey(value: IsoDate): string {
  return value.slice(0, 7);
}

/** Whole calendar months between two dates' month starts (b - a). */
export function monthsBetween(a: IsoDate, b: IsoDate): number {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  return (pb.y - pa.y) * 12 + (pb.m - pa.m);
}

/** Converts an instant to the calendar date observed in a time zone. */
export function toLocalDate(instant: Date | string, timeZone: string): IsoDate {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) throw new DateError(`Invalid instant: ${String(instant)}`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export type Cadence = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually' | 'irregular' | 'unknown';

/**
 * Expands a recurring schedule into due dates within [from, to] (inclusive), starting at `anchor`.
 * Monthly schedules keep the anchor's day (or `dayOfMonth`) and clamp to month end.
 * Irregular/unknown cadences produce only the anchor itself when it falls in range.
 */
export function expandCadence(anchor: IsoDate, cadence: Cadence, from: IsoDate, to: IsoDate, dayOfMonth?: number | null): IsoDate[] {
  if (to < from) return [];
  if (cadence === 'irregular' || cadence === 'unknown') {
    return isBetween(anchor, from, to) ? [anchor] : [];
  }
  const out: IsoDate[] = [];
  const stepDays = cadence === 'weekly' ? 7 : cadence === 'fortnightly' ? 14 : 0;
  const stepMonths = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : cadence === 'annually' ? 12 : 0;
  const preferredDay = dayOfMonth ?? parseIsoDate(anchor).d;
  if (stepDays > 0) {
    let current = anchor;
    if (current < from) {
      const periods = Math.ceil(diffDays(current, from) / stepDays);
      current = addDays(current, periods * stepDays);
    }
    for (let guard = 0; current <= to && guard < 10_000; guard += 1) {
      out.push(current);
      current = addDays(current, stepDays);
    }
    return out;
  }
  let index = 0;
  if (anchor < from) {
    index = Math.max(0, Math.floor(monthsBetween(anchor, from) / stepMonths) - 1);
  }
  for (let guard = 0; guard < 10_000; guard += 1, index += 1) {
    const current = addMonths(makeDate(parseIsoDate(anchor).y, parseIsoDate(anchor).m, 1), index * stepMonths, preferredDay);
    if (current > to) break;
    if (current >= from && current >= anchor) out.push(current);
  }
  return out;
}

export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  return toLocalDate(now, timeZone);
}
