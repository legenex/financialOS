import { PurchaseImpactResult, type PurchaseImpactInput } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { purchaseImpact, purchaseInstalments, simulatePurchase, type PurchaseImpactContext } from './purchaseImpact';
import type { SafeToSpendInput } from './safeToSpend';
import { PlanningError } from './shared';
import { account, ENTITIES, NOW, OWNER_ID, recurring, TODAY, uid, usd, zar } from './testing';

const EVERYDAY = uid(100);
const RENT = uid(200);
const ELECTRONICS = uid(300);

function sts(overrides: Partial<SafeToSpendInput> = {}): SafeToSpendInput {
  return {
    now: NOW,
    today: TODAY,
    primaryOwnerEntityId: OWNER_ID,
    entities: ENTITIES,
    accounts: [account({ id: EVERYDAY, name: 'Everyday account', balance: zar('10000') })],
    recurring: [recurring({ id: RENT, name: 'Rent', nextDueOn: '2026-03-25', amount: { amount: '4000', currency: 'ZAR' } })],
    reserves: [{ id: uid(400), name: 'Emergency reserve', heldIn: 'eligible_cash_accounts', amount: zar('1000'), basis: 'reserve target' }],
    settings: { budgetCurrency: 'ZAR', horizonDays: 30, horizonBasis: 'fixed_days', includeNearCash: false, staleAfterHours: 48 },
    fx: new FxTable([{ base: 'USD', quote: 'ZAR', rate: '20', asOf: '2026-03-09', source: 'test' }]),
    ...overrides,
  };
}

const budget = {
  currency: 'ZAR',
  period: { start: '2026-03-01', end: '2026-03-31', label: 'March 2026' },
  lines: [
    { id: uid(500), categoryId: ELECTRONICS, categoryName: 'Electronics', kind: 'spending' as const, planned: zar('2000'), actual: zar('500'), remaining: zar('1500'), rollover: false, carriedIn: null },
  ],
};

function purchase(overrides: Partial<PurchaseImpactInput> = {}): PurchaseImpactInput {
  return { amount: '1000', currency: 'ZAR', date: '2026-03-15', categoryId: ELECTRONICS, label: 'Headphones', paymentAccountId: null, installments: 1, ...overrides };
}

function context(overrides: Partial<PurchaseImpactContext> = {}): PurchaseImpactContext {
  return {
    safeToSpend: sts(),
    budget,
    goals: [{ id: uid(600), name: 'Trip', target: zar('6000'), fundedVerified: zar('0'), priority: 1, status: 'active' }],
    monthlyGoalCapacity: zar('2000'),
    ...overrides,
  };
}

