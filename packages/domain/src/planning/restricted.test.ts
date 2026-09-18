import { SaleScheduleResult, type SaleScheduleRequest } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { planRestrictedSale, volumeCapFraction, INDICATIVE_CAVEAT, type RestrictionRecord } from './restricted';
import { runway } from './runway';
import { computeSafeToSpend } from './safeToSpend';
import { account, ENTITIES, NOW, OWNER_ID, TODAY, uid, usd, zar } from './testing';

const HOLDING = uid(1);
const INSTRUMENT = uid(2);

const request = (overrides: Partial<SaleScheduleRequest> = {}): SaleScheduleRequest => ({
  accountId: HOLDING,
  quantity: '100000',
  volumeSource: 'actual',
  averageDailyVolume: '25000',
  hypotheticalPrice: '1.25',
  priceCurrency: 'USD',
  tradingDaysPerWeek: 5,
  ...overrides,
});

const cap = (overrides: Partial<RestrictionRecord> = {}): RestrictionRecord => ({
  id: uid(10),
  accountId: HOLDING,
  instrumentId: INSTRUMENT,
  kind: 'volume_cap',
  status: 'verified',
  terms: { maxDailyVolumeFraction: '0.1' },
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  ...overrides,
});

const asOf = '2026-03-10';

describe('volumeCapFraction', () => {
  it('reads decimal-string fractions or percentages only', () => {
    expect(volumeCapFraction({ terms: { maxDailyVolumeFraction: '0.1' } })?.toFixed()).toBe('0.1');
    expect(volumeCapFraction({ terms: { maxDailyVolumePercent: '15' } })?.toFixed()).toBe('0.15');
    expect(volumeCapFraction({ terms: { maxDailyVolumeFraction: 0.1 } })).toBeNull();
    expect(volumeCapFraction({ terms: { maxDailyVolumeFraction: '1.5' } })).toBeNull();
    expect(volumeCapFraction({ terms: { maxDailyVolumePercent: '0' } })).toBeNull();
    expect(volumeCapFraction({ terms: {} })).toBeNull();
  });
});

describe('planRestrictedSale', () => {
  it('schedules from verified terms and labels value as indicative', () => {
    const result = planRestrictedSale(request(), { asOf, restrictions: [cap()], instrumentId: INSTRUMENT });
    expect(() => SaleScheduleResult.parse(result)).not.toThrow();
    expect(result.status).toBe('ok');
    expect(result.maxSharesPerDay).toBe('2500');
    expect(result.tradingDaysRequired).toBe(40);
    expect(result.indicativeGross).toEqual(usd('125000'));
    expect(result.caveats).toContain(INDICATIVE_CAVEAT);
    expect(result.caveats).toContain('About 8 week(s) at 5 trading days a week, if volume stays at this level.');
    expect(INDICATIVE_CAVEAT).toMatch(/^Indicative, not proceeds/);
  });

  it('floors shares per day and rounds days up', () => {
    const result = planRestrictedSale(request({ quantity: '10001', averageDailyVolume: '33333' }), { asOf, restrictions: [cap()] });
    expect(result.maxSharesPerDay).toBe('3333');
    expect(result.tradingDaysRequired).toBe(4);
  });

  it('is blocked when terms are only reported, or missing', () => {
    const reported = planRestrictedSale(request(), { asOf, restrictions: [cap({ status: 'reported_unverified' })] });
    expect(reported).toEqual({
      status: 'blocked_unverified_terms',
      maxSharesPerDay: null,
      tradingDaysRequired: null,
      indicativeGross: null,
      caveats: ['Blocked: a volume cap is reported but not verified. Verify the restriction terms from the agreement before planning a sale.'],
    });
    const none = planRestrictedSale(request(), { asOf, restrictions: [] });
    expect(none.status).toBe('blocked_unverified_terms');
    expect(none.caveats[0]).toMatch(/no verified volume-cap terms/);
  });

  it('ignores verified caps that are expired, rejected, not yet effective or for another account', () => {
    for (const restriction of [
      cap({ status: 'expired' }),
      cap({ status: 'rejected' }),
      cap({ effectiveFrom: '2026-04-01' }),
      cap({ effectiveTo: '2026-02-01' }),
      cap({ accountId: uid(99) }),
      cap({ instrumentId: uid(98) }),
    ]) {
      expect(planRestrictedSale(request(), { asOf, restrictions: [restriction], instrumentId: INSTRUMENT }).status).toBe('blocked_unverified_terms');
    }
  });

  it('is blocked when a verified cap has no usable fraction', () => {
    const result = planRestrictedSale(request(), { asOf, restrictions: [cap({ terms: { note: 'see agreement' } })] });
    expect(result.status).toBe('blocked_unverified_terms');
    expect(result.caveats).toContain('A verified volume cap exists but its terms do not state a daily volume fraction.');
  });

  it('allows an explicitly hypothetical illustration and says so', () => {
    const result = planRestrictedSale(request({ volumeSource: 'hypothetical' }), { asOf, restrictions: [cap({ status: 'reported_unverified', terms: { maxDailyVolumePercent: '20' } })] });
    expect(result.status).toBe('ok');
    expect(result.maxSharesPerDay).toBe('5000');
    expect(result.tradingDaysRequired).toBe(20);
    expect(result.caveats[0]).toBe('Hypothetical: the restriction terms are not verified and the volume is hypothetical. This is an illustration, not a sale plan.');
    const custom = planRestrictedSale(request({ volumeSource: 'hypothetical' }), { asOf, restrictions: [], hypotheticalFraction: '0.05' });
    expect(custom.maxSharesPerDay).toBe('1250');
    const missing = planRestrictedSale(request({ volumeSource: 'hypothetical' }), { asOf, restrictions: [] });
    expect(missing.status).toBe('insufficient_data');
    const verifiedHypotheticalVolume = planRestrictedSale(request({ volumeSource: 'hypothetical' }), { asOf, restrictions: [cap()] });
    expect(verifiedHypotheticalVolume.caveats).toContain('Hypothetical: the average daily volume used here is hypothetical, not observed.');
  });

  it('handles zero caps, missing prices, bad quantities and lock-ups', () => {
    const tiny = planRestrictedSale(request({ averageDailyVolume: '5' }), { asOf, restrictions: [cap()] });
    expect(tiny.maxSharesPerDay).toBe('0');
    expect(tiny.tradingDaysRequired).toBeNull();
    expect(tiny.caveats).toContain('The volume cap rounds down to zero shares a day at this volume.');
    const noPrice = planRestrictedSale(request({ hypotheticalPrice: null }), { asOf, restrictions: [cap()] });
    expect(noPrice.indicativeGross).toBeNull();
    expect(noPrice.caveats).toContain('No hypothetical price was given, so no indicative value is shown.');
    expect(planRestrictedSale(request({ quantity: '0' }), { asOf, restrictions: [cap()] }).status).toBe('insufficient_data');
    const locked = planRestrictedSale(request(), { asOf, restrictions: [cap(), cap({ id: uid(11), kind: 'lockup', status: 'reported_unverified', effectiveTo: '2026-12-31', terms: {} })] });
    expect(locked.caveats[0]).toBe('A lockup is recorded (reported unverified) until 2026-12-31; a sale may not be possible while it applies.');
  });
});

