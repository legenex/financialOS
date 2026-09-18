import { CoverageGap, Reconciliation } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, money } from '../money';
import {
  checkRunningBalance,
  checkStatement,
  coverageWindow,
  detectCoverageGaps,
  mergeCoverage,
  ReconciliationError,
  toReconciliationRecord,
  type BalanceRow,
  type StatementCheckInput,
} from './reconciliation';
import { uuid } from './test-support';

const ACC = uuid(1);
const usd = (amount: string) => money(amount, 'USD');

describe('checkStatement', () => {
  const base: StatementCheckInput = {
    accountId: ACC,
    accountLabel: 'Example current account',
    currency: 'USD',
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    opening: usd('1000.00'),
    closing: usd('1234.57'),
    movements: [
      { amount: usd('0.10'), bookedOn: '2026-05-02' },
      { amount: usd('0.20'), bookedOn: '2026-05-03' },
      { amount: usd('500'), bookedOn: '2026-05-10' },
      { amount: usd('-265.73'), bookedOn: '2026-05-20' },
    ],
  };

  it('balances when opening + movements = closing, with exact decimals', () => {
    const result = checkStatement(base);
    expect(result).toMatchObject({ status: 'balanced', movements: usd('234.57'), expectedClosing: usd('1234.57'), difference: usd('0'), movementCount: 4, exception: null });
    expect(result.explanation.items.map((i) => i.role)).toEqual(['input', 'input', 'input', 'result', 'result']);
  });

  it('surfaces a discrepancy without creating a balancing entry', () => {
    const result = checkStatement({ ...base, closing: usd('1250.00') });
    expect(result.status).toBe('discrepancy');
    expect(result.difference).toEqual(usd('15.43'));
    expect(result.expectedClosing).toEqual(usd('1234.57'));
    expect(result.movements).toEqual(usd('234.57'));
    expect(result.exception).toMatchObject({ kind: 'reconciliation_discrepancy', severity: 'warning', subject: { type: 'account', id: ACC } });
    expect(result.exception!.dedupeKey).toBe(`reconciliation_discrepancy:account:${ACC}:2026-05-01..2026-05-31`);
    expect(result.exception!.detail).toMatch(/Nothing was posted/);
    // The result contains no entry, line or adjustment of any kind.
    expect(Object.keys(result).sort()).toEqual(
      ['accountId', 'actualClosing', 'difference', 'exception', 'excludedOtherCurrency', 'excludedOutOfPeriod', 'excludedPending', 'expectedClosing', 'explanation', 'movementCount', 'movements', 'openingBalance', 'periodEnd', 'periodStart', 'status'].sort(),
    );
    const record = toReconciliationRecord(result, { id: uuid(9), batchId: null });
    expect(Reconciliation.parse(record)).toEqual(record);
    expect(record).toMatchObject({ status: 'discrepancy', difference: usd('15.43'), resolvedAt: null, resolution: null });
  });

  it('excludes pending, out-of-period and foreign-currency rows with notes', () => {
    const result = checkStatement({
      ...base,
      movements: [
        ...base.movements,
        { amount: usd('-40'), pending: true },
        { amount: usd('-99'), bookedOn: '2026-06-01' },
      ],
    });
    expect(result).toMatchObject({ status: 'balanced', excludedPending: 1, excludedOutOfPeriod: 1 });
    expect(result.explanation.assumptions).toHaveLength(2);
    const foreign = checkStatement({ ...base, movements: [...base.movements, { amount: money('10', 'EUR') }] });
    expect(foreign.status).toBe('incomplete');
    expect(foreign.excludedOtherCurrency).toBe(1);
    expect(foreign.exception?.kind).toBe('reconciliation_question');
  });

  it('is incomplete when a statement balance is unknown', () => {
    const noClosing = checkStatement({ ...base, closing: null });
    expect(noClosing).toMatchObject({ status: 'incomplete', difference: null, expectedClosing: usd('1234.57') });
    expect(noClosing.explanation.missing).toContain('Closing balance is unknown');
    const noOpening = checkStatement({ ...base, opening: null });
    expect(noOpening).toMatchObject({ status: 'incomplete', difference: null, expectedClosing: null });
  });

  it('validates the period and balance currencies', () => {
    expect(() => checkStatement({ ...base, periodEnd: '2026-04-30' })).toThrow(ReconciliationError);
    expect(() => checkStatement({ ...base, closing: money('1', 'EUR') })).toThrow(CurrencyMismatchError);
  });
});

