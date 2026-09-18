import { formatMoney as domainFormatMoney } from '@financialos/domain';

/**
 * Display wrapper around the domain formatter.
 *
 * Money arrives from the API as decimal strings. This module never converts an amount to a JS number:
 * sign and zero checks are done on the string. Charts are the only place that convert (for geometry), and
 * they do it in their own code with a comment.
 */
export interface MoneyValue {
  amount: string;
  currency: string;
}

export interface MaybeMoneyValue {
  amount: string | null;
  currency: string | null;
}

export const MASKED_TEXT = '••••••';

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: string): boolean {
  return DECIMAL_RE.test(value);
}

export function decimalSign(amount: string): -1 | 0 | 1 {
  if (!isDecimalString(amount)) return 0;
  const negative = amount.startsWith('-');
  const digits = amount.replace('-', '').replace('.', '');
  if (/^0*$/.test(digits)) return 0;
  return negative ? -1 : 1;
}

export function absDecimal(amount: string): string {
  return amount.startsWith('-') ? amount.slice(1) : amount;
}

export function negateDecimal(amount: string): string {
  if (decimalSign(amount) === 0) return amount.replace('-', '');
  return amount.startsWith('-') ? amount.slice(1) : `-${amount}`;
}

export interface FormatOptions {
  locale?: string;
  /** Show a leading + for positive values. */
  signed?: boolean;
  /** Round to whole units for compact display (e.g. chart labels). */
  wholeUnits?: boolean;
}

/** Formats a known amount. Falls back to "CODE amount" if the domain formatter rejects the input. */
export function formatMoneyValue(value: MoneyValue, options: FormatOptions = {}): string {
  const { locale = 'en-US', signed = false, wholeUnits = false } = options;
  let text: string;
  try {
    text = domainFormatMoney(value, locale, wholeUnits ? { maximumFractionDigits: 0 } : {});
  } catch {
    text = `${value.currency} ${value.amount}`;
  }
  if (signed && decimalSign(value.amount) > 0) return `+${text}`;
  return text;
}

export function isKnownMoney(value: MoneyValue | MaybeMoneyValue | null | undefined): value is MoneyValue {
  return !!value && typeof value.amount === 'string' && typeof value.currency === 'string' && isDecimalString(value.amount);
}

/** Plain-text rendering used where a React node cannot go (chart labels, aria text). */
export function moneyText(
  value: MoneyValue | MaybeMoneyValue | null | undefined,
  { masked = false, unknownText = 'Unknown', ...options }: FormatOptions & { masked?: boolean; unknownText?: string } = {},
): string {
  if (!isKnownMoney(value)) return unknownText;
  if (masked) return MASKED_TEXT;
  return formatMoneyValue(value, options);
}
