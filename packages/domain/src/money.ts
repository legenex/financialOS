import Decimal from 'decimal.js';
import type { Money } from '@financialos/contracts';

/**
 * Isolated Decimal constructor for all financial arithmetic. 40 significant digits comfortably covers
 * numeric(38,18) values. Rounding for presentation and posting is explicit (see roundToCurrency).
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -30, toExpPos: 40 });
export type Dec = InstanceType<typeof D>;

export type DecimalInput = Dec | string | bigint;

export interface CurrencyInfo {
  code: string;
  minorUnits: number;
  kind: 'fiat' | 'crypto' | 'other';
  name: string;
}

const FIAT: Array<[string, number, string]> = [
  ['USD', 2, 'US dollar'],
  ['ZAR', 2, 'South African rand'],
  ['GBP', 2, 'Pound sterling'],
  ['EUR', 2, 'Euro'],
  ['AED', 2, 'UAE dirham'],
  ['CHF', 2, 'Swiss franc'],
  ['CAD', 2, 'Canadian dollar'],
  ['AUD', 2, 'Australian dollar'],
  ['NZD', 2, 'New Zealand dollar'],
  ['SGD', 2, 'Singapore dollar'],
  ['HKD', 2, 'Hong Kong dollar'],
  ['SEK', 2, 'Swedish krona'],
  ['NOK', 2, 'Norwegian krone'],
  ['DKK', 2, 'Danish krone'],
  ['PLN', 2, 'Polish zloty'],
  ['CZK', 2, 'Czech koruna'],
  ['INR', 2, 'Indian rupee'],
  ['CNY', 2, 'Chinese yuan'],
  ['MXN', 2, 'Mexican peso'],
  ['BRL', 2, 'Brazilian real'],
  ['SAR', 2, 'Saudi riyal'],
  ['QAR', 2, 'Qatari riyal'],
  ['NAD', 2, 'Namibian dollar'],
  ['BWP', 2, 'Botswana pula'],
  ['MUR', 2, 'Mauritian rupee'],
  ['KES', 2, 'Kenyan shilling'],
  ['NGN', 2, 'Nigerian naira'],
  ['ILS', 2, 'Israeli new shekel'],
  ['TRY', 2, 'Turkish lira'],
  ['THB', 2, 'Thai baht'],
  ['JPY', 0, 'Japanese yen'],
  ['KRW', 0, 'South Korean won'],
  ['HUF', 2, 'Hungarian forint'],
  ['BHD', 3, 'Bahraini dinar'],
  ['KWD', 3, 'Kuwaiti dinar'],
  ['OMR', 3, 'Omani rial'],
  ['JOD', 3, 'Jordanian dinar'],
];

const CRYPTO: Array<[string, number, string]> = [
  ['BTC', 8, 'Bitcoin'],
  ['ETH', 18, 'Ether'],
  ['USDC', 6, 'USD Coin'],
  ['USDT', 6, 'Tether USD'],
  ['SOL', 9, 'Solana'],
];

const REGISTRY = new Map<string, CurrencyInfo>();
for (const [code, minorUnits, name] of FIAT) REGISTRY.set(code, { code, minorUnits, kind: 'fiat', name });
for (const [code, minorUnits, name] of CRYPTO) REGISTRY.set(code, { code, minorUnits, kind: 'crypto', name });

export function currencyInfo(code: string): CurrencyInfo {
  const info = REGISTRY.get(code);
  if (info) return info;
  // Unknown codes (e.g. a new token) keep full precision rather than silently truncating.
  return { code, minorUnits: 18, kind: 'other', name: code };
}

export function isKnownCurrency(code: string): boolean {
  return REGISTRY.has(code);
}

export function listCurrencies(): CurrencyInfo[] {
  return [...REGISTRY.values()];
}

export function dec(value: DecimalInput): Dec {
  if (value instanceof D) return value;
  if (typeof value === 'bigint') return new D(value.toString());
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new MoneyError(`Invalid decimal value: ${String(value)}`);
  }
  return new D(value.trim());
}

export class MoneyError extends Error {
  override name = 'MoneyError';
}

export class CurrencyMismatchError extends MoneyError {
  override name = 'CurrencyMismatchError';
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
  }
}

/** Serialises a Decimal to a plain (non-exponent) string with trailing zeros trimmed. */
export function toDecimalString(value: Dec): string {
  const fixed = value.toFixed();
  if (!fixed.includes('.')) return fixed === '-0' ? '0' : fixed;
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

export function money(amount: DecimalInput, currency: string): Money {
  return { amount: toDecimalString(dec(amount)), currency };
}

export function zero(currency: string): Money {
  return { amount: '0', currency };
}

export function amountOf(m: Money): Dec {
  return dec(m.amount);
}

function assertSame(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSame(a, b);
  return money(dec(a.amount).plus(dec(b.amount)), a.currency);
}

export function sub(a: Money, b: Money): Money {
  assertSame(a, b);
  return money(dec(a.amount).minus(dec(b.amount)), a.currency);
}

export function neg(a: Money): Money {
  return money(dec(a.amount).negated(), a.currency);
}

export function abs(a: Money): Money {
  return money(dec(a.amount).abs(), a.currency);
}

export function mul(a: Money, factor: DecimalInput): Money {
  return money(dec(a.amount).times(dec(factor)), a.currency);
}

export function div(a: Money, divisor: DecimalInput): Money {
  const d = dec(divisor);
  if (d.isZero()) throw new MoneyError('Division by zero');
  return money(dec(a.amount).dividedBy(d), a.currency);
}

export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b);
  return dec(a.amount).comparedTo(dec(b.amount)) as -1 | 0 | 1;
}

export function isZero(a: Money): boolean {
  return dec(a.amount).isZero();
}

