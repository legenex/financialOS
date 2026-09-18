import { Freshness, Valuation, type BalanceSnapshot } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { money } from '../money';
import { uuid } from './test-support';
import { freshnessState, selectValuation, valuationPrecedence, type HoldingsSource, type ValuationInput, type ValuationSettings } from './valuation';

const ACC = uuid(1);
const usd = (a: string) => money(a, 'USD');
const settings: ValuationSettings = { now: '2026-09-17T12:00:00Z', staleAfterHours: 24 };

function snap(n: number, kind: BalanceSnapshot['kind'], amount: string, over: Partial<BalanceSnapshot> = {}): BalanceSnapshot {
  return {
    id: uuid(n),
    accountId: ACC,
    kind,
    balance: usd(amount),
    approximate: false,
    completeness: 'complete',
    reportedAt: '2026-09-10T09:00:00Z',
    sourceAsOf: '2026-08-31T23:59:59Z',
    provenance: { source: 'Example statement', sourceKind: 'import', reportedAt: '2026-09-10T09:00:00Z', sourceAsOf: '2026-08-31T23:59:59Z', verified: true },
    composition: null,
    supersededBy: null,
    ...over,
  };
}

const ownerReported = (n: number, amount: string, symbols: string[] | null, over: Partial<BalanceSnapshot> = {}) =>
  snap(n, 'owner_reported_total', amount, {
    approximate: true,
    completeness: 'partial',
    sourceAsOf: null,
    provenance: { source: 'Owner onboarding', sourceKind: 'owner_reported', reportedAt: '2026-09-01T10:00:00Z', sourceAsOf: null, verified: false },
    reportedAt: '2026-09-01T10:00:00Z',
    composition: symbols ? symbols.map((s) => ({ instrumentSymbol: s, quantity: null, approximate: true })) : null,
    ...over,
  });

function holdings(over: Partial<HoldingsSource> = {}): HoldingsSource {
  return {
    id: uuid(50),
    asOf: '2026-09-16T12:00:00Z',
    reportedAt: '2026-09-16T12:05:00Z',
    completeness: 'complete',
    verified: true,
    source: 'Example broker export',
    sourceKind: 'import',
    lines: [
      { instrumentSymbol: 'EXF', quantity: '10', value: usd('600') },
      { instrumentSymbol: 'EXB', quantity: '4', value: usd('400') },
    ],
    ...over,
  };
}

const full: ValuationInput = {
  accountId: ACC,
  accountCurrency: 'USD',
  holdings: [holdings()],
  providerBalances: [{ id: uuid(60), balance: usd('1010'), kind: 'current', asOf: '2026-09-17T08:00:00Z', reportedAt: '2026-09-17T08:00:05Z', source: 'Example API', verified: true }],
  snapshots: [snap(2, 'statement_closing', '990'), ownerReported(3, '1200', null)],
  ledgerBalance: { balance: usd('980'), asOf: '2026-09-15', complete: true },
};

