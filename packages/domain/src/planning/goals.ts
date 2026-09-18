/**
 * Goal progress. Only verified contributions count as saved; planned contributions are reported separately and
 * never counted. Projections are pace-based (verified history) or plan-based (scheduled planned contributions).
 */
import type { Explanation, Goal, GoalContribution, Money } from '@financialos/contracts';
import { addMonths, compareDates, type IsoDate } from '../dates';
import type { FxTable } from '../fx';
import { D, dec, money, roundToCurrency, zero, type Dec } from '../money';
import { sinkingFundMonthlyAmount } from './budget';
import { ExplanationBuilder } from './explain-local';
import { compareStrings, convertOrNull, decString, PlanningError } from './shared';

export type GoalDefinition = Pick<Goal, 'id' | 'name' | 'kind' | 'target' | 'targetDate' | 'protected' | 'heldIn' | 'linkedAccountIds' | 'status' | 'priority' | 'travel'>;

export type GoalContributionRecord = Pick<GoalContribution, 'id' | 'goalId' | 'amount' | 'date' | 'status' | 'transactionId' | 'note'>;

export interface GoalProgressInput {
  goal: GoalDefinition;
  contributions: readonly GoalContributionRecord[];
  asOf: IsoDate;
  fx?: FxTable;
  /** Trailing months used for the verified saving pace (default 3). */
  paceMonths?: number;
}

export interface GoalProgressResult {
  goal: Goal;
  /** Completion date at the recent verified pace, or null when there is no positive pace. */
  projectedCompletionOn: IsoDate | null;
  /** Date the scheduled planned contributions would reach the target, or null if they never do. */
  plannedCompletionOn: IsoDate | null;
  averageMonthlyVerified: Money | null;
  planned: Array<{ id: string; date: IsoDate; amount: Money }>;
  explanation: Explanation;
}

export function computeGoalProgress(input: GoalProgressInput): GoalProgressResult {
  const { goal, asOf } = input;
  const currency = goal.target.currency;
  const target = dec(goal.target.amount);
  if (!target.greaterThan(0)) throw new PlanningError(`Goal ${goal.name} needs a positive target`);
  const paceMonths = input.paceMonths ?? 3;
  if (!Number.isInteger(paceMonths) || paceMonths < 1) throw new PlanningError('paceMonths must be a positive integer');
  const ex = new ExplanationBuilder('', 'progress = verified contributions ÷ target; planned contributions are shown separately and never counted as saved');
  const goalLink = { kind: 'goal' as const, id: goal.id, label: goal.name };

  const toGoalCurrency = (c: GoalContributionRecord): Dec | null => {
    if (c.amount.currency === currency) return dec(c.amount.amount);
    if (!input.fx) return null;
    const converted = convertOrNull(c.amount, currency, c.date, input.fx, { method: 'historical' });
    return converted.value ? dec(converted.value.amount) : null;
  };

  let verified = new D(0);
  let planned = new D(0);
  const verifiedDated: Array<{ date: IsoDate; amount: Dec }> = [];
  const plannedList: GoalProgressResult['planned'] = [];
  const own = input.contributions.filter((c) => c.goalId === goal.id).sort((a, b) => compareDates(a.date, b.date) || compareStrings(a.id, b.id));
  for (const c of own) {
    const links = c.transactionId ? [goalLink, { kind: 'transaction' as const, id: c.transactionId, label: 'Contribution' }] : [goalLink];
    const amount = toGoalCurrency(c);
    if (amount === null) {
      ex.missing(`Contribution on ${c.date} could not be converted to ${currency}`, { value: c.amount, links });
      continue;
    }
    const value = roundToCurrency(money(amount, currency));
    if (c.status === 'verified') {
      if (c.date > asOf) {
        ex.excluded(`Verified contribution dated in the future (${c.date})`, value, { note: 'Not counted until its date', links });
        continue;
      }
      verified = verified.plus(amount);
      verifiedDated.push({ date: c.date, amount });
      ex.input(`Verified contribution on ${c.date}`, value, { links });
    } else {
      planned = planned.plus(amount);
      plannedList.push({ id: c.id, date: c.date, amount: value });
      ex.excluded(`Planned contribution on ${c.date}`, value, { note: 'Planned, not saved', links });
    }
  }

  const fundedVerified = roundToCurrency(money(verified, currency));
  const fundedPlanned = roundToCurrency(money(planned, currency));
  const ratio = verified.dividedBy(target);
  const progress = decString(D.max(0, D.min(1, ratio)), 4, 'down');
  const monthlyNeeded = sinkingFundMonthlyAmount(goal.target, fundedVerified, goal.targetDate, asOf);
  const remaining = target.minus(verified);
  const achieved = !remaining.greaterThan(0);
  const status: Goal['status'] = achieved && goal.status === 'active' ? 'achieved' : goal.status;

  // Pace from verified contributions in the trailing window (asOf − paceMonths, asOf].
  const windowStart = addMonths(asOf, -paceMonths);
  const recent = verifiedDated.filter((c) => c.date > windowStart);
  const pace = recent.reduce((acc, c) => acc.plus(c.amount), new D(0)).dividedBy(paceMonths);
  const averageMonthlyVerified = verifiedDated.length > 0 ? roundToCurrency(money(pace, currency)) : null;

  let projectedCompletionOn: IsoDate | null = null;
  if (achieved) {
    let running = new D(0);
    for (const c of verifiedDated) {
      running = running.plus(c.amount);
      if (running.greaterThanOrEqualTo(target)) {
        projectedCompletionOn = c.date;
        break;
      }
    }
    projectedCompletionOn ??= asOf;
  } else if (pace.greaterThan(0)) {
    const months = remaining.dividedBy(pace).ceil().toNumber();
    projectedCompletionOn = addMonths(asOf, months);
  }

  let plannedCompletionOn: IsoDate | null = achieved ? projectedCompletionOn : null;
  if (!achieved) {
    let running = verified;
    for (const p of plannedList) {
      running = running.plus(dec(p.amount.amount));
      if (running.greaterThanOrEqualTo(target)) {
        plannedCompletionOn = p.date;
        break;
      }
    }
  }

  ex.result('Verified savings', fundedVerified);
  ex.result('Planned (not yet saved)', fundedPlanned);
  if (monthlyNeeded) ex.result('Monthly amount needed', monthlyNeeded, { note: `To reach the target by ${goal.targetDate}` });
  else if (!goal.targetDate) ex.assume('No target date, so no monthly amount is calculated');
  if (averageMonthlyVerified) ex.result('Recent verified pace (monthly)', averageMonthlyVerified, { note: `Over the last ${paceMonths} months` });
  if (goal.targetDate && projectedCompletionOn && projectedCompletionOn > goal.targetDate && !achieved) {
    ex.assume(`At the recent pace the goal completes around ${projectedCompletionOn}, after its target date ${goal.targetDate}`);
  }
  ex.summary(`${goal.name}: ${fundedVerified.amount} of ${goal.target.amount} ${currency} saved (${decString(D.max(0, D.min(1, ratio)).times(100), 1, 'down')}%).`);

  return {
    goal: {
      ...goal,
      fundedVerified,
      fundedPlanned,
      progress,
      monthlyNeeded,
      status,
      travel: goal.travel ? { ...goal.travel } : null,
      linkedAccountIds: [...goal.linkedAccountIds],
    },
    projectedCompletionOn,
    plannedCompletionOn,
    averageMonthlyVerified,
    planned: plannedList,
    explanation: ex.build(),
  };
}

