import { RecurringItem } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import {
  CADENCE_BANDS,
  cadenceBand,
  detectRecurring,
  inferCadence,
  nextExpectedDate,
  recurringSuggestions,
  suggestionAmount,
  type RecurringDetectionInput,
  type RecurringTransaction,
} from './recurring';
import { PlanningError } from './shared';
import { deepFreeze, OWNER_ID, uid, usd, zar } from './testing';

const ACCOUNT = uid(50);
const OTHER_ACCOUNT = uid(51);

let seq = 0;
function tx(date: string, amount: string, counterparty: string, extra: Partial<RecurringTransaction> = {}): RecurringTransaction {
  seq += 1;
  return { id: uid(1000 + seq), accountId: ACCOUNT, date, amount: zar(amount), description: `${counterparty} payment`, counterparty, ...extra };
}

function input(transactions: RecurringTransaction[], overrides: Partial<RecurringDetectionInput> = {}): RecurringDetectionInput {
  return { asOf: '2026-03-10', entityId: OWNER_ID, transactions, ...overrides };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('inferCadence', () => {
  it('maps interval medians onto the documented bands', () => {
    expect(inferCadence([7, 7, 7]).cadence).toBe('weekly');
    expect(inferCadence([5]).cadence).toBe('weekly');
    expect(inferCadence([9]).cadence).toBe('weekly');
    expect(inferCadence([14, 14]).cadence).toBe('fortnightly');
    expect(inferCadence([12]).cadence).toBe('fortnightly');
    expect(inferCadence([17]).cadence).toBe('fortnightly');
    expect(inferCadence([31, 28]).cadence).toBe('monthly');
    expect(inferCadence([25]).cadence).toBe('monthly');
    expect(inferCadence([35]).cadence).toBe('monthly');
    expect(inferCadence([91, 92]).cadence).toBe('quarterly');
    expect(inferCadence([365]).cadence).toBe('annually');
    expect(inferCadence([330]).cadence).toBe('annually');
    expect(inferCadence([400]).cadence).toBe('annually');
  });

  it('reports the boundaries outside every band as irregular, and no interval as unknown', () => {
    expect(inferCadence([4]).cadence).toBe('irregular');
    expect(inferCadence([10, 10, 10]).cadence).toBe('irregular');
    expect(inferCadence([20, 22, 21]).cadence).toBe('irregular');
    expect(inferCadence([200]).cadence).toBe('irregular');
    expect(inferCadence([]).cadence).toBe('unknown');
    expect(inferCadence([]).regularity.toFixed()).toBe('0');
  });

  it('measures regularity as the share of intervals inside the matched band', () => {
    const result = inferCadence([30, 30, 10, 60, 55]);
    expect(result.cadence).toBe('monthly');
    expect(result.medianIntervalDays.toFixed()).toBe('30');
    expect(result.regularity.toFixed()).toBe('0.4');
  });

  it('exposes the bands and their grace periods', () => {
    expect(CADENCE_BANDS.map((b) => b.cadence)).toEqual(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually']);
    expect(cadenceBand('monthly')?.graceDays).toBe(6);
    expect(cadenceBand('irregular')).toBeNull();
  });
});

describe('nextExpectedDate', () => {
  it('steps by the cadence and clamps to the end of the month', () => {
    expect(nextExpectedDate('2026-03-05', 'weekly', null)).toBe('2026-03-12');
    expect(nextExpectedDate('2026-03-05', 'fortnightly', null)).toBe('2026-03-19');
    expect(nextExpectedDate('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
    expect(nextExpectedDate('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
    expect(nextExpectedDate('2026-01-15', 'quarterly', 15)).toBe('2026-04-15');
    expect(nextExpectedDate('2026-03-01', 'annually', 1)).toBe('2027-03-01');
    expect(nextExpectedDate('2026-03-01', 'irregular', null)).toBeNull();
  });
});

describe('detectRecurring: monthly subscription', () => {
  const transactions = [
    tx('2026-01-05', '-199', 'Sample Streaming Co'),
    tx('2026-02-05', '-199', 'Sample Streaming Co'),
    tx('2026-03-05', '-199', 'Sample Streaming Co'),
  ];

  it('suggests a stable monthly series with an exact next date and never auto-confirms it', () => {
    const result = detectRecurring(input(deepFreeze([...transactions])));
    expect(result.suggestions).toHaveLength(1);
    const { item, ...meta } = result.suggestions[0]!;
    expect(() => RecurringItem.parse(item)).not.toThrow();
    expect(item.id).toMatch(UUID);
    expect(item.status).toBe('suggested');
    expect(item.detected).toBe(true);
    expect(item.confirmed).toBe(false);
    expect(item.cadence).toBe('monthly');
    expect(item.direction).toBe('out');
    expect(item.kind).toBe('subscription');
    expect(item.amount).toEqual({ amount: '199', currency: 'ZAR' });
    expect(item.amountIsEstimate).toBe(false);
    expect(item.dayOfMonth).toBe(5);
    expect(item.nextDueOn).toBe('2026-04-05');
    expect(item.lastSeenOn).toBe('2026-03-05');
    expect(item.accountId).toBe(ACCOUNT);
    expect(item.entityId).toBe(OWNER_ID);
    expect(item.links).toHaveLength(3);
    expect(meta.confidence).toBe('high');
    expect(meta.occurrenceCount).toBe(3);
    expect(meta.firstSeenOn).toBe('2026-01-05');
    expect(meta.medianIntervalDays).toBe('29.5');
    expect(meta.regularity).toBe('1');
    expect(meta.amountSpread).toBe('0');
    expect(meta.reason).toContain('3 occurrences about 30 days apart');
    expect(suggestionAmount(result.suggestions[0]!)).toEqual(zar('199'));
  });

  it('is deterministic and does not mutate its input', () => {
    const frozen = deepFreeze([...transactions]);
    expect(JSON.stringify(detectRecurring(input(frozen)))).toBe(JSON.stringify(detectRecurring(input(frozen))));
  });

  it('raises no missed occurrence while the next date is still in the future', () => {
    expect(detectRecurring(input([...transactions])).missed).toEqual([]);
  });
});

describe('detectRecurring: occurrence thresholds', () => {
  it('needs three occurrences for a monthly series', () => {
    const two = detectRecurring(input([tx('2026-02-05', '-199', 'Sample Gym'), tx('2026-03-05', '-199', 'Sample Gym')]));
    expect(two.suggestions).toEqual([]);
    expect(two.series[0]!.suggested).toBe(false);
    expect(two.series[0]!.reason).toBe('2 occurrence(s); 3 are required for a monthly series');
  });

  it('needs only two occurrences for an annual series', () => {
    const result = detectRecurring(input([tx('2025-03-01', '-4800', 'Example Insurance Ltd'), tx('2026-03-01', '-4800', 'Example Insurance Ltd')]));
    expect(result.suggestions).toHaveLength(1);
    const item = result.suggestions[0]!.item;
    expect(item.cadence).toBe('annually');
    expect(item.kind).toBe('annual_bill');
    expect(item.nextDueOn).toBe('2027-03-01');
    expect(result.suggestions[0]!.confidence).toBe('high');
  });

  it('refuses a configuration that would accept a single occurrence', () => {
    expect(() => detectRecurring(input([], { options: { minOccurrences: 1 } }))).toThrow(PlanningError);
  });

  it('does not suggest an irregular series, and says why', () => {
    const result = detectRecurring(
      input([tx('2026-01-01', '-500', 'Sample Hardware'), tx('2026-01-21', '-500', 'Sample Hardware'), tx('2026-02-12', '-500', 'Sample Hardware'), tx('2026-03-05', '-500', 'Sample Hardware')]),
    );
    expect(result.suggestions).toEqual([]);
    expect(result.series[0]!.cadence).toBe('irregular');
    expect(result.series[0]!.reason).toMatch(/^Intervals are irregular/);
  });

  it('does not suggest a series whose intervals are mostly outside the band', () => {
    const result = detectRecurring(
      input([
        tx('2026-01-01', '-500', 'Sample Utility'),
        tx('2026-01-31', '-500', 'Sample Utility'),
        tx('2026-03-02', '-500', 'Sample Utility'),
        tx('2026-03-12', '-500', 'Sample Utility'),
        tx('2026-05-11', '-500', 'Sample Utility'),
        tx('2026-07-05', '-500', 'Sample Utility'),
      ], { asOf: '2026-07-31' }),
    );
    expect(result.suggestions).toEqual([]);
    expect(result.series[0]!.reason).toBe('Only 40% of the intervals match a monthly cadence');
  });
});

describe('detectRecurring: amounts', () => {
  it('flags a varying amount as an estimate and calls the series a bill', () => {
    const result = detectRecurring(
      input([
        tx('2026-02-02', '-120', 'Sample Water Board'),
        tx('2026-02-09', '-125', 'Sample Water Board'),
        tx('2026-02-16', '-118', 'Sample Water Board'),
        tx('2026-02-23', '-130', 'Sample Water Board'),
        tx('2026-03-02', '-122', 'Sample Water Board'),
      ]),
    );
    const suggestion = result.suggestions[0]!;
    expect(suggestion.item.cadence).toBe('weekly');
    expect(suggestion.item.kind).toBe('bill');
    expect(suggestion.item.amountIsEstimate).toBe(true);
    expect(suggestion.item.dayOfMonth).toBeNull();
    // median of 118, 120, 122, 125, 130
    expect(suggestion.medianAmount).toEqual(zar('122'));
    // (130 − 118) / 122
    expect(suggestion.amountSpread).toBe('0.098361');
    expect(suggestion.item.nextDueOn).toBe('2026-03-09');
  });

  it('treats several charges on one date as a single occurrence and adds them up', () => {
    const result = detectRecurring(
      input([
        tx('2026-01-08', '-50', 'Sample Parking'),
        tx('2026-01-08', '-50', 'Sample Parking'),
        tx('2026-02-08', '-100', 'Sample Parking'),
        tx('2026-03-08', '-100', 'Sample Parking'),
      ]),
    );
    const series = result.series[0]!;
    expect(series.occurrences).toHaveLength(3);
    expect(series.occurrences[0]!.amount).toEqual(zar('100'));
    expect(series.occurrences[0]!.transactionIds).toHaveLength(2);
    expect(result.suggestions[0]!.item.amount).toEqual({ amount: '100', currency: 'ZAR' });
  });

  it('keeps inflows separate from outflows and calls an inflow income', () => {
    const result = detectRecurring(
      input([
        tx('2026-01-09', '48000', 'Sample Consulting LLC'),
        tx('2026-02-09', '48000', 'Sample Consulting LLC'),
        tx('2026-03-09', '48000', 'Sample Consulting LLC'),
        tx('2026-01-15', '-300', 'Sample Consulting LLC'),
      ]),
    );
    const income = result.suggestions.find((s) => s.item.direction === 'in')!;
    expect(income.item.kind).toBe('income');
    expect(result.series.filter((s) => s.direction === 'out')[0]!.suggested).toBe(false);
  });

  it('never mixes currencies into one series', () => {
    const result = detectRecurring(
      input([
        { ...tx('2026-01-05', '-199', 'Sample Cloud Inc'), amount: usd('-19') },
        { ...tx('2026-02-05', '-199', 'Sample Cloud Inc'), amount: usd('-19') },
        { ...tx('2026-03-05', '-199', 'Sample Cloud Inc'), amount: usd('-19') },
        tx('2026-01-06', '-199', 'Sample Cloud Inc'),
      ]),
    );
    expect(result.series.map((s) => s.currency).sort()).toEqual(['USD', 'ZAR']);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.item.amount).toEqual({ amount: '19', currency: 'USD' });
  });
});

describe('detectRecurring: price changes', () => {
  const rows = [
    tx('2025-12-12', '-100', 'Sample Software Co'),
    tx('2026-01-12', '-100', 'Sample Software Co'),
    tx('2026-02-12', '-100', 'Sample Software Co'),
    tx('2026-03-09', '-120', 'Sample Software Co'),
  ];

  it('compares the latest occurrence with the median of the earlier ones', () => {
    const result = detectRecurring(input(rows));
    expect(result.priceChanges).toHaveLength(1);
    const change = result.priceChanges[0]!;
    expect(change.previousTypical).toEqual(zar('100'));
    expect(change.latest).toEqual(zar('120'));
    expect(change.changeShare).toBe('0.2');
    expect(change.direction).toBe('increase');
    expect(change.changedOn).toBe('2026-03-09');
    expect(change.detail).toContain('changed from about 100 to 120 ZAR on 2026-03-09 (20%)');
    expect(change.links).toHaveLength(1);
  });

  it('uses the new price for the suggestion and marks it an estimate', () => {
    const suggestion = detectRecurring(input(rows)).suggestions[0]!;
    expect(suggestion.item.amount).toEqual({ amount: '120', currency: 'ZAR' });
    expect(suggestion.item.amountIsEstimate).toBe(true);
  });

  it('detects a decrease and respects the threshold', () => {
    const down = detectRecurring(input([tx('2026-01-12', '-100', 'Sample Vpn'), tx('2026-02-12', '-100', 'Sample Vpn'), tx('2026-03-09', '-80', 'Sample Vpn')]));
    expect(down.priceChanges[0]!.direction).toBe('decrease');
    expect(down.priceChanges[0]!.changeShare).toBe('-0.2');

    const small = detectRecurring(input([tx('2026-01-12', '-100', 'Sample Email'), tx('2026-02-12', '-100', 'Sample Email'), tx('2026-03-09', '-104', 'Sample Email')]));
    expect(small.priceChanges).toEqual([]);
    const tightened = detectRecurring(
      input([tx('2026-01-12', '-100', 'Sample Email Two'), tx('2026-02-12', '-100', 'Sample Email Two'), tx('2026-03-09', '-104', 'Sample Email Two')], {
        options: { priceChangeThreshold: '0.01' },
      }),
    );
    expect(tightened.priceChanges).toHaveLength(1);
  });

  it('needs three occurrences before a price change means anything', () => {
    expect(detectRecurring(input([tx('2026-02-12', '-100', 'Sample Once'), tx('2026-03-09', '-500', 'Sample Once')])).priceChanges).toEqual([]);
  });
});

describe('detectRecurring: missed occurrences', () => {
  it('reports an expected occurrence that never arrived, with the grace period used', () => {
    const result = detectRecurring(input([tx('2025-11-10', '-899', 'Sample Fibre'), tx('2025-12-10', '-899', 'Sample Fibre'), tx('2026-01-10', '-899', 'Sample Fibre')]));
    expect(result.missed).toHaveLength(1);
    expect(result.missed[0]).toMatchObject({
      name: 'Sample Fibre',
      expectedOn: '2026-02-10',
      daysOverdue: 28,
      graceDays: 6,
      lastSeenOn: '2026-01-10',
      typicalAmount: zar('899'),
    });
    expect(result.missed[0]!.detail).toBe('Sample Fibre was expected on 2026-02-10 and has not been seen; the last one was 2026-01-10.');
  });

  it('stays quiet inside the grace period', () => {
    const result = detectRecurring(
      input([tx('2025-12-08', '-899', 'Sample Fibre Two'), tx('2026-01-08', '-899', 'Sample Fibre Two'), tx('2026-02-08', '-899', 'Sample Fibre Two')], { asOf: '2026-03-13' }),
    );
    // expected 2026-03-08, five days late against a six-day grace
    expect(result.missed).toEqual([]);
    expect(detectRecurring(
      input([tx('2025-12-08', '-899', 'Sample Fibre Three'), tx('2026-01-08', '-899', 'Sample Fibre Three'), tx('2026-02-08', '-899', 'Sample Fibre Three')], { asOf: '2026-03-15' }),
    ).missed).toHaveLength(1);
  });

  it('never reports a missed occurrence for a series it would not suggest', () => {
    const result = detectRecurring(input([tx('2025-11-10', '-899', 'Sample Odd'), tx('2025-12-10', '-899', 'Sample Odd')]));
    expect(result.missed).toEqual([]);
  });
});

describe('detectRecurring: filtering and grouping', () => {
  it('ignores reversed, superseded, zero and future rows, and rows with no usable label', () => {
    const result = detectRecurring(
      input([
        tx('2026-01-05', '-199', 'Sample Club'),
        tx('2026-02-05', '-199', 'Sample Club'),
        tx('2026-03-05', '-199', 'Sample Club'),
        tx('2026-03-06', '-199', 'Sample Club', { status: 'reversed' }),
        tx('2026-03-07', '-199', 'Sample Club', { status: 'superseded' }),
        tx('2026-03-08', '0', 'Sample Club'),
        tx('2026-04-05', '-199', 'Sample Club'),
        { ...tx('2026-02-01', '-40', 'x'), counterparty: '1234 ***', description: '1234 ***' },
      ]),
    );
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.occurrences.map((o) => o.date)).toEqual(['2026-01-05', '2026-02-05', '2026-03-05']);
  });

  it('leaves the account null when a series spans two accounts', () => {
    const result = detectRecurring(
      input([
        tx('2026-01-05', '-199', 'Sample Split'),
        tx('2026-02-05', '-199', 'Sample Split', { accountId: OTHER_ACCOUNT }),
        tx('2026-03-05', '-199', 'Sample Split'),
      ]),
    );
    expect(result.suggestions[0]!.item.accountId).toBeNull();
  });

  it('does not suggest a series the owner already tracks', () => {
    const rows = [tx('2026-01-05', '-199', 'Sample Tracked'), tx('2026-02-05', '-199', 'Sample Tracked'), tx('2026-03-05', '-199', 'Sample Tracked')];
    const result = detectRecurring(input(rows, { existing: [{ id: uid(9), name: 'Sample Tracked', counterparty: 'Sample Tracked', direction: 'out', currency: 'ZAR' }] }));
    expect(result.suggestions).toEqual([]);
    expect(result.alreadyTracked).toEqual([{ seriesKey: 'sample tracked|out|ZAR', existingId: uid(9), name: 'Sample Tracked' }]);
  });

  it('returns the suggested items through the convenience wrapper, sorted by name', () => {
    const items = recurringSuggestions(
      input([
        tx('2026-01-05', '-10', 'Zebra Sample Ltd'),
        tx('2026-02-05', '-10', 'Zebra Sample Ltd'),
        tx('2026-03-05', '-10', 'Zebra Sample Ltd'),
        tx('2026-01-06', '-20', 'Alpha Sample Ltd'),
        tx('2026-02-06', '-20', 'Alpha Sample Ltd'),
        tx('2026-03-06', '-20', 'Alpha Sample Ltd'),
      ]),
    );
    expect(items.map((i) => i.name)).toEqual(['Alpha Sample Ltd', 'Zebra Sample Ltd']);
    expect(items.every((i) => i.status === 'suggested' && !i.confirmed)).toBe(true);
  });

  it('confidence falls as regularity and stability fall', () => {
    const wobbly = detectRecurring(
      input([tx('2026-01-02', '-100', 'Sample Wobble'), tx('2026-01-28', '-160', 'Sample Wobble'), tx('2026-03-04', '-90', 'Sample Wobble')]),
    );
    expect(wobbly.suggestions[0]!.confidence).toBe('medium');
  });
});