export function isNegative(a: Money): boolean {
  return dec(a.amount).isNegative() && !dec(a.amount).isZero();
}

export function isPositive(a: Money): boolean {
  return dec(a.amount).greaterThan(0);
}

export function max(a: Money, b: Money): Money {
  return cmp(a, b) >= 0 ? a : b;
}

export function min(a: Money, b: Money): Money {
  return cmp(a, b) <= 0 ? a : b;
}

/** Sums amounts of one currency. Throws on mixed currencies; use sumByCurrency for mixed input. */
export function sum(items: readonly Money[], currency: string): Money {
  let total = new D(0);
  for (const item of items) {
    if (item.currency !== currency) throw new CurrencyMismatchError(currency, item.currency);
    total = total.plus(dec(item.amount));
  }
  return money(total, currency);
}

export function sumByCurrency(items: readonly Money[]): Map<string, Money> {
  const totals = new Map<string, Dec>();
  for (const item of items) {
    totals.set(item.currency, (totals.get(item.currency) ?? new D(0)).plus(dec(item.amount)));
  }
  return new Map([...totals].map(([code, total]) => [code, money(total, code)]));
}

export type RoundingMode = 'half_even' | 'half_up' | 'down' | 'up';

const ROUNDING: Record<RoundingMode, Decimal.Rounding> = {
  half_even: Decimal.ROUND_HALF_EVEN,
  half_up: Decimal.ROUND_HALF_UP,
  down: Decimal.ROUND_DOWN,
  up: Decimal.ROUND_UP,
};

/** Rounds to the currency's minor units. Computed amounts (fees, interest, conversions) must pass through here before posting. */
export function roundToCurrency(a: Money, mode: RoundingMode = 'half_even'): Money {
  const { minorUnits } = currencyInfo(a.currency);
  return money(dec(a.amount).toDecimalPlaces(minorUnits, ROUNDING[mode]), a.currency);
}

/** True when the amount has no more decimal places than the currency allows. */
export function hasValidPrecision(a: Money): boolean {
  return dec(a.amount).decimalPlaces() <= currencyInfo(a.currency).minorUnits;
}

/**
 * Splits an amount into parts proportional to weights without losing or creating minor units
 * (largest-remainder method). The parts always sum exactly to the rounded total.
 */
export function allocate(total: Money, weights: readonly DecimalInput[]): Money[] {
  if (weights.length === 0) throw new MoneyError('allocate requires at least one weight');
  const ws = weights.map(dec);
  if (ws.some((w) => w.isNegative())) throw new MoneyError('allocate weights must be non-negative');
  const weightSum = ws.reduce((acc, w) => acc.plus(w), new D(0));
  if (weightSum.isZero()) throw new MoneyError('allocate weights must not all be zero');
  const { minorUnits } = currencyInfo(total.currency);
  const scale = new D(10).pow(minorUnits);
  const totalUnits = dec(roundToCurrency(total).amount).times(scale);
  const sign = totalUnits.isNegative() ? -1 : 1;
  const absUnits = totalUnits.abs();
  const raw = ws.map((w) => absUnits.times(w).dividedBy(weightSum));
  const floors = raw.map((r) => r.floor());
  let remainder = absUnits.minus(floors.reduce((acc, f) => acc.plus(f), new D(0)));
  const order = raw
    .map((r, i) => ({ i, frac: r.minus(r.floor()) }))
    .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  const result = [...floors];
  for (const { i } of order) {
    if (remainder.lessThanOrEqualTo(0)) break;
    result[i] = result[i]!.plus(1);
    remainder = remainder.minus(1);
  }
  return result.map((units) => money(units.times(sign).dividedBy(scale), total.currency));
}

/** Formats for display. Presentation only; never parse the output back into a value of record. */
export function formatMoney(a: Money, locale = 'en-US', opts: { maximumFractionDigits?: number } = {}): string {
  const info = currencyInfo(a.currency);
  const digits = opts.maximumFractionDigits ?? Math.min(info.minorUnits, info.kind === 'crypto' ? 8 : info.minorUnits);
  const rounded = dec(a.amount).toDecimalPlaces(digits, Decimal.ROUND_HALF_EVEN);
  const negative = rounded.isNegative() && !rounded.isZero();
  const [intPart, fracPart = ''] = rounded.abs().toFixed(digits).split('.');
  const group = new Intl.NumberFormat(locale).formatToParts(1000).find((p) => p.type === 'group')?.value ?? ',';
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ?? '.';
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const body = fracPart ? `${grouped}${decimal}${fracPart}` : grouped;
  const symbol = info.kind === 'fiat' ? currencySymbol(a.currency, locale) : `${a.currency} `;
  return `${negative ? '−' : ''}${symbol}${body}`;
}

function currencySymbol(code: string, locale: string): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    const symbol = part?.value ?? code;
    return symbol.length > 1 && /^[A-Z]+$/.test(symbol) ? `${symbol} ` : symbol;
  } catch {
    return `${code} `;
  }
}

/** Converts integer base units (e.g. satoshis, wei) into a decimal string for the currency. */
export function fromBaseUnits(units: bigint | string, currency: string): Money {
  const { minorUnits } = currencyInfo(currency);
  const value = dec(typeof units === 'bigint' ? units : dec(units)).dividedBy(new D(10).pow(minorUnits));
  return money(value, currency);
}

export function toBaseUnits(a: Money): bigint {
  const { minorUnits } = currencyInfo(a.currency);
  const units = dec(a.amount).times(new D(10).pow(minorUnits));
  if (!units.isInteger()) throw new MoneyError(`${a.amount} ${a.currency} has more precision than the currency allows`);
  return BigInt(units.toFixed(0));
}