export interface GoalQueueItem {
  id: string;
  name: string;
  /** Amount still to save. */
  remaining: Money;
  /** Lower numbers are funded first. */
  priority: number;
}

/**
 * Projects when each goal completes if `monthlyCapacity` is saved at each month-end after `asOf` and allocated
 * to goals in priority order. `drains` (for example purchase instalments) dated from `asOf` onwards consume
 * capacity in the month they fall due; a drain larger than the month's capacity carries forward. Goals that never complete within
 * `maxMonths` get null.
 */
export function projectGoalCompletions(
  goals: readonly GoalQueueItem[],
  monthlyCapacity: Money,
  asOf: IsoDate,
  drains: ReadonlyArray<{ date: IsoDate; amount: Money }> = [],
  maxMonths = 600,
): Map<string, IsoDate | null> {
  const currency = monthlyCapacity.currency;
  const ordered = [...goals].sort((a, b) => a.priority - b.priority || compareStrings(a.id, b.id));
  const remaining = new Map<string, Dec>();
  const result = new Map<string, IsoDate | null>();
  for (const d of drains) if (d.amount.currency !== currency) throw new PlanningError(`Drains must be in ${currency}`);
  for (const g of ordered) {
    if (g.remaining.currency !== currency) throw new PlanningError(`Goal ${g.name} remaining must be in ${currency}`);
    const r = dec(g.remaining.amount);
    if (r.greaterThan(0)) remaining.set(g.id, r);
    else result.set(g.id, asOf);
  }
  const capacity = dec(monthlyCapacity.amount);
  let carried = new D(0);
  let previous = asOf;
  for (let k = 1; k <= maxMonths && remaining.size > 0; k += 1) {
    const monthEnd = addMonths(asOf, k);
    const drained = drains
      .filter((d) => (k === 1 ? d.date >= previous : d.date > previous) && d.date <= monthEnd)
      .reduce((acc, d) => acc.plus(dec(d.amount.amount)), new D(0));
    let available = capacity.minus(drained).plus(carried);
    carried = new D(0);
    if (available.isNegative()) {
      carried = available;
      available = new D(0);
    }
    for (const g of ordered) {
      const need = remaining.get(g.id);
      if (need === undefined || !available.greaterThan(0)) continue;
      const used = D.min(need, available);
      available = available.minus(used);
      const left = need.minus(used);
      if (left.greaterThan(0)) remaining.set(g.id, left);
      else {
        remaining.delete(g.id);
        result.set(g.id, monthEnd);
      }
    }
    previous = monthEnd;
  }
  for (const id of remaining.keys()) result.set(id, null);
  return result;
}

export function remainingFor(goal: Pick<Goal, 'target' | 'fundedVerified'>): Money {
  const left = dec(goal.target.amount).minus(dec(goal.fundedVerified.amount));
  return left.greaterThan(0) ? roundToCurrency(money(left, goal.target.currency)) : zero(goal.target.currency);
}