describe('restricted holdings never count as spending capacity or runway', () => {
  const accounts = [
    account({ id: uid(20), name: 'Everyday account', balance: zar('5000') }),
    // Even if mistakenly flagged for safe-to-spend, restricted equity is excluded.
    account({ id: HOLDING, name: 'Restricted shares', kind: 'restricted_equity', liquidityClass: 'restricted', balance: usd('125000'), includeInSafeToSpend: true }),
    account({ id: uid(21), name: 'Mislabelled restricted cash', kind: 'current', liquidityClass: 'restricted', balance: zar('70000') }),
    account({ id: uid(22), name: 'Shares marked as cash', kind: 'restricted_equity', liquidityClass: 'cash', balance: zar('90000') }),
  ];
  const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18', asOf: '2026-03-09', source: 'test' }]);

  it('safe-to-spend excludes them with a reason', () => {
    const computation = computeSafeToSpend({
      now: NOW,
      today: TODAY,
      primaryOwnerEntityId: OWNER_ID,
      entities: ENTITIES,
      accounts,
      planningDataConfirmed: true,
      settings: { budgetCurrency: 'ZAR', horizonDays: 30, horizonBasis: 'fixed_days', includeNearCash: true, staleAfterHours: 48 },
      fx,
    });
    expect(computation.result.eligibleCash).toEqual(zar('5000'));
    expect(computation.result.amount).toEqual(zar('5000'));
    expect(computation.excludedAccounts.map((e) => e.accountId)).toEqual([HOLDING, uid(21), uid(22)]);
    expect(computation.excludedAccounts.every((e) => e.reason === 'Restricted asset: never part of spending capacity')).toBe(true);
  });

  it('runway excludes them from the liquid balance', () => {
    const result = runway({
      scope: { kind: 'personal', entityId: null, label: 'Personal' },
      scopeEntityIds: [OWNER_ID],
      asOf: '2026-04-15',
      currency: 'ZAR',
      entities: ENTITIES,
      accounts,
      includeNearCash: true,
      flows: [],
      historyStart: '2026-01-01',
      minimumHistoryMonths: 1,
      fx,
    });
    expect(result.liquidBalance).toEqual(zar('5000'));
    expect(result.explanation.items.filter((i) => i.note === 'Restricted asset: never counted in runway').map((i) => i.label)).toEqual([
      'Restricted shares',
      'Mislabelled restricted cash',
      'Shares marked as cash',
    ]);
  });
});
