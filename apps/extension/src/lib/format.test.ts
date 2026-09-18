import { describe, expect, it } from 'vitest';
import { clampPercent, formatMoney, formatUserCode, greetingFor, plural } from './format';

describe('formatMoney', () => {
  it('formats the decimal string exactly, without binary floating point', () => {
    expect(formatMoney({ amount: '1284.50', currency: 'EUR' }, 'en-US')).toBe('€1,284.50');
    // 0.1 + 0.2 problems cannot appear: the string is formatted as given.
    expect(formatMoney({ amount: '0.30', currency: 'USD' }, 'en-US')).toBe('$0.30');
    expect(formatMoney({ amount: '-42.07', currency: 'USD' }, 'en-US')).toBe('-$42.07');
  });

  it('keeps every decimal place the server sent', () => {
    expect(formatMoney({ amount: '1.005', currency: 'USD' }, 'en-US')).toBe('$1.005');
    expect(formatMoney({ amount: '10', currency: 'USD' }, 'en-US')).toBe('$10');
    expect(formatMoney({ amount: '123456789012345678.12', currency: 'USD' }, 'en-US')).toContain(
      '123,456,789,012,345,678.12',
    );
  });

  it('falls back for codes Intl does not know, and never invents a number', () => {
    expect(formatMoney({ amount: '0.50000000', currency: 'SATS' }, 'en-US')).toBe('0.50000000 SATS');
    expect(formatMoney({ amount: 'not a number', currency: 'USD' }, 'en-US')).toBe('not a number USD');
  });
});

describe('clampPercent', () => {
  it('keeps percentages inside a sensible range', () => {
    expect(clampPercent(57)).toBe(57);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(140, 999)).toBe(140);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('greetingFor', () => {
  it('matches the time of day in the reader’s own timezone', () => {
    const at = (hour: number) => greetingFor(new Date(2026, 8, 18, hour, 0, 0));
    expect(at(7)).toBe('Good morning');
    expect(at(13)).toBe('Good afternoon');
    expect(at(19)).toBe('Good evening');
    expect(at(2)).toBe('Hello');
  });
});

describe('small helpers', () => {
  it('pluralises and normalises the pairing code', () => {
    expect(plural(1, 'item', 'items')).toBe('1 item');
    expect(plural(0, 'day', 'days')).toBe('0 days');
    expect(formatUserCode(' k7m2-9qx4 ')).toBe('K7M2-9QX4');
  });
});
