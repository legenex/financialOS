import { describe, expect, it } from 'vitest';
import {
  add,
  addMonths,
  allocate,
  convert,
  CurrencyMismatchError,
  expandCadence,
  formatMoney,
  fromBaseUnits,
  FxTable,
  hasValidPrecision,
  money,
  roundToCurrency,
  sub,
  sum,
  toBaseUnits,
  toLocalDate,
} from './index';

describe('money', () => {
  it('adds without binary floating point error', () => {
    expect(add(money('0.1', 'USD'), money('0.2', 'USD')).amount).toBe('0.3');
    expect(sum([money('1000000000000.01', 'ZAR'), money('0.02', 'ZAR')], 'ZAR').amount).toBe('1000000000000.03');
  });

  it('refuses to mix currencies', () => {
    expect(() => sub(money('1', 'USD'), money('1', 'GBP'))).toThrow(CurrencyMismatchError);
  });

  it('rounds half-even to currency minor units', () => {
    expect(roundToCurrency(money('2.345', 'USD')).amount).toBe('2.34');
    expect(roundToCurrency(money('2.355', 'USD')).amount).toBe('2.36');
    expect(roundToCurrency(money('1.5', 'JPY')).amount).toBe('2');
    expect(hasValidPrecision(money('0.123456789', 'BTC'))).toBe(false);
    expect(hasValidPrecision(money('0.00000001', 'BTC'))).toBe(true);
  });

  it('allocates without losing minor units', () => {
    const parts = allocate(money('100', 'USD'), ['1', '1', '1']);
    expect(parts.map((p) => p.amount)).toEqual(['33.34', '33.33', '33.33']);
    expect(sum(parts, 'USD').amount).toBe('100');
    const negative = allocate(money('-0.05', 'ZAR'), ['1', '1']);
    expect(sum(negative, 'ZAR').amount).toBe('-0.05');
  });

  it('handles crypto base units exactly', () => {
    expect(fromBaseUnits(123456789n, 'BTC').amount).toBe('1.23456789');
    expect(fromBaseUnits(1n, 'ETH').amount).toBe('0.000000000000000001');
    expect(toBaseUnits(money('4.5', 'ETH'))).toBe(4_500_000_000_000_000_000n);
  });

  it('formats for display', () => {
    expect(formatMoney(money('-1234.5', 'USD'))).toBe('−$1,234.50');
    expect(formatMoney(money('0.5', 'BTC'))).toBe('BTC 0.50000000');
  });
});

describe('dates', () => {
  it('clamps month arithmetic to month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('expands monthly cadence with day clamping', () => {
    expect(expandCadence('2026-01-31', 'monthly', '2026-02-01', '2026-04-30')).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('expands weekly cadence from a past anchor', () => {
    expect(expandCadence('2026-01-05', 'weekly', '2026-01-20', '2026-02-03')).toEqual(['2026-01-26', '2026-02-02']);
  });

  it('never invents dates for unknown cadence', () => {
    expect(expandCadence('2026-03-01', 'unknown', '2026-04-01', '2026-05-01')).toEqual([]);
  });

  it('converts instants to local calendar dates', () => {
    expect(toLocalDate('2026-03-31T22:30:00Z', 'Africa/Johannesburg')).toBe('2026-04-01');
    expect(toLocalDate('2026-03-31T22:30:00Z', 'America/New_York')).toBe('2026-03-31');
  });
});

describe('fx', () => {
  const table = new FxTable([
    { base: 'USD', quote: 'ZAR', rate: '18.25', asOf: '2026-03-02', source: 'test' },
    { base: 'GBP', quote: 'USD', rate: '1.25', asOf: '2026-03-02', source: 'test' },
  ]);

  it('converts with provenance and rounding', () => {
    const result = convert(money('100', 'USD'), 'ZAR', '2026-03-03', table);
    expect(result.converted).toEqual(money('1825', 'ZAR'));
    expect(result.fx?.rateAsOf).toBe('2026-03-02');
  });

  it('uses inverse and pivot rates', () => {
    expect(convert(money('1825', 'ZAR'), 'USD', '2026-03-02', table).converted?.amount).toBe('100');
    expect(convert(money('100', 'GBP'), 'ZAR', '2026-03-02', table).converted?.amount).toBe('2281.25');
  });

  it('never uses a future rate and never returns zero for a missing rate', () => {
    const result = convert(money('10', 'USD'), 'ZAR', '2026-03-01', table);
    expect(result.converted).toBeNull();
    expect(result.unconvertedReason).toMatch(/No USD→ZAR rate/);
  });

  it('rejects stale rates beyond the limit', () => {
    expect(convert(money('10', 'USD'), 'ZAR', '2026-04-30', table).converted).toBeNull();
  });
});
