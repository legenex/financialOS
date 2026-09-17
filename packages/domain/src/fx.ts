import type { ConvertedMoney, FxMethod, FxProvenance, Money } from '@financialos/contracts';
import { diffDays, type IsoDate } from './dates';
import { D, dec, money, roundToCurrency, toDecimalString, type Dec } from './money';

export interface FxRate {
  base: string;
  quote: string;
  /** 1 base = rate quote */
  rate: string;
  asOf: IsoDate;
  source: string;
}

export interface FxLookupOptions {
  /** Oldest acceptable rate relative to the requested date, in days. */
  maxStalenessDays?: number;
  /** Currency used to triangulate when no direct or inverse rate exists. */
  pivot?: string;
  method?: FxMethod;
}

/**
 * In-memory rate table. Lookups pick the latest rate on or before the requested date
 * (never a future rate), within the staleness limit.
 */
export class FxTable {
  private readonly byPair = new Map<string, FxRate[]>();

  constructor(rates: readonly FxRate[] = []) {
    for (const rate of rates) this.add(rate);
  }

  add(rate: FxRate): void {
    if (!dec(rate.rate).greaterThan(0)) throw new Error(`FX rate must be positive: ${rate.base}/${rate.quote}`);
    const key = `${rate.base}/${rate.quote}`;
    const list = this.byPair.get(key) ?? [];
    list.push(rate);
    list.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
    this.byPair.set(key, list);
  }

  private latestOnOrBefore(base: string, quote: string, date: IsoDate, maxStalenessDays: number): FxRate | null {
    const list = this.byPair.get(`${base}/${quote}`);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const candidate = list[i]!;
      if (candidate.asOf <= date) {
        return diffDays(candidate.asOf, date) <= maxStalenessDays ? candidate : null;
      }
    }
    return null;
  }

  /** Resolves a rate from `from` to `to`, using direct, inverse, or pivot rates. */
  resolve(from: string, to: string, date: IsoDate, options: FxLookupOptions = {}): { rate: Dec; asOf: IsoDate; source: string } | null {
    if (from === to) return { rate: new D(1), asOf: date, source: 'identity' };
    const maxStale = options.maxStalenessDays ?? 7;
    const direct = this.latestOnOrBefore(from, to, date, maxStale);
    if (direct) return { rate: dec(direct.rate), asOf: direct.asOf, source: direct.source };
    const inverse = this.latestOnOrBefore(to, from, date, maxStale);
    if (inverse) return { rate: new D(1).dividedBy(dec(inverse.rate)), asOf: inverse.asOf, source: `${inverse.source} (inverse)` };
    const pivot = options.pivot ?? 'USD';
    if (pivot !== from && pivot !== to) {
      const leg1 = this.resolve(from, pivot, date, { ...options, pivot: from });
      const leg2 = this.resolve(pivot, to, date, { ...options, pivot: to });
      if (leg1 && leg2) {
        return {
          rate: leg1.rate.times(leg2.rate),
          asOf: leg1.asOf < leg2.asOf ? leg1.asOf : leg2.asOf,
          source: `${leg1.source} × ${leg2.source} via ${pivot}`,
        };
      }
    }
    return null;
  }
}

/**
 * Converts money into a target currency with full provenance. A missing rate never becomes zero:
 * the result carries `converted: null` and an `unconvertedReason`, and callers must exclude and list it.
 */
export function convert(value: Money, to: string, date: IsoDate, table: FxTable, options: FxLookupOptions = {}): ConvertedMoney {
  if (value.currency === to) {
    return {
      original: value,
      converted: value,
      fx: { from: to, to, rate: '1', rateSource: 'identity', rateAsOf: date, method: 'identity' },
      unconvertedReason: null,
    };
  }
  const resolved = table.resolve(value.currency, to, date, options);
  if (!resolved) {
    return {
      original: value,
      converted: null,
      fx: null,
      unconvertedReason: `No ${value.currency}→${to} rate on or within ${options.maxStalenessDays ?? 7} days before ${date}`,
    };
  }
  const provenance: FxProvenance = {
    from: value.currency,
    to,
    rate: toDecimalString(resolved.rate.toDecimalPlaces(18)),
    rateSource: resolved.source,
    rateAsOf: resolved.asOf,
    method: options.method ?? 'historical',
  };
  return {
    original: value,
    converted: roundToCurrency(money(dec(value.amount).times(resolved.rate), to)),
    fx: provenance,
    unconvertedReason: null,
  };
}

/** Rate implied by an executed conversion (e.g. 100 USD debited, 1 800 ZAR credited → 18). */
export function impliedRate(sold: Money, bought: Money): Dec {
  const soldAmount = dec(sold.amount).abs();
  if (soldAmount.isZero()) throw new Error('Cannot imply a rate from a zero amount');
  return dec(bought.amount).abs().dividedBy(soldAmount);
}

/** Relative deviation |a - b| / b, used to judge whether an implied rate is plausible. */
export function rateDeviation(actual: Dec, reference: Dec): Dec {
  if (reference.isZero()) return new D(Infinity);
  return actual.minus(reference).abs().dividedBy(reference);
}
