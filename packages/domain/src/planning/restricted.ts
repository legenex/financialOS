/**
 * Restricted-holding sale schedules. A schedule is only produced from VERIFIED volume-cap terms, or when the
 * request is explicitly hypothetical. Price × quantity is always labelled indicative, never proceeds.
 * Restricted holdings are never part of spending capacity or runway (see safeToSpend and runway).
 *
 * Volume-cap terms are read from `restriction.terms` as decimal strings:
 *   `maxDailyVolumeFraction` (0–1)  or  `maxDailyVolumePercent` (0–100)
 */
import type { Restriction, SaleScheduleRequest, SaleScheduleResult } from '@financialos/contracts';
import type { IsoDate } from '../dates';
import { dec, money, roundToCurrency, type Dec } from '../money';

export const INDICATIVE_CAVEAT =
  'Indicative, not proceeds: market impact, price changes, fees, taxes and the restrictions themselves can reduce what a sale would actually realise.';

export type RestrictionRecord = Pick<Restriction, 'id' | 'accountId' | 'instrumentId' | 'kind' | 'status' | 'terms' | 'effectiveFrom' | 'effectiveTo'>;

const DECIMAL = /^\d+(\.\d+)?$/;

/** Reads the daily volume fraction from volume-cap terms, or null when absent or not a valid decimal string. */
export function volumeCapFraction(restriction: Pick<Restriction, 'terms'>): Dec | null {
  const { terms } = restriction;
  const fraction = terms['maxDailyVolumeFraction'];
  if (typeof fraction === 'string' && DECIMAL.test(fraction)) {
    const value = dec(fraction);
    return value.greaterThan(0) && value.lessThanOrEqualTo(1) ? value : null;
  }
  const percent = terms['maxDailyVolumePercent'];
  if (typeof percent === 'string' && DECIMAL.test(percent)) {
    const value = dec(percent);
    return value.greaterThan(0) && value.lessThanOrEqualTo(100) ? value.dividedBy(100) : null;
  }
  return null;
}

function isEffective(r: RestrictionRecord, asOf: IsoDate): boolean {
  if (r.effectiveFrom && r.effectiveFrom > asOf) return false;
  if (r.effectiveTo && r.effectiveTo < asOf) return false;
  return r.status !== 'expired' && r.status !== 'rejected';
}

export interface SaleScheduleOptions {
  asOf: IsoDate;
  restrictions: readonly RestrictionRecord[];
  /** Instrument being sold, to match instrument-specific restrictions. */
  instrumentId?: string | null;
  /** Fraction (0–1) to use for an explicitly hypothetical request when no cap fraction is recorded. */
  hypotheticalFraction?: string | null;
}

export function planRestrictedSale(request: SaleScheduleRequest, options: SaleScheduleOptions): SaleScheduleResult {
  const caveats: string[] = [];
  const blank = { maxSharesPerDay: null, tradingDaysRequired: null, indicativeGross: null };
  const relevant = options.restrictions.filter(
    (r) =>
      r.accountId === request.accountId &&
      (r.instrumentId === null || options.instrumentId === undefined || options.instrumentId === null || r.instrumentId === options.instrumentId) &&
      isEffective(r, options.asOf),
  );
  const caps = relevant.filter((r) => r.kind === 'volume_cap');
  const verified = caps.find((r) => r.status === 'verified' && volumeCapFraction(r) !== null);
  const reported = caps.find((r) => r.status === 'reported_unverified');
  const hypothetical = request.volumeSource === 'hypothetical';

  for (const lock of relevant.filter((r) => r.kind === 'lockup' || r.kind === 'transfer_restriction')) {
    caveats.push(
      `A ${lock.kind.replace('_', ' ')} is recorded (${lock.status.replace('_', ' ')})${lock.effectiveTo ? ` until ${lock.effectiveTo}` : ''}; a sale may not be possible while it applies.`,
    );
  }
  if (caps.some((r) => r.status === 'verified') && !verified) {
    caveats.push('A verified volume cap exists but its terms do not state a daily volume fraction.');
  }

  let fraction: Dec | null = null;
  if (verified) {
    fraction = volumeCapFraction(verified);
    if (hypothetical) caveats.push('Hypothetical: the average daily volume used here is hypothetical, not observed.');
  } else if (hypothetical) {
    caveats.push('Hypothetical: the restriction terms are not verified and the volume is hypothetical. This is an illustration, not a sale plan.');
    if (options.hypotheticalFraction !== undefined && options.hypotheticalFraction !== null) fraction = dec(options.hypotheticalFraction);
    else if (reported) fraction = volumeCapFraction(reported);
    if (fraction === null || !fraction.greaterThan(0) || fraction.greaterThan(1)) {
      caveats.push('No daily volume fraction is available for the illustration.');
      return { status: 'insufficient_data', ...blank, caveats };
    }
  } else {
    caveats.unshift(
      reported
        ? 'Blocked: a volume cap is reported but not verified. Verify the restriction terms from the agreement before planning a sale.'
        : 'Blocked: no verified volume-cap terms are recorded for this holding. Verify the restriction terms before planning a sale.',
    );
    return { status: 'blocked_unverified_terms', ...blank, caveats };
  }

  const quantity = dec(request.quantity);
  const adv = dec(request.averageDailyVolume);
  if (!quantity.greaterThan(0) || !adv.greaterThan(0)) {
    caveats.push('Quantity and average daily volume must both be positive.');
    return { status: 'insufficient_data', ...blank, caveats };
  }
  const maxPerDay = fraction!.times(adv).floor();
  let tradingDaysRequired: number | null = null;
  if (maxPerDay.isZero()) {
    caveats.push('The volume cap rounds down to zero shares a day at this volume.');
  } else {
    tradingDaysRequired = quantity.dividedBy(maxPerDay).ceil().toNumber();
    const perWeek = request.tradingDaysPerWeek ?? 5;
    caveats.push(`About ${Math.ceil(tradingDaysRequired / perWeek)} week(s) at ${perWeek} trading days a week, if volume stays at this level.`);
  }

  let indicativeGross = null;
  if (request.hypotheticalPrice !== null && request.priceCurrency !== null) {
    indicativeGross = roundToCurrency(money(quantity.times(dec(request.hypotheticalPrice)), request.priceCurrency));
    caveats.push(INDICATIVE_CAVEAT);
  } else {
    caveats.push('No hypothetical price was given, so no indicative value is shown.');
  }
  caveats.push('Restricted holdings are excluded from safe-to-spend and runway until they are sold and the cash is received.');

  return {
    status: 'ok',
    maxSharesPerDay: maxPerDay.toFixed(0),
    tradingDaysRequired,
    indicativeGross,
    caveats,
  };
}
