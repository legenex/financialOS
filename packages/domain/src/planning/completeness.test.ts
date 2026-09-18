import { Explanation } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { dataCompleteness, NOT_A_HEALTH_SCORE, type CompletenessAccount, type DataCompletenessInput } from './completeness';
import { PlanningError } from './shared';
import { deepFreeze, uid, zar } from './testing';

const NOW = '2026-03-10T08:00:00Z';

function account(overrides: Partial<CompletenessAccount> & { id: string; name: string }): CompletenessAccount {
  return { status: 'active', balance: zar('1000'), balanceAsOf: '2026-03-10T06:00:00Z', ...overrides };
}

const FRESH = [
  account({ id: uid(400), name: 'Everyday account' }),
  account({ id: uid(401), name: 'Savings account' }),
  account({ id: uid(402), name: 'Card account' }),
];

function input(overrides: Partial<DataCompletenessInput> = {}): DataCompletenessInput {
  return {
    now: NOW,
    asOf: '2026-03-10',
    accounts: [...FRESH, account({ id: uid(403), name: 'Brokerage account', balance: null, balanceAsOf: null })],
    coverageMonths: 12,
    transactions: { total: 100, classified: 90 },
    periods: { total: 4, reconciled: 2 },
    ...overrides,
  };
}

describe('dataCompleteness', () => {
  it('computes the indicator from four equally weighted components', () => {
    const result = dataCompleteness(deepFreeze(input()));
    expect(result.components.map((c) => [c.id, c.value, c.weight])).toEqual([
      ['fresh_balances', '0.75', '0.25'],
      ['coverage_months', '0.5', '0.25'],
      ['classified_share', '0.9', '0.25'],
      ['reconciled_share', '0.5', '0.25'],
    ]);
    // (0.75 + 0.5 + 0.9 + 0.5) / 4
    expect(result.score).toBe('0.6625');
    expect(result.percent).toBe('66.25');
    expect(result.status).toBe('provisional');
  });

  it('exposes the whole formula, with no hidden weighting', () => {
    const result = dataCompleteness(input());
    expect(result.formula).toBe('completeness = 0.25 × fresh_balances + 0.25 × coverage_months + 0.25 × classified_share + 0.25 × reconciled_share');
    expect(result.weighting).toBe('every measurable component carries the same weight, 0.25 (1 / 4)');
    expect(result.okThreshold).toBe('0.8');
    expect(result.components.map((c) => c.formula)).toEqual([
      '3 of 4 active account(s) have a known balance no older than 48 h',
      '12 of 24 target months of transaction history (capped at 1)',
      '90 of 100 transaction(s) are classified',
      '2 of 4 account period(s) are reconciled',
    ]);
    expect(result.components.map((c) => `${c.numerator}/${c.denominator}`)).toEqual(['3/4', '12/24', '90/100', '2/4']);
  });

  it('says plainly that it is not a financial health score', () => {
    const result = dataCompleteness(input());
    expect(result.disclaimer).toBe(NOT_A_HEALTH_SCORE);
    expect(result.disclaimer).toContain('not a financial health score');
    expect(result.explanation.assumptions[0]).toBe(NOT_A_HEALTH_SCORE);
  });

  it('lists the missing data behind the number', () => {
    const result = dataCompleteness(input());
    expect(result.limitations).toEqual([
      'No fresh balance for: Brokerage account (balance unknown).',
      'Transaction history covers 12 of the 24 months this indicator asks for.',
      '10 transaction(s) are unclassified, so category figures are incomplete.',
      '2 account period(s) are not reconciled, so the balances they cover are not yet proven.',
    ]);
    expect(() => Explanation.parse(result.explanation)).not.toThrow();
    expect(result.explanation.missing).toEqual(result.limitations);
    expect(result.explanation.formula).toContain(result.formula);
  });

  it('reaches ok only when everything it measures is present', () => {
    const complete = dataCompleteness(
      input({ accounts: FRESH, coverageMonths: 24, transactions: { total: 100, classified: 100 }, periods: { total: 4, reconciled: 4 } }),
    );
    expect(complete.score).toBe('1');
    expect(complete.percent).toBe('100');
    expect(complete.status).toBe('ok');
    expect(complete.limitations).toEqual([]);
  });

  it('caps coverage at the target rather than rewarding extra history', () => {
    const long = dataCompleteness(input({ coverageMonths: 60 }));
    expect(long.components[1]!.value).toBe('1');
    expect(long.limitations.some((l) => l.includes('months this indicator asks for'))).toBe(false);
  });

  it('honours a configured threshold and staleness limit', () => {
    // 0.6625 clears a 0.6 threshold with all four components measurable, but not the 0.8 default.
    expect(dataCompleteness(input()).status).toBe('provisional');
    expect(dataCompleteness(input({ okThreshold: '0.6' })).status).toBe('ok');
    expect(dataCompleteness(input({ okThreshold: '0.7' })).status).toBe('provisional');
    const perfectButLenient = dataCompleteness(
      input({ accounts: FRESH, coverageMonths: 24, transactions: { total: 100, classified: 100 }, periods: { total: 4, reconciled: 4 }, okThreshold: '0.6' }),
    );
    expect(perfectButLenient.status).toBe('ok');
    const strict = dataCompleteness(input({ accounts: FRESH, staleAfterHours: 1 }));
    expect(strict.components[0]!.value).toBe('0');
    expect(strict.limitations[0]).toContain('2 h old');
  });
});

