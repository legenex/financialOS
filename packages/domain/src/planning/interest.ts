/**
 * Fixed-income interest arithmetic with explicit rate bases.
 *
 * Rates in and out of `projectInterest` are expressed in PERCENT ("10" = 10 % a year). The lower-level helpers
 * work on fractions ("0.1").
 *
 *   nominal r compounded m times a year:  periodic = r / m,  effective = (1 + r/m)^m − 1
 *   effective annual e:                   monthly  = (1 + e)^(1/12) − 1
 *   projection over n months:             balance × (1 + monthly)^n
 *   accrual between dates (actual/365):   simple  P × r × d/365
 *                                         daily   P × ((1 + r/365)^d − 1)
 *                                         other   P × ((1 + e)^(d/365) − 1)
 */
import type { FixedIncomeTerms, InterestProjection, Money } from '@financialos/contracts';
import { addMonths, diffDays, type IsoDate } from '../dates';
import { D, dec, money, roundToCurrency, type Dec, type DecimalInput } from '../money';
import { decString, PlanningError } from './shared';

export type Compounding = FixedIncomeTerms['compounding'];

export const PERIODS_PER_YEAR: Readonly<Record<Exclude<Compounding, 'simple' | 'unknown'>, number>> = {
  monthly: 12,
  quarterly: 4,
  annually: 1,
  daily: 365,
};

function positivePeriods(m: number): void {
  if (!Number.isInteger(m) || m < 1) throw new PlanningError(`Compounding periods per year must be a positive integer: ${m}`);
}

/** Periodic rate r/m for a nominal annual rate r (fraction). */
export function periodicRate(nominalAnnual: DecimalInput, periodsPerYear: number): Dec {
  positivePeriods(periodsPerYear);
  return dec(nominalAnnual).dividedBy(periodsPerYear);
}

/** Effective annual rate (1 + r/m)^m − 1 (fractions). */
export function nominalToEffective(nominalAnnual: DecimalInput, periodsPerYear: number): Dec {
  return new D(1).plus(periodicRate(nominalAnnual, periodsPerYear)).pow(periodsPerYear).minus(1);
}

/** Nominal annual rate compounded m times a year that yields effective rate e: m × ((1 + e)^(1/m) − 1). */
export function effectiveToNominal(effectiveAnnual: DecimalInput, periodsPerYear: number): Dec {
  positivePeriods(periodsPerYear);
  return new D(1).plus(dec(effectiveAnnual)).pow(new D(1).dividedBy(periodsPerYear)).minus(1).times(periodsPerYear);
}

/** Equivalent monthly rate for an effective annual rate: (1 + e)^(1/12) − 1 (fractions). */
export function effectiveToMonthly(effectiveAnnual: DecimalInput): Dec {
  const e = dec(effectiveAnnual);
  if (e.lessThanOrEqualTo(-1)) throw new PlanningError('An effective rate must be above -100%');
  return new D(1).plus(e).pow(new D(1).dividedBy(12)).minus(1);
}

export interface RateBasisResult {
  monthly: Dec;
  effectiveAnnual: Dec;
  /** True when interest does not compound (simple interest). */
  simple: boolean;
}

/** Monthly and effective annual rates (fractions) for a stated rate under a given basis and compounding. */
export function ratesFor(basis: 'nominal' | 'effective', annualRate: DecimalInput, compounding: Compounding): RateBasisResult {
  const r = dec(annualRate);
  if (basis === 'effective') return { monthly: effectiveToMonthly(r), effectiveAnnual: r, simple: false };
  if (compounding === 'simple') return { monthly: r.dividedBy(12), effectiveAnnual: r, simple: true };
  const m = compounding === 'unknown' ? 12 : PERIODS_PER_YEAR[compounding];
  const effectiveAnnual = nominalToEffective(r, m);
  const monthly = m === 12 ? r.dividedBy(12) : new D(1).plus(r.dividedBy(m)).pow(new D(m).dividedBy(12)).minus(1);
  return { monthly, effectiveAnnual, simple: false };
}

/** Balance after `months` months at a monthly rate (compound, or simple when `simple`). Rounded to the currency. */
export function projectBalance(balance: Money, monthlyRate: DecimalInput, months: number, simple = false): Money {
  if (!Number.isInteger(months) || months < 0) throw new PlanningError(`Months must be a non-negative integer: ${months}`);
  const rate = dec(monthlyRate);
  const factor = simple ? new D(1).plus(rate.times(months)) : new D(1).plus(rate).pow(months);
  return roundToCurrency(money(dec(balance.amount).times(factor), balance.currency));
}

/** Interest accrued on `principal` from `from` to `to` using actual days / 365. Rounded to the currency. */
export function accruedInterest(principal: Money, annualRate: DecimalInput, basis: 'nominal' | 'effective', compounding: Compounding, from: IsoDate, to: IsoDate): Money {
  const days = diffDays(from, to);
  if (days < 0) throw new PlanningError('Accrual end date is before its start date');
  const p = dec(principal.amount);
  const r = dec(annualRate);
  let interest: Dec;
  if (basis === 'nominal' && compounding === 'simple') interest = p.times(r).times(days).dividedBy(365);
  else if (basis === 'nominal' && compounding === 'daily') interest = p.times(new D(1).plus(r.dividedBy(365)).pow(days).minus(1));
  else {
    const e = ratesFor(basis, r, compounding).effectiveAnnual;
    interest = p.times(new D(1).plus(e).pow(new D(days).dividedBy(365)).minus(1));
  }
  return roundToCurrency(money(interest, principal.currency));
}