describe('checkRunningBalance', () => {
  const oldest: BalanceRow[] = [
    { rowNumber: 1, bookedOn: '2026-05-01', amount: usd('-10'), balance: usd('90') },
    { rowNumber: 2, bookedOn: '2026-05-02', amount: usd('-5.5'), balance: null },
    { rowNumber: 3, bookedOn: '2026-05-03', amount: usd('20'), balance: usd('104.5') },
    { rowNumber: 4, bookedOn: '2026-05-04', amount: usd('-0.01'), balance: usd('104.49') },
  ];

  it('confirms continuity for oldest-first files, carrying rows without a balance', () => {
    const result = checkRunningBalance(oldest);
    expect(result).toMatchObject({ status: 'continuous', order: 'oldest_first', orderDetectedFrom: 'dates', checkedRows: 2, rowsWithoutBalance: 1, firstBreak: null });
    expect(checkRunningBalance(oldest, { openingBalance: usd('100') }).checkedRows).toBe(3);
    expect(checkRunningBalance(oldest, { openingBalance: usd('101') }).firstBreak).toMatchObject({ rowNumber: 1, previousRowNumber: null, difference: usd('-1') });
  });

  it('detects newest-first files from dates and finds the first break', () => {
    const newest = [...oldest].reverse().map((r, i) => ({ ...r, rowNumber: i + 1 }));
    expect(checkRunningBalance(newest)).toMatchObject({ status: 'continuous', order: 'newest_first', orderDetectedFrom: 'dates' });
    // Break the chronologically second balance (file row 2 in newest-first order).
    const broken = newest.map((r) => (r.bookedOn === '2026-05-03' ? { ...r, balance: usd('104.6') } : r));
    const result = checkRunningBalance(broken);
    expect(result.status).toBe('broken');
    expect(result.firstBreak).toEqual({ rowNumber: 2, previousRowNumber: 4, expected: usd('104.5'), actual: usd('104.6'), difference: usd('0.1') });
    // The next row is checked against the balance the file shows, so one bad row causes two breaks.
    expect(result.breaks.map((b) => b.rowNumber)).toEqual([2, 1]);
  });

  it('infers the order from balances when dates do not help', () => {
    const undated = [...oldest].reverse().map((r, i) => ({ rowNumber: i + 1, amount: r.amount, balance: r.balance }));
    expect(checkRunningBalance(undated)).toMatchObject({ status: 'continuous', order: 'newest_first', orderDetectedFrom: 'balances' });
    expect(checkRunningBalance(undated, { order: 'oldest_first' })).toMatchObject({ status: 'broken', orderDetectedFrom: 'option' });
  });

  it('reports when there is nothing to check', () => {
    expect(checkRunningBalance([{ rowNumber: 1, amount: usd('1'), balance: null }]).status).toBe('not_applicable');
    expect(checkRunningBalance([{ rowNumber: 1, amount: usd('1'), balance: usd('5') }]).status).toBe('not_applicable');
    expect(checkRunningBalance([]).status).toBe('not_applicable');
  });

  it('refuses mixed currencies', () => {
    expect(() => checkRunningBalance([{ rowNumber: 1, amount: usd('1'), balance: money('1', 'EUR') }])).toThrow(CurrencyMismatchError);
  });
});