describe('unknown components', () => {
  it('drops a component it cannot measure and re-weights the rest equally', () => {
    const result = dataCompleteness(input({ periods: null }));
    expect(result.components.map((c) => [c.id, c.known, c.weight])).toEqual([
      ['fresh_balances', true, '0.333333'],
      ['coverage_months', true, '0.333333'],
      ['classified_share', true, '0.333333'],
      ['reconciled_share', false, '0'],
    ]);
    // (0.75 + 0.5 + 0.9) / 3
    expect(result.score).toBe('0.716667');
    expect(result.status).toBe('provisional');
    expect(result.formula).toBe('completeness = 0.333333 × fresh_balances + 0.333333 × coverage_months + 0.333333 × classified_share');
    expect(result.limitations).toContain('Account-period counts are unknown, so the reconciled share is left out of the formula.');
    expect(result.limitations).toContain('1 of 4 components could not be measured; the rest carry equal weights of 0.333333.');
  });

  it('treats an empty set of records as unmeasurable rather than zero', () => {
    const result = dataCompleteness(input({ accounts: [], coverageMonths: null, transactions: { total: 0, classified: 0 }, periods: { total: 0, reconciled: 0 } }));
    expect(result.score).toBeNull();
    expect(result.percent).toBeNull();
    expect(result.status).toBe('insufficient_data');
    expect(result.components.every((c) => !c.known && c.value === null)).toBe(true);
    expect(result.limitations).toContain('No active account is recorded, so balance freshness is left out of the formula.');
    expect(result.limitations).toContain('No transactions are recorded, so the classified share is left out of the formula.');
    expect(result.explanation.summary).toBe('Too little is measurable to give a completeness indicator');
  });

  it('withholds the aggregate when only one component is measurable', () => {
    const result = dataCompleteness(input({ accounts: [], coverageMonths: null, transactions: null, periods: { total: 4, reconciled: 4 } }));
    expect(result.status).toBe('insufficient_data');
    expect(result.score).toBeNull();
    expect(result.components.find((c) => c.id === 'reconciled_share')).toMatchObject({ known: true, value: '1', weight: '1' });
  });

  it('counts a stale, undated or unknown balance as not fresh, and ignores closed accounts', () => {
    const result = dataCompleteness(
      input({
        accounts: [
          account({ id: uid(410), name: 'Fresh account' }),
          account({ id: uid(411), name: 'Stale account', balanceAsOf: '2026-03-01T06:00:00Z' }),
          account({ id: uid(412), name: 'Undated account', balanceAsOf: null }),
          account({ id: uid(413), name: 'Unknown account', balance: null }),
          account({ id: uid(414), name: 'Closed account', status: 'closed', balance: null, balanceAsOf: null }),
        ],
      }),
    );
    expect(result.components[0]!.value).toBe('0.25');
    expect(result.components[0]!.formula).toBe('1 of 4 active account(s) have a known balance no older than 48 h');
    expect(result.limitations[0]).toBe('No fresh balance for: Stale account (218 h old), Undated account (balance age unknown), Unknown account (balance unknown).');
  });
});

describe('guards', () => {
  it('refuses a coverage target that is not positive', () => {
    expect(() => dataCompleteness(input({ coverageTargetMonths: 0 }))).toThrow(PlanningError);
    expect(() => dataCompleteness(input({ coverageTargetMonths: -3 }))).toThrow(PlanningError);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(dataCompleteness(input()))).toBe(JSON.stringify(dataCompleteness(input())));
  });

  it('never lets the weights add up to anything but one across measurable components', () => {
    for (const overrides of [{}, { periods: null }, { transactions: null, periods: null }]) {
      const result = dataCompleteness(input(overrides));
      const known = result.components.filter((c) => c.known);
      if (known.length < 2) continue;
      const total = known.reduce((acc, c) => acc + Number(c.weight), 0);
      expect(Math.abs(total - 1)).toBeLessThan(0.00001);
    }
  });
});