describe('purchase impact', () => {
  it('reports before/after safe-to-spend, the budget line and a fitting verdict', () => {
    const result = purchaseImpact(purchase(), context());
    expect(() => PurchaseImpactResult.parse(result)).not.toThrow();
    // Before: 10000 − 4000 − 1000 reserve = 5000. After: 4000.
    expect(result.safeToSpendBefore).toEqual(zar('5000'));
    expect(result.safeToSpendAfter).toEqual(zar('4000'));
    expect(result.budgetLineBefore).toEqual(zar('1500'));
    expect(result.budgetLineAfter).toEqual(zar('500'));
    expect(result.reserveShortfallAfter).toEqual(zar('0'));
    expect(result.commitmentsAtRisk).toEqual([]);
    expect(result.verdict).toBe('fits');
    expect(result.status).toBe('ok');
    // 6000 at 2000/month completes on 2026-06-10; a 1000 purchase moves it to 2026-07-10.
    expect(result.goalsDelayed).toEqual([{ goalId: uid(600), name: 'Trip', delayDays: 30 }]);
    expect(result.explanation.summary).toBe('Verdict: fits. Safe to spend goes from 5000 to 4000 ZAR. It would delay 1 goal.');
  });

  it('is tight when little safe-to-spend would remain', () => {
    const result = purchaseImpact(purchase({ amount: '4600' }), context());
    expect(result.safeToSpendAfter).toEqual(zar('400'));
    expect(result.verdict).toBe('tight');
    expect(result.budgetLineAfter).toEqual(zar('-3100'));
    expect(result.explanation.summary).toContain('less than 10% of safe to spend would remain');
  });

  it('is tight within a configurable buffer or when the budget line is overspent', () => {
    expect(purchaseImpact(purchase(), context({ tightBuffer: zar('4500') })).verdict).toBe('tight');
    expect(purchaseImpact(purchase(), context({ tightBuffer: usd('100') })).verdict).toBe('fits');
    expect(purchaseImpact(purchase({ amount: '1600' }), context()).verdict).toBe('tight');
    expect(purchaseImpact(purchase({ amount: '1600' }), context({ budget: null })).verdict).toBe('fits');
  });

  it('does not fit when it would eat into reserves, and lists commitments at risk', () => {
    const result = purchaseImpact(purchase({ amount: '6500', date: '2026-03-12' }), context());
    expect(result.safeToSpendAfter).toEqual(zar('0'));
    expect(result.verdict).toBe('does_not_fit');
    // Lowest after = 10000 − 6500 − 4000 = −500: the whole 1000 reserve is gone.
    expect(result.reserveShortfallAfter).toEqual(zar('1000'));
    expect(result.commitmentsAtRisk).toEqual([{ label: 'Rent', dueOn: '2026-03-25', amount: zar('4000') }]);
    const partial = purchaseImpact(purchase({ amount: '5400' }), context());
    expect(partial.reserveShortfallAfter).toEqual(zar('400'));
    expect(partial.commitmentsAtRisk).toEqual([]);
  });

  it('lists unknown-amount commitments that fall after the balance turns negative', () => {
    const result = purchaseImpact(
      purchase({ amount: '9000' }),
      context({
        safeToSpend: sts({
          obligations: [{ id: uid(700), entityId: OWNER_ID, dueOn: '2026-03-28', amount: { amount: null, currency: null }, label: 'Water', kind: 'bill', status: 'upcoming' }],
        }),
      }),
    );
    expect(result.commitmentsAtRisk).toEqual([
      { label: 'Rent', dueOn: '2026-03-25', amount: zar('4000') },
      { label: 'Water', dueOn: '2026-03-28', amount: null },
    ]);
    expect(result.status).toBe('provisional');
  });

  it('spreads instalments monthly and only counts those in the horizon and budget period', () => {
    const instalments = purchaseInstalments(purchase({ amount: '1000', installments: 3, date: '2026-01-31' }));
    expect(instalments.map((i) => [i.id, i.date, i.amount?.amount])).toEqual([
      ['purchase:1', '2026-01-31', '333.34'],
      ['purchase:2', '2026-02-28', '333.33'],
      ['purchase:3', '2026-03-31', '333.33'],
    ]);
    const result = simulatePurchase(purchase({ amount: '3000', installments: 3 }), context());
    expect(result.result.safeToSpendAfter).toEqual(zar('4000'));
    expect(result.result.budgetLineAfter).toEqual(zar('500'));
    expect(result.result.explanation.assumptions).toContain('2 instalment(s) fall after the safe-to-spend horizon (2026-04-09) and are not reflected in it');
    expect(result.instalments).toHaveLength(3);
  });

  it('converts a foreign purchase', () => {
    const result = purchaseImpact(purchase({ amount: '50', currency: 'USD' }), context());
    expect(result.safeToSpendAfter).toEqual(zar('4000'));
    expect(result.budgetLineAfter).toEqual(zar('500'));
  });

  it('is unknown when the base safe-to-spend has insufficient data', () => {
    const result = purchaseImpact(purchase(), context({ safeToSpend: sts({ accounts: [account({ id: EVERYDAY, name: 'Everyday account', balance: null })] }) }));
    expect(result.verdict).toBe('unknown');
    expect(result.status).toBe('insufficient_data');
    expect(result.safeToSpendBefore).toBeNull();
    expect(result.safeToSpendAfter).toBeNull();
    expect(result.explanation.missing).toContain('Safe to spend is not available, so the impact cannot be judged');
  });

  it('is unknown when the purchase falls after the horizon', () => {
    const result = purchaseImpact(purchase({ date: '2026-06-01' }), context());
    expect(result.verdict).toBe('unknown');
    expect(result.safeToSpendAfter).toEqual(result.safeToSpendBefore);
  });

  it('keeps goal delays unknown without a monthly capacity and never invents budget figures', () => {
    const result = purchaseImpact(purchase({ categoryId: uid(999) }), context({ monthlyGoalCapacity: null }));
    expect(result.goalsDelayed).toEqual([]);
    expect(result.explanation.missing).toContain('Monthly goal capacity is unknown, so goal delays could not be calculated');
    expect(result.budgetLineBefore).toBeNull();
    expect(result.explanation.assumptions).toContain('No budget line matches the purchase category');
  });

  it('reports a goal that would never complete with a null delay', () => {
    // 110000 at 200/month completes after 550 months; 60 instalments of 200 push it past the 600-month projection.
    const goals = [{ id: uid(601), name: 'Big', target: zar('110000'), fundedVerified: zar('0'), priority: 1, status: 'active' as const }];
    const result = simulatePurchase(purchase({ amount: '12000', installments: 60 }), context({ monthlyGoalCapacity: zar('200'), goals }));
    expect(result.result.goalsDelayed).toEqual([{ goalId: uid(601), name: 'Big', delayDays: null }]);
    expect(result.result.explanation.items).toContainEqual(expect.objectContaining({ label: 'Big delayed', note: 'Completion moves from 2072-01-10 to beyond the projection' }));
  });

  it('rejects invalid purchases', () => {
    expect(() => purchaseInstalments(purchase({ amount: '0' }))).toThrow(PlanningError);
    expect(() => purchaseInstalments(purchase({ installments: 0 }))).toThrow(PlanningError);
  });
});
