import { PortfolioSummary } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { D, money } from '../money';
import {
  adjustForSplits,
  computePerformance,
  computePortfolio,
  portfolioSummary,
  simulateTargetAllocation,
  TARGET_ALLOCATION_CAVEATS,
  xirr,
  type PerformanceInput,
  type PortfolioHoldingLine,
  type PortfolioInput,
  type PortfolioHoldingsSnapshot,
} from './portfolio';
import { PlanningError } from './shared';
import { deepFreeze, uid, usd } from './testing';

const BROKER = uid(500);
const RESTRICTED_ACCOUNT = uid(501);
const AAA = uid(510);
const BBB = uid(511);
const EEE = uid(512);
const RES = uid(513);

const eur = (amount: string) => money(amount, 'EUR');
const FX = new FxTable([{ base: 'EUR', quote: 'USD', rate: '1.2', asOf: '2026-03-08', source: 'test' }]);

function line(overrides: Partial<PortfolioHoldingLine> & { instrument: PortfolioHoldingLine['instrument'] }): PortfolioHoldingLine {
  return { quantity: null, price: null, priceAsOf: null, value: null, costBasis: null, costBasisComplete: false, restricted: false, ...overrides };
}

const SNAPSHOT: PortfolioHoldingsSnapshot = {
  accountId: BROKER,
  asOf: '2026-03-10',
  completeness: 'complete',
  lines: [
    line({
      instrument: { id: AAA, symbol: 'AAA', name: 'Example Equity A', kind: 'equity', currency: 'USD' },
      quantity: '100',
      price: usd('50'),
      costBasis: usd('4000'),
      costBasisComplete: true,
    }),
    line({ instrument: { id: BBB, symbol: 'BBB', name: 'Example Index ETF', kind: 'etf', currency: 'USD' }, quantity: '200', price: usd('10') }),
    line({
      instrument: { id: EEE, symbol: 'EEE', name: 'Example Equity E', kind: 'equity', currency: 'EUR' },
      quantity: '10',
      price: eur('100'),
      costBasis: eur('800'),
      costBasisComplete: true,
    }),
  ],
};

function input(overrides: Partial<PortfolioInput> = {}): PortfolioInput {
  return { currency: 'USD', asOf: '2026-03-10', snapshots: [SNAPSHOT], fx: FX, ...overrides };
}

