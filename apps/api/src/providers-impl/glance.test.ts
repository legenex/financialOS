import { describe, expect, it } from 'vitest';
import type { RevealableField } from '@financialos/contracts';
import { GlanceResponse } from '@financialos/contracts';
import { buildGlance, percentOf, type GlanceFacts } from './glance';

const NOW = new Date('2026-03-15T09:00:00.000Z');

function facts(overrides: Partial<GlanceFacts> = {}): GlanceFacts {
  return {
    safeToSpend: { amount: { amount: '4250.00', currency: 'ZAR' }, status: 'ok' },
    budget: { periodLabel: '2026-03', percentOfPlanUsed: 40, percentOfPeriodElapsed: 45, remaining: { amount: '1200.00', currency: 'ZAR' } },
    goals: [
      { label: 'Emergency reserve', percent: 62, fundedVerified: { amount: '31000.00', currency: 'ZAR' } },
      { label: 'Travel', percent: 10, fundedVerified: { amount: '900.00', currency: 'ZAR' } },
    ],
    due: { count: 3, nextLabel: 'Rent', total: { amount: '9800.00', currency: 'ZAR' } },
    freshness: { state: 'fresh', lastDataAt: '2026-03-15T06:00:00.000Z' },
    openExceptions: 0,
    ...overrides,
  };
}

/** Every amount-bearing place in the response, so a new one cannot slip through unmasked. */
function amountsIn(glance: GlanceResponse): unknown[] {
  return [glance.spending.safeToSpend, glance.spending.budgetRemaining, glance.dueSoon.total, ...glance.goals.map((g) => g.amount)];
}

describe('buildGlance masking', () => {
  it('includes no amount at all when nothing is revealed', () => {
    const glance = buildGlance(facts(), [], NOW);
    expect(glance.privacy).toEqual({ masked: true, revealedFields: [] });
    expect(amountsIn(glance)).toEqual([null, null, null, null, null]);
    // Counts, labels and percentages are still useful and carry no amount.
    expect(glance.dueSoon.count).toBe(3);
    expect(glance.dueSoon.nextLabel).toBe('Rent');
    expect(glance.goals.map((g) => g.label)).toEqual(['Emergency reserve', 'Travel']);
    expect(glance.spending.percentOfPlanUsed).toBe(40);
    expect(GlanceResponse.safeParse(glance).success).toBe(true);
  });

  it('includes only the fields that were revealed', () => {
    const revealed: RevealableField[] = ['safe_to_spend'];
    const glance = buildGlance(facts(), revealed, NOW);
    expect(glance.privacy).toEqual({ masked: false, revealedFields: ['safe_to_spend'] });
    expect(glance.spending.safeToSpend).toEqual({ amount: '4250.00', currency: 'ZAR' });
    expect(glance.spending.budgetRemaining).toBeNull();
    expect(glance.dueSoon.total).toBeNull();
    expect(glance.goals.every((g) => g.amount === null)).toBe(true);
  });

  it('reveals every field only when all four are enabled', () => {
    const glance = buildGlance(facts(), ['safe_to_spend', 'budget_remaining', 'goal_amounts', 'due_amounts'], NOW);
    expect(amountsIn(glance).every((value) => value !== null)).toBe(true);
    expect(GlanceResponse.safeParse(glance).success).toBe(true);
  });

  it('never invents an amount for a revealed field that is unknown', () => {
    const glance = buildGlance(facts({ safeToSpend: { amount: null, status: 'insufficient_data' }, budget: null }), ['safe_to_spend', 'budget_remaining'], NOW);
    expect(glance.spending.safeToSpend).toBeNull();
    expect(glance.spending.budgetRemaining).toBeNull();
    expect(glance.spending.safeToSpendStatus).toBe('insufficient_data');
    expect(glance.spending.status).toBe('unknown');
    expect(glance.nudge.kind).toBe('reconcile');
  });

  it('carries no transaction-level data', () => {
    const glance = buildGlance(facts(), ['safe_to_spend', 'budget_remaining', 'goal_amounts', 'due_amounts'], NOW);
    const serialised = JSON.stringify(glance);
    for (const forbidden of ['accountId', 'transactionId', 'counterparty', 'description', 'bookedOn']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('de-duplicates revealed fields', () => {
    const glance = buildGlance(facts(), ['safe_to_spend', 'safe_to_spend'], NOW);
    expect(glance.privacy.revealedFields).toEqual(['safe_to_spend']);
  });

  it('scores spending against the plan without floating point', () => {
    expect(percentOf('50.00', '200.00')).toBe(25);
    expect(percentOf('0.1', '0.3')).toBe(33);
    expect(percentOf('10', '0')).toBeNull();
    expect(buildGlance(facts({ budget: { periodLabel: 'p', percentOfPlanUsed: 130, percentOfPeriodElapsed: 50, remaining: null } }), [], NOW).spending.status).toBe('over');
    expect(buildGlance(facts({ budget: { periodLabel: 'p', percentOfPlanUsed: 80, percentOfPeriodElapsed: 50, remaining: null } }), [], NOW).spending.status).toBe('watch');
    expect(buildGlance(facts({ budget: { periodLabel: 'p', percentOfPlanUsed: 45, percentOfPeriodElapsed: 50, remaining: null } }), [], NOW).spending.status).toBe('on_track');
  });
});
