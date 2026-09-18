import { RewardComparisonResult, type RewardComparisonInput, type RewardProduct } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { compareRewards, REWARD_CAVEATS, type RewardComparisonOptions } from './rewards';
import { deepFreeze, uid, zar } from './testing';

const CASHBACK = uid(700);
const POINTS = uid(701);

const FX = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18', asOf: '2026-03-08', source: 'test' }]);
const OPTIONS: RewardComparisonOptions = { asOf: '2026-03-10', fx: FX };

function product(overrides: Partial<RewardProduct> & { id: string }): RewardProduct {
  return {
    name: 'Example Cashback Card',
    issuer: 'Example Bank',
    termsAsOf: '2026-02-01',
    sourceUrl: null,
    eligibility: null,
    annualFee: zar('750'),
    earnRate: '1.5',
    earnUnit: 'cashback_percent',
    pointValue: null,
    fxFeePercent: '2.75',
    paymentFeePercent: null,
    notes: null,
    ...overrides,
  };
}

const CASHBACK_CARD = product({ id: CASHBACK });
const POINTS_CARD = product({
  id: POINTS,
  name: 'Example Points Card',
  termsAsOf: '2026-03-01',
  annualFee: zar('2500'),
  earnRate: '1.25',
  earnUnit: 'points_per_currency_unit',
  pointValue: zar('0.15'),
  fxFeePercent: '0',
  paymentFeePercent: '0.5',
});

function input(overrides: Partial<RewardComparisonInput> = {}): RewardComparisonInput {
  return {
    // 120 000 ZAR and 6 000 USD (108 000 ZAR) a year: 228 000 ZAR in total, 108 000 of it foreign.
    monthlySpend: [
      { currency: 'ZAR', amount: '10000', category: 'general' },
      { currency: 'USD', amount: '500', category: 'travel' },
    ],
    productIds: [CASHBACK, POINTS],
    paysFullBalance: true,
    homeCurrency: 'ZAR',
    ...overrides,
  };
}

describe('rewards net of fees and FX', () => {
  it('computes cashback less the annual fee less the FX cost', () => {
    const result = compareRewards(deepFreeze(input()), [CASHBACK_CARD, POINTS_CARD], OPTIONS);
    expect(() => RewardComparisonResult.parse(result)).not.toThrow();
    const row = result.rows.find((r) => r.productId === CASHBACK)!;
    // 228 000 × 1.5 % = 3 420; fee 750; FX 108 000 × 2.75 % = 2 970
    expect(row).toEqual({
      productId: CASHBACK,
      name: 'Example Cashback Card',
      termsAsOf: '2026-02-01',
      annualRewards: zar('3420'),
      annualFees: zar('750'),
      annualFxCosts: zar('2970'),
      netAnnualValue: zar('-300'),
      warnings: [],
    });
  });

  it('values points at the entered point value and adds a payment fee to the fees', () => {
    const row = compareRewards(input(), [CASHBACK_CARD, POINTS_CARD], OPTIONS).rows.find((r) => r.productId === POINTS)!;
    // 228 000 × 1.25 points × 0.15 = 42 750; fees 2 500 + 228 000 × 0.5 % = 3 640; no FX fee entered as zero
    expect(row.annualRewards).toEqual(zar('42750'));
    expect(row.annualFees).toEqual(zar('3640'));
    expect(row.annualFxCosts).toEqual(zar('0'));
    expect(row.netAnnualValue).toEqual(zar('39110'));
  });

  it('keeps the rows in the order asked for and never ranks them', () => {
    const forward = compareRewards(input(), [CASHBACK_CARD, POINTS_CARD], OPTIONS);
    expect(forward.rows.map((r) => r.productId)).toEqual([CASHBACK, POINTS]);
    const reversed = compareRewards(input({ productIds: [POINTS, CASHBACK] }), [CASHBACK_CARD, POINTS_CARD], OPTIONS);
    expect(reversed.rows.map((r) => r.productId)).toEqual([POINTS, CASHBACK]);
  });

  it('charges no FX cost when nothing is spent in another currency', () => {
    const local = compareRewards(input({ monthlySpend: [{ currency: 'ZAR', amount: '10000', category: 'general' }] }), [CASHBACK_CARD], OPTIONS);
    expect(local.rows[0]!.annualFxCosts).toEqual(zar('0'));
    // 120 000 × 1.5 % = 1 800, less the 750 fee
    expect(local.rows[0]!.netAnnualValue).toEqual(zar('1050'));
    expect(local.rows[0]!.warnings).toEqual([]);
  });
});

