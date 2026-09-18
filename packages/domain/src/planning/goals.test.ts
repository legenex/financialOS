import { Goal } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { computeGoalProgress, projectGoalCompletions, remainingFor, type GoalContributionRecord, type GoalDefinition } from './goals';
import { PlanningError } from './shared';
import { uid, usd, zar } from './testing';

const GOAL = uid(1);

const trip: GoalDefinition = {
  id: GOAL,
  name: 'Coastal trip',
  kind: 'travel',
  target: zar('12000'),
  targetDate: '2026-09-10',
  protected: true,
  heldIn: 'separate_accounts',
  linkedAccountIds: [uid(50)],
  status: 'active',
  priority: 1,
  travel: { destination: 'Example Coast', routePreference: 'Direct flights preferred', departOn: '2026-09-15' },
};

let n = 0;
const contribution = (date: string, amount: string, status: 'planned' | 'verified', extra: Partial<GoalContributionRecord> = {}): GoalContributionRecord => {
  n += 1;
  return { id: uid(100 + n), goalId: GOAL, amount: zar(amount), date, status, transactionId: status === 'verified' ? uid(200 + n) : null, note: null, ...extra };
};

describe('goal progress', () => {
  it('counts only verified contributions and shows planned ones separately', () => {
    const result = computeGoalProgress({
      goal: trip,
      asOf: '2026-03-10',
      contributions: [
        contribution('2026-01-15', '1000', 'verified'),
        contribution('2026-02-15', '1000', 'verified'),
        contribution('2026-03-05', '1000', 'verified'),
        contribution('2026-04-05', '5000', 'planned'),
        contribution('2026-05-05', '5000', 'planned'),
        contribution('2026-03-06', '777', 'verified', { goalId: uid(9) }),
      ],
    });
    const goal = result.goal;
    expect(() => Goal.parse(goal)).not.toThrow();
    expect(goal.fundedVerified).toEqual(zar('3000'));
    expect(goal.fundedPlanned).toEqual(zar('10000'));
    expect(goal.progress).toBe('0.25');
    expect(goal.status).toBe('active');
    // 9000 left over 7 monthly contributions (Mar 10 … Sep 10).
    expect(goal.monthlyNeeded).toEqual(zar('1285.72'));
    expect(result.averageMonthlyVerified).toEqual(zar('1000'));
    expect(result.projectedCompletionOn).toBe('2026-12-10');
    expect(result.plannedCompletionOn).toBe('2026-05-05');
    expect(result.planned.map((p) => p.amount.amount)).toEqual(['5000', '5000']);
    expect(goal.travel).toEqual(trip.travel);
    expect(result.explanation.assumptions).toContain('At the recent pace the goal completes around 2026-12-10, after its target date 2026-09-10');
    expect(result.explanation.items.filter((i) => i.role === 'excluded').every((i) => i.note === 'Planned, not saved')).toBe(true);
    expect(result.explanation.items.find((i) => i.label === 'Verified contribution on 2026-01-15')?.links).toHaveLength(2);
  });

  it('never counts planned contributions as progress', () => {
    const result = computeGoalProgress({ goal: trip, asOf: '2026-03-10', contributions: [contribution('2026-03-01', '12000', 'planned')] });
    expect(result.goal.progress).toBe('0');
    expect(result.goal.status).toBe('active');
    expect(result.averageMonthlyVerified).toBeNull();
    expect(result.projectedCompletionOn).toBeNull();
    expect(result.plannedCompletionOn).toBe('2026-03-01');
  });

  it('marks an active goal achieved from verified money and caps progress at 1', () => {
    const result = computeGoalProgress({
      goal: trip,
      asOf: '2026-03-10',
      contributions: [contribution('2026-01-01', '10000', 'verified'), contribution('2026-02-01', '3000', 'verified')],
    });
    expect(result.goal.status).toBe('achieved');
    expect(result.goal.progress).toBe('1');
    expect(result.goal.monthlyNeeded).toEqual(zar('0'));
    expect(result.projectedCompletionOn).toBe('2026-02-01');
    const paused = computeGoalProgress({ goal: { ...trip, status: 'paused' }, asOf: '2026-03-10', contributions: [contribution('2026-01-01', '13000', 'verified')] });
    expect(paused.goal.status).toBe('paused');
  });

  it('ignores future-dated verified entries and handles withdrawals', () => {
    const result = computeGoalProgress({
      goal: trip,
      asOf: '2026-03-10',
      contributions: [contribution('2026-02-01', '2000', 'verified'), contribution('2026-02-20', '-500', 'verified'), contribution('2026-04-01', '9000', 'verified')],
    });
    expect(result.goal.fundedVerified).toEqual(zar('1500'));
    expect(result.explanation.items).toContainEqual(expect.objectContaining({ label: 'Verified contribution dated in the future (2026-04-01)', role: 'excluded' }));
  });

  it('converts foreign contributions or reports them missing', () => {
    const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18', asOf: '2026-02-01', source: 'test' }]);
    const foreign = { ...contribution('2026-02-02', '0', 'verified'), amount: usd('100') };
    expect(computeGoalProgress({ goal: trip, asOf: '2026-03-10', contributions: [foreign], fx }).goal.fundedVerified).toEqual(zar('1800'));
    const missing = computeGoalProgress({ goal: trip, asOf: '2026-03-10', contributions: [foreign] });
    expect(missing.goal.fundedVerified).toEqual(zar('0'));
    expect(missing.explanation.missing).toContain('Contribution on 2026-02-02 could not be converted to ZAR');
  });

  it('handles goals without a target date', () => {
    const result = computeGoalProgress({ goal: { ...trip, targetDate: null, travel: null }, asOf: '2026-03-10', contributions: [] });
    expect(result.goal.monthlyNeeded).toBeNull();
    expect(result.goal.travel).toBeNull();
    expect(result.explanation.assumptions).toContain('No target date, so no monthly amount is calculated');
  });

  it('rejects invalid goals', () => {
    expect(() => computeGoalProgress({ goal: { ...trip, target: zar('0') }, asOf: '2026-03-10', contributions: [] })).toThrow(PlanningError);
    expect(() => computeGoalProgress({ goal: trip, asOf: '2026-03-10', contributions: [], paceMonths: 0 })).toThrow(PlanningError);
  });
});