describe('allocation, exposure and concentration', () => {
  it('splits 8 200 USD across kinds, currencies and positions', () => {
    const { summary, positions } = computePortfolio(deepFreeze(input()));
    expect(() => PortfolioSummary.parse(summary)).not.toThrow();
    expect(summary.status).toBe('ok');
    expect(summary.totalMarketable).toEqual(usd('8200'));
    expect(summary.allocation).toEqual([
      { label: 'equity', value: usd('6200'), share: '0.756098' },
      { label: 'etf', value: usd('2000'), share: '0.243902' },
    ]);
    expect(summary.currencyExposure).toEqual([
      { currency: 'USD', value: usd('7000'), share: '0.853659' },
      { currency: 'EUR', value: usd('1200'), share: '0.146341' },
    ]);
    expect(positions.map((p) => [p.symbol, p.quantity, p.value])).toEqual([
      ['AAA', '100', usd('5000')],
      ['BBB', '200', usd('2000')],
      ['EEE', '10', usd('1200')],
    ]);
  });

  it('warns on a position above the concentration threshold and nowhere else', () => {
    const { summary } = computePortfolio(input());
    expect(summary.concentration).toEqual([
      { label: 'AAA', share: '0.609756', warning: true },
      { label: 'BBB', share: '0.243902', warning: true },
      { label: 'EEE', share: '0.146341', warning: false },
    ]);
    const relaxed = computePortfolio(input({ concentrationThreshold: '0.7' })).summary;
    expect(relaxed.concentration.map((c) => c.warning)).toEqual([false, false, false]);
  });

  it('reports cost-basis completeness as the share of value with a complete basis', () => {
    // AAA 5 000 and EEE 1 200 have a complete basis; BBB 2 000 does not.
    expect(computePortfolio(input()).summary.costBasisCompleteness).toBe('0.756098');
    const none = computePortfolio(
      input({ snapshots: [{ ...SNAPSHOT, lines: SNAPSHOT.lines.map((l) => ({ ...l, costBasisComplete: false })) }] }),
    ).summary;
    expect(none.costBasisCompleteness).toBe('0');
  });

  it('adds the same symbol held in two accounts together', () => {
    const second: PortfolioHoldingsSnapshot = {
      accountId: uid(502),
      asOf: '2026-03-10',
      completeness: 'complete',
      lines: [line({ instrument: { id: AAA, symbol: 'AAA', name: 'Example Equity A', kind: 'equity', currency: 'USD' }, quantity: '20', price: usd('50') })],
    };
    const { positions, summary } = computePortfolio(input({ snapshots: [SNAPSHOT, second] }));
    const aaa = positions.find((p) => p.symbol === 'AAA')!;
    expect(aaa.quantity).toBe('120');
    expect(aaa.value).toEqual(usd('6000'));
    expect(aaa.accountIds).toEqual([BROKER, uid(502)]);
    expect(summary.totalMarketable).toEqual(usd('9200'));
  });

  it('counts an unknown value as unknown, never as zero', () => {
    const withUnknown = computePortfolio(
      input({
        snapshots: [{ ...SNAPSHOT, lines: [...SNAPSHOT.lines, line({ instrument: { id: uid(514), symbol: 'UNK', name: 'Example Private Note', kind: 'private_note', currency: 'USD' } })] }],
      }),
    );
    expect(withUnknown.summary.status).toBe('provisional');
    expect(withUnknown.summary.totalMarketable).toEqual(usd('8200'));
    expect(withUnknown.positions.find((p) => p.symbol === 'UNK')!.value).toBeNull();
  });

  it('is provisional when a snapshot is not complete, and insufficient when nothing has a value', () => {
    expect(computePortfolio(input({ snapshots: [{ ...SNAPSHOT, completeness: 'partial' }] })).summary.status).toBe('provisional');
    const nothing = computePortfolio(input({ snapshots: [{ ...SNAPSHOT, lines: [line({ instrument: { id: AAA, symbol: 'AAA', name: 'A', kind: 'equity', currency: 'USD' } })] }] }));
    expect(nothing.summary.status).toBe('insufficient_data');
    expect(nothing.summary.totalMarketable).toBeNull();
    expect(nothing.summary.costBasisCompleteness).toBeNull();
  });

  it('leaves a value it cannot convert out of the total', () => {
    const noRate = computePortfolio(input({ fx: new FxTable() }));
    expect(noRate.summary.totalMarketable).toEqual(usd('7000'));
    expect(noRate.summary.status).toBe('provisional');
    expect(noRate.summary.currencyExposure.map((c) => c.currency)).toEqual(['USD']);
  });
});

describe('restricted holdings', () => {
  const restrictedLine = line({
    instrument: { id: RES, symbol: 'RES', name: 'Example Restricted Equity', kind: 'restricted_equity', currency: 'USD' },
    quantity: '1000',
    price: usd('2'),
  });

  it('lists them separately, never in the marketable total', () => {
    const { summary, positions } = computePortfolio(
      input({
        snapshots: [SNAPSHOT, { accountId: RESTRICTED_ACCOUNT, asOf: '2026-03-10', completeness: 'complete', lines: [restrictedLine] }],
        restrictions: [{ accountId: RESTRICTED_ACCOUNT, instrumentId: RES, status: 'verified' }],
      }),
    );
    expect(summary.totalMarketable).toEqual(usd('8200'));
    expect(positions.some((p) => p.symbol === 'RES')).toBe(false);
    expect(summary.restricted).toEqual([
      {
        accountId: RESTRICTED_ACCOUNT,
        instrument: 'RES',
        quantity: '1000',
        indicativeValue: usd('2000'),
        restrictionStatus: 'verified',
        note: 'Indicative value only. Restricted holdings are not part of spending capacity, runway or the marketable total.',
      },
    ]);
  });

  it('treats a line flag, a whole restricted account and a restricted instrument kind the same way', () => {
    const byFlag = computePortfolio(
      input({ snapshots: [{ ...SNAPSHOT, lines: [{ ...SNAPSHOT.lines[0]!, restricted: true }] }] }),
    ).summary;
    expect(byFlag.restricted.map((r) => r.instrument)).toEqual(['AAA']);
    const byAccount = computePortfolio(input({ restrictedAccountIds: [BROKER] })).summary;
    expect(byAccount.restricted).toHaveLength(3);
    expect(byAccount.totalMarketable).toBeNull();
  });

  it('reports the restriction status honestly when the terms are not verified', () => {
    const reported = computePortfolio(
      input({
        snapshots: [{ accountId: RESTRICTED_ACCOUNT, asOf: '2026-03-10', completeness: 'complete', lines: [restrictedLine] }],
        restrictions: [{ accountId: RESTRICTED_ACCOUNT, instrumentId: RES, status: 'reported_unverified' }],
      }),
    ).summary;
    expect(reported.restricted[0]!.restrictionStatus).toBe('reported_unverified');
    const none = computePortfolio(
      input({ snapshots: [{ accountId: RESTRICTED_ACCOUNT, asOf: '2026-03-10', completeness: 'complete', lines: [restrictedLine] }] }),
    ).summary;
    expect(none.restricted[0]!.restrictionStatus).toBe('none_recorded');
    const expired = computePortfolio(
      input({
        snapshots: [{ accountId: RESTRICTED_ACCOUNT, asOf: '2026-03-10', completeness: 'complete', lines: [restrictedLine] }],
        restrictions: [{ accountId: RESTRICTED_ACCOUNT, instrumentId: RES, status: 'expired' }],
      }),
    ).summary;
    expect(expired.restricted[0]!.restrictionStatus).toBe('none_recorded');
  });
});