describe('selectValuation', () => {
  it('follows the precedence ladder and never sums sources', () => {
    const steps: Array<[ValuationInput, string, string]> = [
      [full, 'verified_holdings', '1000'],
      [{ ...full, holdings: [] }, 'provider_balance', '1010'],
      [{ ...full, holdings: [], providerBalances: [] }, 'statement_closing', '990'],
      [{ ...full, holdings: [], providerBalances: [], snapshots: [ownerReported(3, '1200', null)] }, 'ledger_balance', '980'],
      [{ ...full, holdings: [], providerBalances: [], snapshots: [ownerReported(3, '1200', null)], ledgerBalance: null }, 'owner_reported_total', '1200'],
    ];
    for (const [input, basis, amount] of steps) {
      const result = selectValuation(input, settings);
      expect(result.valuation.basis).toBe(basis);
      expect(result.valuation.value).toEqual({ amount, currency: 'USD' });
      expect(result.candidates.filter((c) => c.chosen)).toHaveLength(1);
      expect(Valuation.parse(result.valuation)).toEqual(result.valuation);
      expect(Freshness.parse(result.freshness)).toEqual(result.freshness);
    }
    const top = selectValuation(full, settings);
    expect(top.candidates.map((c) => [c.basis, c.chosen])).toEqual([
      ['verified_holdings', true],
      ['provider_balance', false],
      ['statement_closing', false],
      ['ledger_balance', false],
      ['owner_reported_total', false],
    ]);
    expect(top.candidates[1]!.reason).toMatch(/higher-precedence source was used/);
    expect(top.valuation).toMatchObject({ completeness: 'complete', approximate: false, asOf: '2026-09-16T12:00:00Z', provenance: { verified: true, sourceKind: 'import' } });
    expect(top.explanation.formula).toMatch(/never summed/);
  });

  it('supersedes an owner-reported total that overlaps imported holdings instead of adding it', () => {
    const overlapping = ownerReported(4, '5000', ['exf', 'OTHER']);
    const complete = selectValuation({ accountId: ACC, accountCurrency: 'USD', holdings: [holdings()], snapshots: [overlapping] }, settings);
    expect(complete.valuation.value).toEqual({ amount: '1000', currency: 'USD' });
    expect(complete.supersededSnapshotIds).toEqual([uuid(4)]);
    expect(complete.candidates.find((c) => c.sourceId === uuid(4))!.reason).toBe('Superseded by imported holdings (EXF); never added to them');

    // Even with partial holdings the snapshot is not used: the account is unknown rather than double counted.
    const partial = selectValuation({ accountId: ACC, accountCurrency: 'USD', holdings: [holdings({ completeness: 'partial' })], snapshots: [overlapping] }, settings);
    expect(partial.valuation).toMatchObject({ basis: 'unknown', value: { amount: null, currency: 'USD' }, completeness: 'unknown', provenance: null });
    expect(partial.supersededSnapshotIds).toEqual([uuid(4)]);
    expect(partial.explanation.missing).toEqual(['Imported holdings are incomplete or unverified, so they are not a valuation on their own', 'No verified or reported value is available']);
    expect(partial.freshness).toEqual({ label: 'No valuation', lastUpdatedAt: null, state: 'unknown' });

    // A snapshot that does not overlap stays usable, with its flags carried through.
    const separate = selectValuation({ accountId: ACC, accountCurrency: 'USD', holdings: [holdings({ verified: false })], snapshots: [ownerReported(5, '700', ['XYZ'])] }, settings);
    expect(separate.valuation).toMatchObject({ basis: 'owner_reported_total', value: { amount: '700' }, approximate: true, completeness: 'partial', asOf: null, reportedAt: '2026-09-01T10:00:00Z' });
    expect(separate.freshness.state).toBe('unknown');
    expect(separate.explanation.assumptions).toContain('Owner-reported figure; not verified against a statement or provider');
    expect(separate.explanation.missing).toContain('The date this value applies to is unknown');

    // A snapshot already marked superseded is never used.
    const marked = selectValuation({ accountId: ACC, accountCurrency: 'USD', snapshots: [ownerReported(6, '10', null, { supersededBy: uuid(7) })] }, settings);
    expect(marked.valuation.basis).toBe('unknown');
    expect(marked.supersededSnapshotIds).toEqual([uuid(6)]);
  });

  it('never uses available balances, unverified or incomplete holdings, or statement openings', () => {
    const result = selectValuation(
      {
        accountId: ACC,
        accountCurrency: 'USD',
        holdings: [holdings({ verified: false }), holdings({ id: uuid(51), lines: [{ instrumentSymbol: 'EXF', quantity: '1', value: { amount: null, currency: null } }] })],
        providerBalances: [{ id: uuid(61), balance: usd('25000'), kind: 'available', asOf: null, reportedAt: '2026-09-17T08:00:00Z', source: 'Example API', verified: true }],
        snapshots: [snap(8, 'provider_available', '30000'), snap(9, 'statement_opening', '10')],
      },
      settings,
    );
    expect(result.valuation.basis).toBe('unknown');
    expect(result.candidates.map((c) => c.reason)).toEqual([
      'Holdings are not verified',
      '1 holding line(s) have no value',
      'Available balance can include overdraft, credit limit or buying power; never used as a valuation',
      'Available balance can include overdraft, credit limit or buying power; never used as a valuation',
      'A statement opening balance is not a current valuation',
    ]);
    const empty = selectValuation({ accountId: ACC, accountCurrency: null }, settings);
    expect(empty.freshness.state).toBe('never');
    expect(empty.valuation.value).toEqual({ amount: null, currency: null });
  });

  it('prefers the latest source within a tier and uses provider snapshots', () => {
    const result = selectValuation(
      {
        accountId: ACC,
        accountCurrency: 'USD',
        snapshots: [
          snap(10, 'statement_closing', '100', { sourceAsOf: '2026-06-30T23:59:59Z' }),
          snap(11, 'statement_closing', '200', { sourceAsOf: '2026-07-31T23:59:59Z' }),
          snap(12, 'statement_closing', '300', { sourceAsOf: '2026-05-31T23:59:59Z', supersededBy: uuid(13) }),
        ],
      },
      settings,
    );
    expect(result.valuation.value.amount).toBe('200');
    expect(result.candidates.find((c) => c.sourceId === uuid(12))!.reason).toBe(`Superseded by ${uuid(13)}`);
    const provider = selectValuation({ accountId: ACC, accountCurrency: 'USD', snapshots: [snap(14, 'provider_current', '42', { sourceAsOf: null, reportedAt: '2026-09-17T11:00:00Z' })] }, settings);
    expect(provider.valuation).toMatchObject({ basis: 'provider_balance', asOf: '2026-09-17T11:00:00Z' });
    expect(provider.freshness.state).toBe('fresh');
  });

  it('derives freshness from settings', () => {
    expect(freshnessState('2026-09-17T08:00:00Z', settings)).toBe('fresh');
    expect(freshnessState('2026-09-16T20:00:00Z', settings)).toBe('aging');
    expect(freshnessState('2026-09-16T12:00:00Z', settings)).toBe('aging');
    expect(freshnessState('2026-09-16T11:59:59Z', settings)).toBe('stale');
    expect(freshnessState('2026-09-17T08:00:00Z', { ...settings, agingAfterHours: 2 })).toBe('aging');
    expect(freshnessState(null, settings)).toBe('unknown');
    expect(freshnessState('not a date', settings)).toBe('unknown');
    const ledger = selectValuation({ accountId: ACC, accountCurrency: 'USD', ledgerBalance: { balance: usd('5'), asOf: '2026-09-10', complete: false } }, settings);
    expect(ledger.valuation).toMatchObject({ asOf: '2026-09-10T23:59:59Z', completeness: 'partial' });
    expect(ledger.freshness).toEqual({ label: 'Ledger balance', lastUpdatedAt: '2026-09-10T23:59:59Z', state: 'stale' });
  });

  it('converts into the reporting currency at the valuation date and reports missing rates', () => {
    const fx = new FxTable([
      { base: 'USD', quote: 'ZAR', rate: '18.5', asOf: '2026-09-15', source: 'test-feed' },
      { base: 'EUR', quote: 'USD', rate: '1.1', asOf: '2026-09-15', source: 'test-feed' },
    ]);
    const zar: ValuationInput = { accountId: ACC, accountCurrency: 'ZAR', snapshots: [snap(20, 'statement_closing', '1850', { balance: money('1850', 'ZAR'), sourceAsOf: '2026-09-16T00:00:00Z' })] };
    const converted = selectValuation(zar, { ...settings, reportingCurrency: 'USD', fx });
    expect(converted.valuation.reporting).toEqual({
      original: money('1850', 'ZAR'),
      converted: usd('100'),
      fx: { from: 'ZAR', to: 'USD', rate: expect.stringMatching(/^0\.054054/), rateSource: 'test-feed (inverse)', rateAsOf: '2026-09-15', method: 'spot_at_valuation' },
      unconvertedReason: null,
    });
    const missing = selectValuation(zar, { ...settings, reportingCurrency: 'GBP', fx });
    expect(missing.valuation.reporting!.converted).toBeNull();
    expect(missing.explanation.missing[0]).toMatch(/No rate to convert into GBP/);
    expect(Valuation.parse(missing.valuation)).toEqual(missing.valuation);

    const mixed = holdings({ lines: [{ instrumentSymbol: 'EXF', quantity: '1', value: usd('50') }, { instrumentSymbol: 'EUX', quantity: '1', value: money('100', 'EUR'), approximate: true }] });
    const mixedResult = selectValuation({ accountId: ACC, accountCurrency: 'USD', holdings: [mixed] }, { ...settings, fx });
    expect(mixedResult.valuation).toMatchObject({ basis: 'verified_holdings', value: { amount: '160', currency: 'USD' }, approximate: true });
    const noRate = selectValuation({ accountId: ACC, accountCurrency: 'USD', holdings: [mixed] }, settings);
    expect(noRate.valuation.basis).toBe('unknown');
    expect(noRate.candidates[0]!.reason).toMatch(/^Cannot convert EUX/);
    const noTarget = selectValuation({ accountId: ACC, accountCurrency: null, holdings: [mixed] }, settings);
    expect(noTarget.candidates[0]!.reason).toBe('Holdings are in several currencies and no valuation currency is set');
  });

  it('ranks bases', () => {
    expect(['owner_reported_total', 'unknown', 'verified_holdings', 'ledger_balance'].sort((a, b) => valuationPrecedence(a as never) - valuationPrecedence(b as never))).toEqual([
      'verified_holdings',
      'ledger_balance',
      'owner_reported_total',
      'unknown',
    ]);
  });
});