describe('goal completion waterfall', () => {
  const goals = [
    { id: 'b', name: 'Second', remaining: zar('3000'), priority: 2 },
    { id: 'a', name: 'First', remaining: zar('2000'), priority: 1 },
    { id: 'done', name: 'Done', remaining: zar('0'), priority: 3 },
  ];

  it('funds goals in priority order', () => {
    const result = projectGoalCompletions(goals, zar('1000'), '2026-03-10');
    expect(result.get('a')).toBe('2026-05-10');
    expect(result.get('b')).toBe('2026-08-10');
    expect(result.get('done')).toBe('2026-03-10');
  });

  it('lets drains consume capacity, carrying large drains forward', () => {
    const result = projectGoalCompletions(goals, zar('1000'), '2026-03-10', [{ date: '2026-03-10', amount: zar('2500') }]);
    expect(result.get('a')).toBe('2026-08-10');
    expect(result.get('b')).toBe('2026-11-10');
  });

  it('returns null when capacity never completes a goal', () => {
    const result = projectGoalCompletions(goals, zar('0'), '2026-03-10', [], 24);
    expect(result.get('a')).toBeNull();
    expect(() => projectGoalCompletions(goals, usd('1'), '2026-03-10')).toThrow(PlanningError);
    expect(() => projectGoalCompletions([], zar('1'), '2026-03-10', [{ date: '2026-03-10', amount: usd('1') }])).toThrow(PlanningError);
  });

  it('computes remaining amounts', () => {
    expect(remainingFor({ target: zar('100'), fundedVerified: zar('40') })).toEqual(zar('60'));
    expect(remainingFor({ target: zar('100'), fundedVerified: zar('140') })).toEqual(zar('0'));
  });
});