describe('corporate actions', () => {
  const action = { id: uid(520), symbol: 'AAA', kind: 'split' as const, ratio: '2', effectiveOn: '2026-02-15' };
  const snapshotAt = (asOf: string, quantity: string, price: string, priceAsOf: string | null): PortfolioHoldingsSnapshot => ({
    accountId: BROKER,
    asOf,
    completeness: 'complete',
    lines: [line({ instrument: { id: AAA, symbol: 'AAA', name: 'Example Equity A', kind: 'equity', currency: 'USD' }, quantity, price: usd(price), priceAsOf })],
  });

  it('adjusts a pre-split snapshot quantity without double counting the price', () => {
    // 100 shares before a 2-for-1 split, priced after it: 200 × 50 = 10 000.
    const after = computePortfolio(input({ snapshots: [snapshotAt('2026-01-31', '100', '50', '2026-03-09')], corporateActions: [action] }));
    expect(after.positions[0]!.quantity).toBe('200');
    expect(after.summary.totalMarketable).toEqual(usd('10000'));
    expect(after.appliedCorporateActions).toEqual([{ accountId: BROKER, symbol: 'AAA', actionId: uid(520) }]);

    // The same holding priced before the split: 200 × 100 / 2 = 10 000, the same answer.
    const before = computePortfolio(input({ snapshots: [snapshotAt('2026-01-31', '100', '100', '2026-02-01')], corporateActions: [action] }));
    expect(before.summary.totalMarketable).toEqual(usd('10000'));
  });

  it('leaves a snapshot that already reflects the split alone', () => {
    const onDate = computePortfolio(input({ snapshots: [snapshotAt('2026-02-15', '200', '50', '2026-03-09')], corporateActions: [action] }));
    expect(onDate.positions[0]!.quantity).toBe('200');
    expect(onDate.appliedCorporateActions).toEqual([]);
    const later = computePortfolio(input({ snapshots: [snapshotAt('2026-03-01', '200', '50', '2026-03-09')], corporateActions: [action] }));
    expect(later.positions[0]!.quantity).toBe('200');
  });

  it('ignores an action effective after the reporting date', () => {
    const future = computePortfolio(
      input({ snapshots: [snapshotAt('2026-01-31', '100', '50', '2026-03-09')], corporateActions: [{ ...action, effectiveOn: '2026-04-01' }] }),
    );
    expect(future.positions[0]!.quantity).toBe('100');
  });

  it('applies a reverse split and refuses ratios that contradict the action', () => {
    const reverse = adjustForSplits(new D(1000), 'AAA', '2026-01-31', [{ ...action, kind: 'reverse_split', ratio: '0.1' }], '2026-03-10');
    expect(reverse.quantity.toFixed()).toBe('100');
    expect(reverse.factor.toFixed()).toBe('0.1');
    expect(() => adjustForSplits(new D(1), 'AAA', '2026-01-01', [{ ...action, ratio: '1' }], '2026-03-10')).toThrow(PlanningError);
    expect(() => adjustForSplits(new D(1), 'AAA', '2026-01-01', [{ ...action, kind: 'reverse_split', ratio: '2' }], '2026-03-10')).toThrow(PlanningError);
    expect(() => adjustForSplits(new D(1), 'AAA', '2026-01-01', [{ ...action, ratio: '0' }], '2026-03-10')).toThrow(PlanningError);
  });

  it('compounds two splits in date order and touches no other symbol', () => {
    const both = adjustForSplits(
      new D(100),
      'AAA',
      '2026-01-01',
      [
        { id: uid(521), symbol: 'AAA', kind: 'split', ratio: '2', effectiveOn: '2026-02-15' },
        { id: uid(522), symbol: 'AAA', kind: 'split', ratio: '3', effectiveOn: '2026-01-15' },
        { id: uid(523), symbol: 'BBB', kind: 'split', ratio: '5', effectiveOn: '2026-02-01' },
      ],
      '2026-03-10',
    );
    expect(both.quantity.toFixed()).toBe('600');
    expect(both.applied.map((a) => a.id)).toEqual([uid(522), uid(521)]);
  });
});

