/**
 * Synthetic glance fixtures for tests and for the runtime mock server. Every figure here is made
 * up; none of it comes from a real account. Amounts are decimal strings, exactly as the contract
 * requires, and unknown values stay null.
 *
 * This module is never bundled: no entry point imports it.
 */
import type { GlanceResponse, RevealableField } from '@financialos/contracts';

export const SAMPLE_DEVICE_ID = '2f1c8a44-9e2b-4f7d-9d0a-5c6b7e8f9a01';

export interface GlanceFixtureOptions {
  generatedAt?: string;
  validForSeconds?: number;
  revealedFields?: RevealableField[];
}

/**
 * The masked glance the server returns by default: shape, status and counts, but no amounts.
 * Passing `revealedFields` adds back exactly the amounts that field allows, the way
 * `maskGlance` on the server does.
 */
export function sampleGlance(options: GlanceFixtureOptions = {}): GlanceResponse {
  const generatedAt = options.generatedAt ?? '2026-09-18T08:55:00.000Z';
  const validUntil = new Date(Date.parse(generatedAt) + (options.validForSeconds ?? 600) * 1000).toISOString();
  const revealed = options.revealedFields ?? [];
  const has = (field: RevealableField) => revealed.includes(field);
  return {
    generatedAt,
    validUntil,
    privacy: { masked: revealed.length === 0, revealedFields: [...revealed] },
    spending: {
      status: 'watch',
      periodLabel: 'September',
      percentOfPlanUsed: 68,
      percentOfPeriodElapsed: 57,
      safeToSpend: has('safe_to_spend') ? { amount: '1284.50', currency: 'EUR' } : null,
      safeToSpendStatus: 'ok',
      budgetRemaining: has('budget_remaining') ? { amount: '940.00', currency: 'EUR' } : null,
    },
    goals: [
      {
        label: 'Emergency fund',
        percent: 72,
        amount: has('goal_amounts') ? { amount: '7200.00', currency: 'EUR' } : null,
      },
      { label: 'New laptop', percent: 40, amount: has('goal_amounts') ? { amount: '800.00', currency: 'EUR' } : null },
      { label: 'Summer trip', percent: 15, amount: has('goal_amounts') ? { amount: '450.00', currency: 'EUR' } : null },
    ],
    dueSoon: {
      count: 3,
      windowDays: 14,
      nextLabel: 'Office rent',
      total: has('due_amounts') ? { amount: '2310.00', currency: 'EUR' } : null,
    },
    nudge: { text: 'Two card charges are still unclassified. A minute now keeps September tidy.', kind: 'reconcile' },
    freshness: { state: 'fresh', lastDataAt: '2026-09-18T08:40:00.000Z' },
    attention: { openExceptions: 2 },
  };
}

/** The quiet variant: nothing due, no goals, all clear. Used to check the calm states render. */
export function calmGlance(options: GlanceFixtureOptions = {}): GlanceResponse {
  const base = sampleGlance(options);
  return {
    ...base,
    spending: { ...base.spending, status: 'on_track', percentOfPlanUsed: 41 },
    goals: [],
    dueSoon: { count: 0, windowDays: 14, nextLabel: null, total: null },
    nudge: { text: 'Nothing needs you today. Spending is steady and everything is reconciled.', kind: 'calm' },
    attention: { openExceptions: 0 },
  };
}
