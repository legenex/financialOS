import { InterestProjection } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { dec } from '../money';
import {
  accruedInterest,
  effectiveToMonthly,
  effectiveToNominal,
  nominalToEffective,
  periodicRate,
  projectBalance,
  projectInterest,
  ratesFor,
  type InterestTerms,
} from './interest';
import { PlanningError } from './shared';
import { gbp } from './testing';

const terms = (overrides: Partial<InterestTerms> = {}): InterestTerms => ({
  principal: gbp('1000'),
  statedAnnualRate: '10',
  rateBasis: 'nominal',
  compounding: 'monthly',
  fees: null,
  withdrawalTerms: null,
  counterparty: null,
  startDate: null,
  maturityDate: null,
  verified: true,
  ...overrides,
});

describe('rate formulas (test vectors)', () => {
  it('10% nominal compounded monthly is 10.4713067…% effective', () => {
    expect(periodicRate('0.1', 12).toFixed(18)).toBe('0.008333333333333333');
    const effective = nominalToEffective('0.1', 12);
    expect(effective.times(100).toFixed(7)).toBe('10.4713067');
    expect(effective.toFixed(20)).toBe('0.10471306744129724159');
  });

  it('10% effective annual is 0.7974140…% a month', () => {
    const monthly = effectiveToMonthly('0.1');
    expect(monthly.times(100).toFixed(7)).toBe('0.7974140');
    expect(monthly.toFixed(20)).toBe('0.00797414042890374107');
    // Round trip: compounding the monthly rate 12 times gives back 10%.
    expect(dec('1').plus(monthly).pow(12).minus(1).toDecimalPlaces(30).toFixed()).toBe('0.1');
  });

  it('converts between nominal and effective for other frequencies', () => {
    expect(nominalToEffective('0.08', 4).toFixed(8)).toBe('0.08243216');
    expect(nominalToEffective('0.1', 1).toFixed()).toBe('0.1');
    expect(effectiveToNominal(nominalToEffective('0.06', 4), 4).toDecimalPlaces(20).toFixed()).toBe('0.06');
    expect(() => periodicRate('0.1', 0)).toThrow(PlanningError);
    expect(() => effectiveToMonthly('-1')).toThrow(PlanningError);
  });

  it('derives monthly and effective rates per basis', () => {
    expect(ratesFor('nominal', '0.12', 'monthly').monthly.toFixed()).toBe('0.01');
    expect(ratesFor('nominal', '0.12', 'simple')).toEqual(expect.objectContaining({ simple: true }));
    expect(ratesFor('nominal', '0.12', 'simple').effectiveAnnual.toFixed()).toBe('0.12');
    expect(ratesFor('nominal', '0.08', 'quarterly').monthly.toFixed(12)).toBe('0.006622709560');
    expect(ratesFor('nominal', '0.1', 'unknown').effectiveAnnual.toFixed(10)).toBe(nominalToEffective('0.1', 12).toFixed(10));
    expect(ratesFor('effective', '0.1', 'daily').effectiveAnnual.toFixed()).toBe('0.1');
  });
});

describe('balance projection and accrual', () => {
  it('projects a GBP 1,000 test balance over 12 months under each basis', () => {
    const nominal = ratesFor('nominal', '0.1', 'monthly');
    const effective = ratesFor('effective', '0.1', 'monthly');
    expect(projectBalance(gbp('1000'), nominal.monthly, 12)).toEqual(gbp('1104.71'));
    expect(projectBalance(gbp('1000'), effective.monthly, 12)).toEqual(gbp('1100'));
    expect(projectBalance(gbp('1000'), '0.01', 6, true)).toEqual(gbp('1060'));
    expect(projectBalance(gbp('1000'), '0.01', 0)).toEqual(gbp('1000'));
    expect(() => projectBalance(gbp('1000'), '0.01', -1)).toThrow(PlanningError);
  });

  it('accrues interest on actual days / 365', () => {
    expect(accruedInterest(gbp('1000'), '0.1', 'nominal', 'simple', '2026-01-01', '2026-04-11')).toEqual(gbp('27.4'));
    // Daily compounding: 1000 × ((1 + 0.1/365)^100 − 1) = 27.7721…
    expect(accruedInterest(gbp('1000'), '0.1', 'nominal', 'daily', '2026-01-01', '2026-04-11')).toEqual(gbp('27.77'));
    // Effective 10% over 365 days is exactly 10%.
    expect(accruedInterest(gbp('1000'), '0.1', 'effective', 'monthly', '2026-01-01', '2027-01-01')).toEqual(gbp('100'));
    expect(accruedInterest(gbp('1000'), '0.1', 'nominal', 'monthly', '2026-01-01', '2027-01-01')).toEqual(gbp('104.71'));
    expect(() => accruedInterest(gbp('1000'), '0.1', 'nominal', 'monthly', '2026-02-01', '2026-01-01')).toThrow(PlanningError);
  });
});

