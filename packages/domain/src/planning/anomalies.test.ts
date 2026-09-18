import { describe, expect, it } from 'vitest';
import { D } from '../money';
import { FxTable } from '../fx';
import {
  ANOMALY_NOTE,
  detectAnomalies,
  meanAbsoluteDeviation,
  medianAbsoluteDeviation,
  robustSpread,
  robustZScore,
  type Anomaly,
  type AnomalyInput,
  type AnomalyTransaction,
} from './anomalies';
import { deepFreeze, uid, usd, zar } from './testing';

const ACCOUNT = uid(60);
const GROCERIES = uid(61);
const TRAVEL = uid(62);

let seq = 0;
function tx(date: string, amount: string, counterparty: string, extra: Partial<AnomalyTransaction> = {}): AnomalyTransaction {
  seq += 1;
  return {
    id: uid(2000 + seq),
    accountId: ACCOUNT,
    date,
    amount: zar(amount),
    description: `${counterparty} card payment`,
    counterparty,
    categoryId: null,
    ...extra,
  };
}

function input(transactions: AnomalyTransaction[], overrides: Partial<AnomalyInput> = {}): AnomalyInput {
  return { asOf: '2026-03-10', homeCurrency: 'ZAR', fx: new FxTable(), transactions, ...overrides };
}

const d = (values: number[]) => values.map((v) => new D(v));

/** Names that stay distinct after normalisation (digits and single letters are dropped by normaliseLabel). */
const DISTINCT_NAMES = [
  'Sample Shop North',
  'Sample Shop South',
  'Sample Shop East',
  'Sample Shop West',
  'Sample Shop Central',
  'Sample Shop Harbour',
  'Sample Shop Valley',
  'Sample Shop Ridge',
];

