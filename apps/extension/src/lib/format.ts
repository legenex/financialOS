/**
 * Display formatting. Amounts arrive as decimal strings and are formatted from the string itself
 * (Intl.NumberFormat treats numeric strings as exact decimals), never via binary floating point.
 */

export interface MoneyLike {
  amount: string;
  currency: string;
}

const DECIMAL = /^-?\d{1,20}(?:\.(\d{1,18}))?$/;

type NumericString = `${number}`;

export function formatMoney(money: MoneyLike, locale?: string): string {
  const match = DECIMAL.exec(money.amount);
  if (!match) return `${money.amount} ${money.currency}`;
  const decimals = match[1]?.length ?? 0;
  const digits = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  const amount = money.amount as NumericString;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency, ...digits }).format(amount);
  } catch {
    // Codes Intl does not accept as currencies (for example four-letter token codes).
    return `${new Intl.NumberFormat(locale, digits).format(amount)} ${money.currency}`;
  }
}

export function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Hello';
}

export function formatLongDate(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

export function formatClock(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

export function formatDateTime(value: string | number, locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatDay(value: string | number, locale?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/** Whole percent for display, clamped to a sensible range. */
export function clampPercent(value: number, max = 100): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.round(value)));
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** User codes ("ABCD-2345") are compared case-insensitively by the server and shown in upper case. */
export function formatUserCode(code: string): string {
  return code.trim().toUpperCase();
}