describe('xirr', () => {
  it('solves a one-year 10 % return exactly', () => {
    const rate = xirr([
      { date: '2026-01-01', amount: new D(-1000) },
      { date: '2027-01-01', amount: new D(1100) },
    ])!;
    expect(rate.toDecimalPlaces(8).toFixed()).toBe('0.1');
  });

  it('solves a two-year annuity against the closed-form answer', () => {
    // 100 in, 60 back after each of two years: 3x² + 3x − 5 = 0 with x = 1 / (1 + r).
    const rate = xirr([
      { date: '2026-01-01', amount: new D(-100) },
      { date: '2027-01-01', amount: new D(60) },
      { date: '2028-01-01', amount: new D(60) },
    ])!;
    const closedForm = new D(69).sqrt().minus(3).dividedBy(6);
    expect(rate.toDecimalPlaces(6).toFixed()).toBe(new D(1).dividedBy(closedForm).minus(1).toDecimalPlaces(6).toFixed());
    expect(rate.toDecimalPlaces(6).toFixed()).toBe('0.130662');
  });

  it('solves a negative return', () => {
    const rate = xirr([
      { date: '2026-01-01', amount: new D(-1000) },
      { date: '2027-01-01', amount: new D(900) },
    ])!;
    expect(rate.toDecimalPlaces(8).toFixed()).toBe('-0.1');
  });

  it('returns nothing when no rate can exist', () => {
    expect(xirr([{ date: '2026-01-01', amount: new D(-1000) }])).toBeNull();
    expect(xirr([{ date: '2026-01-01', amount: new D(-1000) }, { date: '2027-01-01', amount: new D(-500) }])).toBeNull();
    expect(xirr([{ date: '2026-01-01', amount: new D(1000) }, { date: '2027-01-01', amount: new D(500) }])).toBeNull();
  });
});

describe('performance', () => {
  const twr: PerformanceInput = {
    start: { date: '2026-01-01', value: usd('10000') },
    end: { date: '2026-03-01', value: usd('13230') },
    externalFlows: [{ date: '2026-02-01', amount: usd('2000') }],
    valuations: [{ date: '2026-02-01', value: usd('12600') }],
  };

  it('uses the time-weighted return when a valuation exists on every flow date', () => {
    const { performance, basis } = computePerformance(twr, 'USD', FX);
    // (12 600 − 2 000) / 10 000 × 13 230 / 12 600 − 1
    expect(performance).toEqual({ method: 'time_weighted', value: '0.113', marketChange: usd('1230'), netContributions: usd('2000'), reasonUnavailable: null });
    expect(basis).toBe('period');
  });

  it('separates market change from contributions and withdrawals', () => {
    const withdrawal = computePerformance(
      { ...twr, externalFlows: [{ date: '2026-02-01', amount: usd('-2000') }], valuations: [{ date: '2026-02-01', value: usd('8600') }], end: { date: '2026-03-01', value: usd('9030') } },
      'USD',
      FX,
    );
    expect(withdrawal.performance.netContributions).toEqual(usd('-2000'));
    // 9 030 − 10 000 − (−2 000)
    expect(withdrawal.performance.marketChange).toEqual(usd('1030'));
  });

  it('falls back to the money-weighted return when a flow date has no valuation', () => {
    const { performance, basis } = computePerformance({ ...twr, valuations: [] }, 'USD', FX);
    expect(performance.method).toBe('money_weighted');
    expect(performance.reasonUnavailable).toBeNull();
    expect(performance.marketChange).toEqual(usd('1230'));
    expect(basis).toBe('annualised');
  });

  it('uses the time-weighted return with no flows at all', () => {
    const { performance } = computePerformance({ ...twr, externalFlows: [], valuations: [] }, 'USD', FX);
    expect(performance.method).toBe('time_weighted');
    // 13 230 / 10 000 − 1
    expect(performance.value).toBe('0.323');
    expect(performance.netContributions).toEqual(usd('0'));
    expect(performance.marketChange).toEqual(usd('3230'));
  });

  it('ignores flows outside the measured period', () => {
    const { performance } = computePerformance(
      { ...twr, externalFlows: [{ date: '2025-12-01', amount: usd('9999') }, { date: '2026-04-01', amount: usd('9999') }], valuations: [] },
      'USD',
      FX,
    );
    expect(performance.netContributions).toEqual(usd('0'));
    expect(performance.method).toBe('time_weighted');
  });

  it('gives no method, with a reason, when the data cannot support one', () => {
    const cases: Array<[PerformanceInput | null, string]> = [
      [null, 'No valuation history is available'],
      [{ ...twr, end: { date: '2025-12-01', value: usd('1') } }, 'The end date must be after the start date'],
      [{ ...twr, start: { date: '2026-01-01', value: null } }, 'Start and end valuations are both required'],
      [{ ...twr, end: { date: '2026-03-01', value: null } }, 'Start and end valuations are both required'],
      [{ ...twr, externalFlows: null }, 'External contributions and withdrawals are unknown, so returns and market change cannot be separated'],
    ];
    for (const [performanceInput, reason] of cases) {
      const { performance, basis } = computePerformance(performanceInput, 'USD', FX);
      expect(performance.method).toBe('none');
      expect(performance.value).toBeNull();
      expect(performance.reasonUnavailable).toBe(reason);
      expect(basis).toBeNull();
    }
  });

  it('gives no method when a valuation cannot be converted', () => {
    const { performance } = computePerformance({ ...twr, start: { date: '2026-01-01', value: eur('10000') } }, 'USD', new FxTable());
    expect(performance.method).toBe('none');
    expect(performance.reasonUnavailable).toBe('Valuations could not be converted to USD');
  });

  it('carries the chosen method into the summary', () => {
    const summary = portfolioSummary(input({ performance: twr }));
    expect(summary.performance.method).toBe('time_weighted');
    expect(portfolioSummary(input()).performance).toEqual({
      method: 'none',
      value: null,
      marketChange: null,
      netContributions: null,
      reasonUnavailable: 'No valuation history is available',
    });
  });
});