describe('coverage gaps', () => {
  it('builds a 24-month window', () => {
    expect(coverageWindow('2026-09-17', 24)).toEqual({ from: '2024-10-01', to: '2026-09-17' });
    expect(coverageWindow('2026-09-17', 1)).toEqual({ from: '2026-09-01', to: '2026-09-17' });
    expect(() => coverageWindow('2026-09-17', 0)).toThrow(ReconciliationError);
  });

  it('merges overlapping and adjacent periods', () => {
    expect(
      mergeCoverage([
        { from: '2026-03-01', to: '2026-03-31' },
        { from: '2026-01-01', to: '2026-01-31' },
        { from: '2026-02-01', to: '2026-02-10' },
        { from: '2026-02-05', to: '2026-02-20' },
      ]),
    ).toEqual([
      { from: '2026-01-01', to: '2026-02-20' },
      { from: '2026-03-01', to: '2026-03-31' },
    ]);
    expect(() => mergeCoverage([{ from: '2026-02-01', to: '2026-01-01' }])).toThrow(ReconciliationError);
  });

  it('finds missing days, missing months and partial months over a 24-month window', () => {
    const window = coverageWindow('2026-09-17', 24);
    const report = detectCoverageGaps({
      accountId: ACC,
      accountLabel: 'Example current account',
      window,
      periods: [
        { from: '2024-01-01', to: '2025-03-31', source: 'statements' },
        { from: '2025-06-01', to: '2025-12-31', source: 'statements' },
        { from: '2026-01-01', to: '2026-08-15', source: 'api' },
      ],
    });
    expect(report.gaps).toEqual([
      { accountId: ACC, from: '2025-04-01', to: '2025-05-31', reason: 'No statement or sync covers these dates' },
      { accountId: ACC, from: '2026-08-16', to: '2026-09-17', reason: 'No coverage after the last covered period' },
    ]);
    for (const gap of report.gaps) expect(CoverageGap.parse(gap)).toEqual(gap);
    expect(report.missingMonths).toEqual(['2025-04', '2025-05', '2026-09']);
    expect(report.partialMonths).toEqual(['2026-08']);
    expect(report.windowDays).toBe(717);
    expect(report.coveredDays).toBe(717 - 61 - 33);
    expect(report.complete).toBe(false);
    expect(report.exceptions.map((e) => e.dedupeKey)).toEqual([`missing_period:account:${ACC}:2025-04-01..2025-05-31`, `missing_period:account:${ACC}:2026-08-16..2026-09-17`]);
  });

  it('reports history that starts late, no coverage at all, and complete coverage', () => {
    const window = { from: '2026-01-01', to: '2026-03-31' };
    const late = detectCoverageGaps({ accountId: ACC, window, periods: [{ from: '2026-02-10', to: '2026-04-30' }] });
    expect(late.gaps).toEqual([{ accountId: ACC, from: '2026-01-01', to: '2026-02-09', reason: 'No history before the first covered period in the requested window' }]);
    expect(late.missingMonths).toEqual(['2026-01']);
    expect(late.partialMonths).toEqual(['2026-02']);
    const none = detectCoverageGaps({ accountId: ACC, window, periods: [] });
    expect(none.gaps).toEqual([{ accountId: ACC, from: '2026-01-01', to: '2026-03-31', reason: 'No coverage at all in the requested window' }]);
    expect(none.coveredDays).toBe(0);
    const full = detectCoverageGaps({ accountId: ACC, window, periods: [{ from: '2025-12-01', to: '2026-02-28' }, { from: '2026-03-01', to: '2026-12-31' }] });
    expect(full).toMatchObject({ complete: true, gaps: [], missingMonths: [], partialMonths: [], coveredDays: 90, windowDays: 90 });
    expect(() => detectCoverageGaps({ accountId: ACC, window: { from: '2026-02-01', to: '2026-01-01' }, periods: [] })).toThrow(ReconciliationError);
  });
});