/** 2026-01-05 plus n days, so fixtures can space rows well outside the duplicate window. */
function dayOfYear(offset: number): string {
  const ms = Date.parse('2026-01-05T00:00:00Z') + offset * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Words this module must never use about a statistical outlier. */
const FORBIDDEN = ['fraud', 'fraudulent', 'scam', 'theft', 'stolen', 'thief', 'criminal', 'crime', 'illegal', 'suspicious', 'suspect'];

function everyString(anomaly: Anomaly): string[] {
  return [
    anomaly.reason,
    anomaly.note,
    anomaly.exception.title,
    anomaly.exception.detail,
    anomaly.numbers.comparedTo,
    ...anomaly.links.map((l) => l.label),
  ];
}

describe('robust statistics', () => {
  it('computes the median absolute deviation and the z-score denominator by hand', () => {
    expect(medianAbsoluteDeviation(d([1, 2, 3, 4, 5])).toFixed()).toBe('1');
    expect(meanAbsoluteDeviation(d([1, 2, 3, 4, 5])).toFixed()).toBe('1.2');
    const spread = robustSpread(d([1, 2, 3, 4, 5]));
    expect(spread.median.toFixed()).toBe('3');
    expect(spread.mad.toFixed()).toBe('1');
    expect(spread.basis).toBe('mad');
    expect(spread.sampleSize).toBe(5);
    // z = 0.6745 × (10 − 3) / 1
    expect(robustZScore(new D(10), spread)!.toDecimalPlaces(6).toFixed()).toBe('4.7215');
  });

  it('falls back to the mean absolute deviation when the MAD is zero', () => {
    const spread = robustSpread(d([5, 5, 5, 5, 9]));
    expect(spread.mad.toFixed()).toBe('0');
    expect(spread.meanAbsoluteDeviation.toFixed()).toBe('0.8');
    expect(spread.basis).toBe('mean_abs_dev');
    // scale = 0.8 × 1.2533 = 1.00264; z = 4 / 1.00264
    expect(robustZScore(new D(9), spread)!.toDecimalPlaces(4).toFixed()).toBe('3.9895');
  });

  it('returns no z-score at all when the sample has no spread', () => {
    const spread = robustSpread(d([5, 5, 5]));
    expect(spread.basis).toBe('none');
    expect(robustZScore(new D(500), spread)).toBeNull();
  });
});

describe('category outliers', () => {
  // Distinct counterparties: normaliseLabel drops digits and single letters, so the names differ by a real word.
  const rows = [
    tx('2026-01-02', '-280', 'Sample Grocer North', { categoryId: GROCERIES, categoryName: 'Groceries' }),
    tx('2026-01-09', '-300', 'Sample Grocer South', { categoryId: GROCERIES, categoryName: 'Groceries' }),
    tx('2026-01-16', '-310', 'Sample Grocer East', { categoryId: GROCERIES, categoryName: 'Groceries' }),
    tx('2026-01-23', '-290', 'Sample Grocer West', { categoryId: GROCERIES, categoryName: 'Groceries' }),
    tx('2026-02-02', '-320', 'Sample Grocer Central', { categoryId: GROCERIES, categoryName: 'Groceries' }),
    tx('2026-02-09', '-300', 'Sample Grocer Harbour', { categoryId: GROCERIES, categoryName: 'Groceries' }),
    tx('2026-02-16', '-305', 'Sample Grocer Valley', { categoryId: GROCERIES, categoryName: 'Groceries' }),
    tx('2026-02-23', '-295', 'Sample Grocer Ridge', { categoryId: GROCERIES, categoryName: 'Groceries' }),
    tx('2026-03-02', '-4000', 'Sample Grocer Summit', { categoryId: GROCERIES, categoryName: 'Groceries' }),
  ];

  it('flags the one payment far outside the category, with the numbers used', () => {
    const result = detectAnomalies(input(deepFreeze([...rows])));
    const found = result.anomalies.filter((a) => a.kind === 'amount_outlier_category');
    expect(found).toHaveLength(1);
    const anomaly = found[0]!;
    expect(anomaly.transactionId).toBe(rows[8]!.id);
    expect(anomaly.severity).toBe('warning');
    expect(anomaly.amountInHome).toEqual(zar('4000'));
    expect(anomaly.numbers).toEqual({
      value: '4000',
      median: '300',
      // MAD of the nine values is 10, so the scale is 10 / 0.6745
      scale: '14.825797',
      // z = 0.6745 × 3700 / 10
      zScore: '249.565',
      sampleSize: 9,
      threshold: '3.5',
      currency: 'ZAR',
      comparedTo: 'Groceries (money out)',
      basis: 'mad',
    });
    expect(anomaly.reason).toContain('is unusual for Groceries (money out)');
    expect(anomaly.reason).toContain('about 13.3 times the usual 300 ZAR across 9 comparable transactions');
    expect(anomaly.note).toBe(ANOMALY_NOTE);
  });

  it('builds a stable exception with a dedupe key per transaction and kind', () => {
    const first = detectAnomalies(input([...rows]));
    const second = detectAnomalies(input([...rows]));
    const anomaly = first.anomalies.find((a) => a.kind === 'amount_outlier_category')!;
    expect(anomaly.exception.kind).toBe('unusual_transaction');
    expect(anomaly.exception.dedupeKey).toBe(`unusual_transaction:transaction:${rows[8]!.id}:amount_outlier_category`);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('needs enough history before an outlier means anything', () => {
    const short = detectAnomalies(input(rows.slice(0, 4).concat(rows[8]!)));
    expect(short.anomalies.filter((a) => a.kind === 'amount_outlier_category')).toEqual([]);
    expect(short.skipped.some((s) => s.group === 'Groceries (money out)' && s.reason.includes('6 are needed'))).toBe(true);
  });

  it('says nothing when every amount in the group is identical', () => {
    const flat = DISTINCT_NAMES.map((name, i) => tx(dayOfYear(i * 7), '-100', name, { categoryId: TRAVEL, categoryName: 'Travel' }));
    const result = detectAnomalies(input(flat));
    expect(result.anomalies).toEqual([]);
    expect(result.skipped.some((s) => s.reason.includes('no spread to compare against'))).toBe(true);
  });

  it('never flags a value below the configured floor', () => {
    const result = detectAnomalies(input([...rows], { options: { minimumAmount: zar('5000') } }));
    expect(result.anomalies.filter((a) => a.kind === 'amount_outlier_category')).toEqual([]);
  });

  it('learns from history outside the window but only reports inside it', () => {
    const result = detectAnomalies(input([...rows], { window: { from: '2026-03-01', to: '2026-03-10' } }));
    expect(result.assessedCount).toBe(1);
    expect(result.anomalies.map((a) => a.transactionId)).toEqual([rows[8]!.id]);
    const outside = detectAnomalies(input([...rows], { window: { from: '2026-01-01', to: '2026-02-28' } }));
    expect(outside.anomalies).toEqual([]);
  });
});

describe('counterparty outliers', () => {
  it('compares a counterparty with its own history', () => {
    const rows = [
      tx('2026-01-05', '-200', 'Sample Fuel Stop'),
      tx('2026-01-12', '-210', 'Sample Fuel Stop'),
      tx('2026-01-19', '-190', 'Sample Fuel Stop'),
      tx('2026-01-26', '-205', 'Sample Fuel Stop'),
      tx('2026-02-02', '-195', 'Sample Fuel Stop'),
      tx('2026-03-02', '-5000', 'Sample Fuel Stop'),
    ];
    const result = detectAnomalies(input(rows));
    const found = result.anomalies.filter((a) => a.kind === 'amount_outlier_counterparty');
    expect(found).toHaveLength(1);
    expect(found[0]!.transactionId).toBe(rows[5]!.id);
    expect(found[0]!.numbers.comparedTo).toBe('Sample Fuel Stop (money out)');
    expect(found[0]!.numbers.sampleSize).toBe(6);
  });

  it('keeps money in and money out in separate groups', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => tx(`2026-02-0${i + 1}`, `-${100 + i}`, 'Sample Mixed Co')),
      ...Array.from({ length: 5 }, (_, i) => tx(`2026-02-1${i + 1}`, `${5000 + i}`, 'Sample Mixed Co')),
    ];
    const result = detectAnomalies(input(rows));
    expect(result.anomalies).toEqual([]);
  });
});