describe('projectInterest', () => {
  it('projects the stated basis in percent and flags accrued interest as not spendable', () => {
    const result = projectInterest(terms(), { asOf: '2026-03-10', months: 12 });
    expect(() => InterestProjection.parse(result)).not.toThrow();
    expect(result.basisScenarios).toEqual([
      {
        basis: 'nominal',
        monthlyRate: '0.833333333333333333',
        effectiveAnnualRate: '10.471306744129724159',
        projectedBalance: gbp('1104.71'),
        accruedInterest: null,
      },
    ]);
    expect(result.caveats[0]).toBe('Accrued interest is not spendable until it has been paid out and can be withdrawn.');
    expect(result.caveats).toContain('The start date is unknown, so accrued interest cannot be calculated.');
  });

  it('returns both readings with a caveat when the basis is unverified', () => {
    const result = projectInterest(terms({ rateBasis: 'unverified', verified: false }), { asOf: '2026-03-10', months: 12 });
    expect(result.basisScenarios.map((s) => [s.basis, s.monthlyRate.slice(0, 9), s.effectiveAnnualRate.slice(0, 10), s.projectedBalance?.amount])).toEqual([
      ['nominal', '0.8333333', '10.4713067', '1104.71'],
      ['effective', '0.7974140', '10', '1100'],
    ]);
    expect(result.caveats.some((c) => c.startsWith('The rate basis is unverified, so both readings of 10% are shown'))).toBe(true);
    expect(result.caveats).toContain('These terms have not been verified against a document.');
  });

  it('compares posted interest with each reading', () => {
    const result = projectInterest(terms({ rateBasis: 'unverified', startDate: '2025-03-10' }), {
      asOf: '2026-03-10',
      months: 1,
      balance: gbp('1100'),
      posted: [
        { date: '2025-09-10', amount: gbp('50') },
        { date: '2026-03-10', amount: gbp('50') },
        { date: '2026-04-10', amount: gbp('999') },
        { date: '2025-01-01', amount: gbp('999') },
        { date: '2025-12-01', amount: { amount: '5', currency: 'USD' } },
      ],
    });
    expect(result.postedInterestToDate).toEqual(gbp('100'));
    expect(result.basisScenarios.map((s) => s.accruedInterest)).toEqual([gbp('104.71'), gbp('100')]);
    expect(result.basisScenarios.map((s) => s.projectedBalance)).toEqual([gbp('1109.17'), gbp('1108.77')]);
    expect(result.caveats).toContain('Posted interest (100 GBP) is 4.71 below the nominal reading (104.71).');
    expect(result.caveats).toContain('Posted interest (100 GBP) is consistent with the effective reading (100).');
    expect(result.caveats).toContain('A posted interest entry on 2025-12-01 is in USD and was not compared.');
  });

  it('explains fees, withdrawal terms, counterparty risk, maturity and unknowns', () => {
    const result = projectInterest(
      terms({ compounding: 'unknown', fees: '1% exit fee', withdrawalTerms: '90 days notice', counterparty: 'Sample Lender', maturityDate: '2026-06-30', principal: null }),
      { asOf: '2026-03-10', months: 12 },
    );
    expect(result.caveats).toEqual(
      expect.arrayContaining([
        'The compounding frequency is unknown; monthly compounding is assumed for the nominal reading.',
        'Fees may reduce the return: 1% exit fee',
        'Withdrawal terms: 90 days notice',
        'Returns depend on the counterparty (Sample Lender) being able to pay; this is not a guaranteed return.',
        'The projection runs past the maturity date 2026-06-30; terms after maturity are not known.',
        'The balance is unknown, so no projected balance can be shown.',
      ]),
    );
    expect(result.basisScenarios[0]?.projectedBalance).toBeNull();
  });

  it('handles simple interest and unknown rates', () => {
    const simple = projectInterest(terms({ compounding: 'simple' }), { asOf: '2026-03-10', months: 12 });
    expect(simple.basisScenarios[0]?.projectedBalance).toEqual(gbp('1100'));
    expect(simple.caveats).toContain('Simple interest: interest does not compound.');
    const unknown = projectInterest(terms({ statedAnnualRate: null }), { asOf: '2026-03-10', months: 12, posted: [{ date: '2026-01-01', amount: gbp('3') }] });
    expect(unknown.basisScenarios).toEqual([]);
    expect(unknown.postedInterestToDate).toEqual(gbp('3'));
    expect(unknown.caveats).toContain('The interest rate is unknown, so nothing can be projected.');
    expect(() => projectInterest(terms(), { asOf: '2026-03-10', months: -1 })).toThrow(PlanningError);
  });
});