describe('income', () => {
  it('sums dividends, interest and fees as magnitudes', () => {
    const summary = portfolioSummary(
      input({
        income: [
          { date: '2026-01-15', kind: 'dividend', amount: usd('120') },
          { date: '2026-02-15', kind: 'dividend', amount: usd('80') },
          { date: '2026-02-20', kind: 'interest', amount: usd('15') },
          { date: '2026-02-25', kind: 'fee', amount: usd('-30') },
        ],
      }),
    );
    expect(summary.income).toEqual({ dividends: usd('200'), interest: usd('15'), fees: usd('30') });
  });

  it('leaves income unknown when no history is given', () => {
    expect(portfolioSummary(input()).income).toEqual({ dividends: null, interest: null, fees: null });
    expect(portfolioSummary(input({ income: null })).income).toEqual({ dividends: null, interest: null, fees: null });
  });
});

describe('target allocation simulation', () => {
  it('produces the trades that would reach the targets, as a paper simulation only', () => {
    const { positions } = computePortfolio(input());
    const result = simulateTargetAllocation(positions, [{ label: 'equity', weight: '0.5' }, { label: 'etf', weight: '0.5' }], { currency: 'USD', by: 'kind' });
    expect(result.trades).toEqual([
      { label: 'equity', currentValue: usd('6200'), targetValue: usd('4100'), tradeValue: usd('-2100'), side: 'sell', quantity: null },
      { label: 'etf', currentValue: usd('2000'), targetValue: usd('4100'), tradeValue: usd('2100'), side: 'buy', quantity: null },
    ]);
    expect(result.unallocated).toEqual(usd('0'));
    for (const caveat of TARGET_ALLOCATION_CAVEATS) expect(result.caveats).toContain(caveat);
  });

  it('refuses impossible weights and reports positions it had to leave out', () => {
    const { positions } = computePortfolio(input());
    expect(() => simulateTargetAllocation(positions, [{ label: 'equity', weight: '0.8' }, { label: 'etf', weight: '0.5' }], { currency: 'USD', by: 'kind' })).toThrow(PlanningError);
    expect(() => simulateTargetAllocation(positions, [{ label: 'equity', weight: '-0.1' }], { currency: 'USD', by: 'kind' })).toThrow(PlanningError);
    expect(() => simulateTargetAllocation(positions, [{ label: 'equity', weight: '0.1' }, { label: 'equity', weight: '0.2' }], { currency: 'USD', by: 'kind' })).toThrow(PlanningError);
    const withUnknown = simulateTargetAllocation([...positions, { symbol: 'UNK', name: 'Unknown', kind: 'equity', currency: 'USD', quantity: null, value: null, restricted: false, accountIds: [] }], [], {
      currency: 'USD',
      by: 'kind',
    });
    expect(withUnknown.caveats).toContain('UNK has no known value and was left out.');
  });
});