describe('first-seen counterparty', () => {
  const history = [tx('2026-01-05', '-200', 'Sample Known Co'), tx('2026-02-05', '-200', 'Sample Known Co')];

  it('flags the first payment to a new counterparty at or above the threshold', () => {
    const first = tx('2026-03-05', '-1500', 'Sample Brand New Co');
    const result = detectAnomalies(input([...history, first], { options: { firstSeenThreshold: zar('1000') } }));
    const found = result.anomalies.filter((a) => a.kind === 'first_seen_counterparty');
    expect(found).toHaveLength(1);
    expect(found[0]!.transactionId).toBe(first.id);
    expect(found[0]!.severity).toBe('info');
    expect(found[0]!.numbers).toMatchObject({ value: '1500', threshold: '1000', basis: 'count', sampleSize: 1, median: null, zScore: null });
    expect(found[0]!.reason).toContain('is the first payment recorded for this counterparty');
  });

  it('stays quiet below the threshold, for a known counterparty, and when no threshold is set', () => {
    const small = detectAnomalies(input([...history, tx('2026-03-05', '-900', 'Sample Small New Co')], { options: { firstSeenThreshold: zar('1000') } }));
    expect(small.anomalies.filter((a) => a.kind === 'first_seen_counterparty')).toEqual([]);
    const known = detectAnomalies(input([...history, tx('2026-03-05', '-5000', 'Sample Known Co')], { options: { firstSeenThreshold: zar('1000') } }));
    expect(known.anomalies.filter((a) => a.kind === 'first_seen_counterparty')).toEqual([]);
    const off = detectAnomalies(input([...history, tx('2026-03-05', '-5000', 'Sample Brand New Co')]));
    expect(off.anomalies.filter((a) => a.kind === 'first_seen_counterparty')).toEqual([]);
  });
});