describe('warnings', () => {
  it('warns when the entered terms are stale', () => {
    const stale = compareRewards(input({ productIds: [CASHBACK] }), [product({ id: CASHBACK, termsAsOf: '2024-01-01' })], OPTIONS);
    expect(stale.rows[0]!.warnings).toEqual([
      'Terms are more than 12 months old (as of 2024-01-01); treat them as stale and check the current terms.',
    ]);
    expect(stale.rows[0]!.termsAsOf).toBe('2024-01-01');

    const tightened = compareRewards(input({ productIds: [CASHBACK] }), [CASHBACK_CARD], { ...OPTIONS, staleAfterMonths: 1 });
    expect(tightened.rows[0]!.warnings[0]).toContain('more than 1 months old');

    // Terms dated exactly on the staleness boundary are not stale.
    const boundary = compareRewards(input({ productIds: [CASHBACK] }), [product({ id: CASHBACK, termsAsOf: '2025-03-10' })], OPTIONS);
    expect(boundary.rows[0]!.warnings).toEqual([]);
  });

  it('gives no reward figure at all when the point value is missing', () => {
    const row = compareRewards(input({ productIds: [POINTS] }), [{ ...POINTS_CARD, pointValue: null }], OPTIONS).rows[0]!;
    expect(row.annualRewards).toBeNull();
    expect(row.netAnnualValue).toBeNull();
    expect(row.warnings).toContain('Point value not set, so points cannot be valued.');
    expect(row.annualFees).toEqual(zar('3640'));
  });

  it('gives no reward figure when the earn rate is missing, and no fee figure when the fee is missing', () => {
    const noRate = compareRewards(input({ productIds: [CASHBACK] }), [product({ id: CASHBACK, earnRate: null })], OPTIONS).rows[0]!;
    expect(noRate.annualRewards).toBeNull();
    expect(noRate.netAnnualValue).toBeNull();
    expect(noRate.warnings).toContain('Earn rate not entered, so rewards cannot be calculated.');

    const noFee = compareRewards(input({ productIds: [CASHBACK] }), [product({ id: CASHBACK, annualFee: null })], OPTIONS).rows[0]!;
    expect(noFee.annualFees).toBeNull();
    expect(noFee.netAnnualValue).toBeNull();
    expect(noFee.warnings).toContain('Annual fee not entered.');
  });

  it('gives no FX figure when the FX fee has not been entered but foreign spending exists', () => {
    const row = compareRewards(input({ productIds: [CASHBACK] }), [product({ id: CASHBACK, fxFeePercent: null })], OPTIONS).rows[0]!;
    expect(row.annualFxCosts).toBeNull();
    expect(row.netAnnualValue).toBeNull();
    expect(row.warnings).toContain('FX fee not entered, so the cost of foreign-currency spending is unknown.');
  });

  it('warns on every row, and in the caveats, when the balance is not paid in full', () => {
    const result = compareRewards(input({ paysFullBalance: false }), [CASHBACK_CARD, POINTS_CARD], OPTIONS);
    expect(result.caveats).toContain('You do not always pay the full balance: interest charges typically cost more than any rewards earned.');
    for (const row of result.rows) expect(row.warnings).toContain('Interest on a carried balance typically exceeds the rewards shown.');
  });

  it('leaves every figure unknown when spending cannot be converted', () => {
    const result = compareRewards(
      input({ monthlySpend: [{ currency: 'GBP', amount: '400', category: 'travel' }], productIds: [CASHBACK] }),
      [CASHBACK_CARD],
      OPTIONS,
    );
    expect(result.caveats).toContain('Spending in GBP (travel) could not be converted to ZAR, so totals are unknown.');
    expect(result.rows[0]).toMatchObject({ annualRewards: null, annualFees: null, annualFxCosts: null, netAnnualValue: null });
  });

  it('leaves out a product with no saved terms and says so', () => {
    const result = compareRewards(input({ productIds: [CASHBACK, uid(999)] }), [CASHBACK_CARD], OPTIONS);
    expect(result.rows).toHaveLength(1);
    expect(result.caveats).toContain('One selected product has no saved terms and was left out.');
  });
});

describe('caveats', () => {
  const result = compareRewards(input(), [CASHBACK_CARD, POINTS_CARD], OPTIONS);

  it('always states the standing caveats first', () => {
    expect(result.caveats.slice(0, REWARD_CAVEATS.length)).toEqual([...REWARD_CAVEATS]);
    expect(REWARD_CAVEATS[0]).toBe('Based on your current spending only. This comparison never suggests spending more to earn rewards.');
    expect(REWARD_CAVEATS.join(' ')).toContain('Nothing here applies for a card or opens an account.');
  });

  it('never suggests spending more, or applying for anything', () => {
    const text = [...result.caveats, ...result.rows.flatMap((r) => r.warnings)].join(' ').toLowerCase();
    for (const phrase of ['spend more', 'increase your spending', 'you could earn more by', 'apply for', 'open an account', 'recommended card', 'best card', 'you should switch']) {
      expect(text).not.toContain(phrase);
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(compareRewards(input(), [CASHBACK_CARD, POINTS_CARD], OPTIONS))).toBe(JSON.stringify(result));
  });
});