export interface PostedInterest {
  date: IsoDate;
  amount: Money;
}

export interface InterestProjectionOptions {
  asOf: IsoDate;
  months: number;
  /** Current balance to project; defaults to the principal. */
  balance?: Money | null;
  posted?: readonly PostedInterest[];
  /** Relative tolerance when comparing posted with calculated interest (default 0.01 = 1 %). */
  tolerance?: string;
}

export type InterestTerms = Pick<
  FixedIncomeTerms,
  'principal' | 'statedAnnualRate' | 'rateBasis' | 'compounding' | 'fees' | 'withdrawalTerms' | 'counterparty' | 'startDate' | 'maturityDate' | 'verified'
>;

function percent(value: Dec): string {
  return decString(value.times(100), 18);
}

export function projectInterest(terms: InterestTerms, options: InterestProjectionOptions): InterestProjection {
  const caveats: string[] = ['Accrued interest is not spendable until it has been paid out and can be withdrawn.'];
  if (!Number.isInteger(options.months) || options.months < 0) throw new PlanningError('Projection months must be a non-negative integer');
  const balance = options.balance ?? terms.principal;
  const currency = balance?.currency ?? terms.principal?.currency ?? null;

  let postedTotal: Dec | null = null;
  let postedCurrency: string | null = currency;
  for (const entry of options.posted ?? []) {
    if (entry.date > options.asOf) continue;
    if (terms.startDate && entry.date < terms.startDate) continue;
    postedCurrency ??= entry.amount.currency;
    if (entry.amount.currency !== postedCurrency) {
      caveats.push(`A posted interest entry on ${entry.date} is in ${entry.amount.currency} and was not compared.`);
      continue;
    }
    postedTotal = (postedTotal ?? new D(0)).plus(dec(entry.amount.amount));
  }
  const postedInterestToDate = postedTotal === null || postedCurrency === null ? null : roundToCurrency(money(postedTotal, postedCurrency));

  if (terms.statedAnnualRate === null) {
    caveats.push('The interest rate is unknown, so nothing can be projected.');
    return { basisScenarios: [], postedInterestToDate, caveats };
  }
  const rate = dec(terms.statedAnnualRate).dividedBy(100);
  const bases: Array<'nominal' | 'effective'> = terms.rateBasis === 'unverified' ? ['nominal', 'effective'] : [terms.rateBasis];
  if (terms.rateBasis === 'unverified') {
    caveats.push(
      `The rate basis is unverified, so both readings of ${terms.statedAnnualRate}% are shown: as a nominal rate${terms.compounding === 'simple' ? '' : ' with compounding'} and as an effective annual rate. Confirm the basis from the agreement.`,
    );
  }
  if (terms.compounding === 'unknown') caveats.push('The compounding frequency is unknown; monthly compounding is assumed for the nominal reading.');
  if (terms.compounding === 'simple') caveats.push('Simple interest: interest does not compound.');
  if (!terms.verified) caveats.push('These terms have not been verified against a document.');
  if (balance === null) caveats.push('The balance is unknown, so no projected balance can be shown.');
  if (terms.maturityDate && addMonths(options.asOf, options.months) > terms.maturityDate) {
    caveats.push(`The projection runs past the maturity date ${terms.maturityDate}; terms after maturity are not known.`);
  }
  if (terms.fees) caveats.push(`Fees may reduce the return: ${terms.fees}`);
  if (terms.withdrawalTerms) caveats.push(`Withdrawal terms: ${terms.withdrawalTerms}`);
  if (terms.counterparty) caveats.push(`Returns depend on the counterparty (${terms.counterparty}) being able to pay; this is not a guaranteed return.`);
  else caveats.push('Returns depend on the counterparty being able to pay; this is not a guaranteed return.');

  const tolerance = dec(options.tolerance ?? '0.01');
  const basisScenarios: InterestProjection['basisScenarios'] = bases.map((basis) => {
    const rates = ratesFor(basis, rate, terms.compounding);
    const projectedBalance = balance ? projectBalance(balance, rates.monthly, options.months, rates.simple) : null;
    const accrued =
      terms.principal && terms.startDate && terms.startDate <= options.asOf
        ? accruedInterest(terms.principal, rate, basis, terms.compounding, terms.startDate, options.asOf)
        : null;
    if (accrued && postedInterestToDate && postedInterestToDate.currency === accrued.currency) {
      const calc = dec(accrued.amount);
      const posted = dec(postedInterestToDate.amount);
      const diff = posted.minus(calc);
      const withinTolerance = calc.isZero() ? diff.isZero() : diff.abs().dividedBy(calc.abs()).lessThanOrEqualTo(tolerance);
      caveats.push(
        withinTolerance
          ? `Posted interest (${postedInterestToDate.amount} ${postedInterestToDate.currency}) is consistent with the ${basis} reading (${accrued.amount}).`
          : `Posted interest (${postedInterestToDate.amount} ${postedInterestToDate.currency}) is ${decString(diff.abs(), 2)} ${diff.isNegative() ? 'below' : 'above'} the ${basis} reading (${accrued.amount}).`,
      );
    }
    return {
      basis,
      monthlyRate: percent(rates.monthly),
      effectiveAnnualRate: percent(rates.effectiveAnnual),
      projectedBalance,
      accruedInterest: accrued,
    };
  });
  if (!terms.startDate) caveats.push('The start date is unknown, so accrued interest cannot be calculated.');
  return { basisScenarios, postedInterestToDate, caveats };
}