describe('duplicate-looking charges', () => {
  it('flags the later of two identical charges once, and links the earlier one', () => {
    const first = tx('2026-03-02', '-749.99', 'Sample Electronics');
    const second = tx('2026-03-03', '-749.99', 'Sample Electronics');
    const result = detectAnomalies(input([first, second]));
    const found = result.anomalies.filter((a) => a.kind === 'possible_duplicate_charge');
    expect(found).toHaveLength(1);
    expect(found[0]!.transactionId).toBe(second.id);
    expect(found[0]!.relatedTransactionIds).toEqual([first.id]);
    expect(found[0]!.numbers).toMatchObject({ value: '749.99', threshold: '3', basis: 'exact_match', currency: 'ZAR' });
    expect(found[0]!.reason).toContain('repeats an identical amount from 2026-03-02 (1 day(s) earlier)');
    expect(found[0]!.reason).toContain('It may be a genuine second payment or the same charge recorded twice.');
  });

  it('respects the window, the amount and the counterparty', () => {
    const base = tx('2026-03-01', '-749.99', 'Sample Electronics');
    expect(detectAnomalies(input([base, tx('2026-03-05', '-749.99', 'Sample Electronics')])).anomalies).toEqual([]);
    expect(detectAnomalies(input([base, tx('2026-03-02', '-750', 'Sample Electronics')])).anomalies).toEqual([]);
    expect(detectAnomalies(input([base, tx('2026-03-02', '-749.99', 'Sample Other Shop')])).anomalies).toEqual([]);
    const widened = detectAnomalies(input([base, tx('2026-03-05', '-749.99', 'Sample Electronics')], { options: { duplicateWindowDays: 7 } }));
    expect(widened.anomalies).toHaveLength(1);
  });

  it('flags only the later charge when three identical ones arrive on the same day', () => {
    const rows = [tx('2026-03-02', '-100', 'Sample Trio'), tx('2026-03-02', '-100', 'Sample Trio'), tx('2026-03-02', '-100', 'Sample Trio')];
    const found = detectAnomalies(input(rows)).anomalies.filter((a) => a.kind === 'possible_duplicate_charge');
    expect(found.map((a) => a.transactionId)).toEqual([rows[1]!.id, rows[2]!.id]);
  });
});

describe('foreign-currency outliers', () => {
  const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18', asOf: '2026-02-28', source: 'test' }]);
  const foreign = (date: string, amount: string, counterparty: string) => ({ ...tx(date, '-1', counterparty), amount: usd(amount), date });

  it('compares a currency with its own history', () => {
    const rows = [
      foreign('2026-03-01', '-20', 'Sample Vendor A'),
      foreign('2026-03-02', '-22', 'Sample Vendor B'),
      foreign('2026-03-03', '-21', 'Sample Vendor C'),
      foreign('2026-03-04', '-19', 'Sample Vendor D'),
      foreign('2026-03-05', '-20', 'Sample Vendor E'),
      foreign('2026-03-06', '-900', 'Sample Vendor F'),
    ];
    const result = detectAnomalies(input(rows, { fx }));
    const found = result.anomalies.filter((a) => a.kind === 'foreign_currency_outlier');
    expect(found).toHaveLength(1);
    expect(found[0]!.amount).toEqual(usd('-900'));
    expect(found[0]!.amountInHome).toEqual(zar('16200'));
    expect(found[0]!.numbers).toMatchObject({ value: '16200', median: '369', sampleSize: 6, currency: 'ZAR', comparedTo: 'USD spending (money out)', basis: 'mad' });
    // scale = 18 / 0.6745, z = 0.6745 × 15831 / 18
    expect(found[0]!.numbers.zScore).toBe('593.22275');
  });

  it('flags the first transaction ever recorded in a currency, above the threshold', () => {
    const rows = [tx('2026-01-05', '-200', 'Sample Local Shop'), foreign('2026-03-05', '-500', 'Sample Overseas Shop')];
    const result = detectAnomalies(input(rows, { fx, options: { firstSeenThreshold: zar('1000') } }));
    const found = result.anomalies.filter((a) => a.kind === 'foreign_currency_outlier');
    expect(found).toHaveLength(1);
    expect(found[0]!.reason).toBe('500 USD (9000 ZAR) is the first transaction recorded in USD.');
    expect(found[0]!.numbers.basis).toBe('count');
  });

  it('reports a transaction it cannot convert as unassessed rather than normal', () => {
    const rows = [tx('2026-01-05', '-200', 'Sample Local Shop'), { ...tx('2026-03-05', '-1', 'Sample Overseas Shop'), amount: { amount: '-400', currency: 'GBP' } }];
    const result = detectAnomalies(input(rows, { fx, options: { firstSeenThreshold: zar('1') } }));
    expect(result.anomalies.filter((a) => a.kind === 'foreign_currency_outlier')).toEqual([]);
    expect(result.skipped.some((s) => s.group === 'currency GBP' && s.reason.includes('GBP→ZAR'))).toBe(true);
  });
});

describe('wording', () => {
  const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18', asOf: '2026-02-28', source: 'test' }]);
  const rows: AnomalyTransaction[] = [
    ...Array.from({ length: 8 }, (_, i) => tx(`2026-02-0${i + 1}`, `-${300 + i}`, `Sample Grocer ${i}`, { categoryId: GROCERIES, categoryName: 'Groceries' })),
    tx('2026-03-02', '-9000', 'Sample Grocer Big', { categoryId: GROCERIES, categoryName: 'Groceries' }),
    tx('2026-03-03', '-1200', 'Sample Brand New Co'),
    tx('2026-03-04', '-499', 'Sample Repeat Shop'),
    tx('2026-03-05', '-499', 'Sample Repeat Shop'),
    { ...tx('2026-03-06', '-1', 'Sample Overseas Shop'), amount: usd('-300') },
  ];

  it('produces every kind of finding for this fixture', () => {
    const result = detectAnomalies(input(rows, { fx, options: { firstSeenThreshold: zar('1000') } }));
    expect(new Set(result.anomalies.map((a) => a.kind))).toEqual(
      new Set(['amount_outlier_category', 'first_seen_counterparty', 'possible_duplicate_charge', 'foreign_currency_outlier']),
    );
  });

  it('never uses an accusatory word about a statistical outlier', () => {
    const result = detectAnomalies(input(rows, { fx, options: { firstSeenThreshold: zar('1000') } }));
    expect(result.anomalies.length).toBeGreaterThan(0);
    const text = [...result.anomalies.flatMap(everyString), ...result.skipped.map((s) => s.reason), ANOMALY_NOTE].join(' ').toLowerCase();
    for (const word of FORBIDDEN) expect(text).not.toContain(word);
  });

  it('says "unusual" and "worth a look" instead', () => {
    const result = detectAnomalies(input(rows, { fx, options: { firstSeenThreshold: zar('1000') } }));
    expect(ANOMALY_NOTE.toLowerCase()).toContain('unusual');
    expect(ANOMALY_NOTE.toLowerCase()).toContain('worth a look');
    expect(result.anomalies.every((a) => a.note === ANOMALY_NOTE)).toBe(true);
    expect(result.anomalies.every((a) => a.exception.detail.endsWith(ANOMALY_NOTE))).toBe(true);
    expect(result.anomalies.every((a) => a.severity === 'info' || a.severity === 'warning')).toBe(true);
  });
});

describe('filtering', () => {
  it('ignores reversed, superseded and zero-amount rows', () => {
    const rows = [
      ...DISTINCT_NAMES.map((name, i) => tx(dayOfYear(i * 7), `-${100 + i}`, name, { categoryId: GROCERIES, categoryName: 'Groceries' })),
      tx('2026-03-02', '-9000', 'Sample Big Shop', { categoryId: GROCERIES, categoryName: 'Groceries', status: 'reversed' }),
      tx('2026-03-03', '-9000', 'Sample Big Shop', { categoryId: GROCERIES, categoryName: 'Groceries', status: 'superseded' }),
      tx('2026-03-04', '0', 'Sample Zero Shop', { categoryId: GROCERIES, categoryName: 'Groceries' }),
    ];
    const result = detectAnomalies(input(rows));
    expect(result.anomalies).toEqual([]);
    expect(result.assessedCount).toBe(8);
  });
});
