/**
 * Purchase impact simulator: runs safe-to-spend with and without a simulated purchase (optionally in
 * instalments) and reports the effect on the budget line, protected reserves, dated commitments and goals.
 */
import type { Budget, Goal, Money, PurchaseImpactInput, PurchaseImpactResult } from '@financialos/contracts';
import { addMonths, diffDays, parseIsoDate, type IsoDate } from '../dates';
import { allocate, D, dec, money, roundToCurrency, type Dec } from '../money';
import type { CashFlowItem } from './cashflow';
import { ExplanationBuilder } from './explain-local';
import { projectGoalCompletions, remainingFor } from './goals';
import { computeSafeToSpend, type SafeToSpendComputation, type SafeToSpendInput } from './safeToSpend';
import { convertOrNull, PlanningError, worstStatus } from './shared';

export interface PurchaseImpactContext {
  safeToSpend: SafeToSpendInput;
  /** Current budget (for the line matching the purchase category). */
  budget?: Pick<Budget, 'currency' | 'period' | 'lines'> | null;
  goals?: ReadonlyArray<Pick<Goal, 'id' | 'name' | 'target' | 'fundedVerified' | 'priority' | 'status'>>;
  /** Money available for goals each month. Null = unknown. */
  monthlyGoalCapacity?: Money | null;
  /** "Tight" when safe-to-spend after is below this share of safe-to-spend before (default 0.1). */
  tightRatio?: string;
  /** "Tight" when safe-to-spend after is below this amount. */
  tightBuffer?: Money | null;
}

export interface PurchaseImpactComputation {
  result: PurchaseImpactResult;
  before: SafeToSpendComputation;
  after: SafeToSpendComputation | null;
  instalments: CashFlowItem[];
}

export function purchaseInstalments(purchase: PurchaseImpactInput): CashFlowItem[] {
  const count = purchase.installments ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new PlanningError('Instalments must be between 1 and 60');
  const total = roundToCurrency(money(purchase.amount, purchase.currency));
  if (!dec(total.amount).greaterThan(0)) throw new PlanningError('Purchase amount must be positive');
  const parts = allocate(total, Array.from({ length: count }, () => '1'));
  const day = parseIsoDate(purchase.date).d;
  return parts.map((part, i) => ({
    id: `purchase:${i + 1}`,
    date: addMonths(purchase.date, i, day),
    label: count === 1 ? `Simulated purchase: ${purchase.label}` : `Simulated purchase: ${purchase.label} (${i + 1}/${count})`,
    direction: 'out' as const,
    amount: part,
    certainty: 'committed' as const,
    probability: null,
    source: 'purchase' as const,
    kind: 'purchase',
    entityId: null,
    recurringItemId: null,
    links: [],
  }));
}

export function simulatePurchase(purchase: PurchaseImpactInput, context: PurchaseImpactContext): PurchaseImpactComputation {
  const base = context.safeToSpend;
  const currency = base.settings.budgetCurrency;
  const instalments = purchaseInstalments(purchase);
  const ex = new ExplanationBuilder(
    '',
    'impact = safe to spend without the purchase − safe to spend with it; each instalment is a dated outflow applied once',
  );
  for (const item of instalments) ex.input(`${item.label} on ${item.date}`, item.amount);

  const before = computeSafeToSpend(base);
  const empty = {
    safeToSpendBefore: null,
    safeToSpendAfter: null,
    budgetLineBefore: null,
    budgetLineAfter: null,
    reserveShortfallAfter: null,
    commitmentsAtRisk: [],
    goalsDelayed: [],
  };
  if (before.result.status === 'insufficient_data') {
    ex.missing('Safe to spend is not available, so the impact cannot be judged');
    ex.summary('The purchase impact is unknown until balances are available.');
    return { result: { ...empty, status: 'insufficient_data', verdict: 'unknown', explanation: ex.build() }, before, after: null, instalments };
  }

  const after = computeSafeToSpend({ ...base, extraFlows: [...(base.extraFlows ?? []), ...instalments] });
  const beforeAmount = before.result.amount!;
  const afterAmount = after.result.amount!;
  ex.result('Safe to spend before', beforeAmount);
  ex.result('Safe to spend after', afterAmount);
  const inHorizon = instalments.filter((i) => i.date <= after.result.horizon.to);
  if (inHorizon.length < instalments.length) {
    ex.assume(`${instalments.length - inHorizon.length} instalment(s) fall after the safe-to-spend horizon (${after.result.horizon.to}) and are not reflected in it`);
  }

  // Budget line.
  let budgetLineBefore: Money | null = null;
  let budgetLineAfter: Money | null = null;
  const line = purchase.categoryId && context.budget ? context.budget.lines.find((l) => l.categoryId === purchase.categoryId) : undefined;
  if (context.budget && line) {
    budgetLineBefore = line.remaining;
    const period = context.budget.period;
    let inPeriod: Dec | null = new D(0);
    for (const item of instalments.filter((i) => i.date >= period.start && i.date <= period.end)) {
      const converted = convertOrNull(item.amount!, context.budget.currency, item.date, base.fx);
      if (converted.value === null) {
        ex.missing(`Instalment on ${item.date}: ${converted.reason}`, { value: item.amount });
        inPeriod = null;
        break;
      }
      inPeriod = inPeriod.plus(dec(converted.value.amount));
    }
    budgetLineAfter = line.remaining === null || inPeriod === null ? null : roundToCurrency(money(dec(line.remaining.amount).minus(inPeriod), context.budget.currency));
    ex.result(`${line.categoryName} budget remaining after`, budgetLineAfter, { note: budgetLineBefore ? `Before: ${budgetLineBefore.amount}` : null });
  } else if (purchase.categoryId) {
    ex.assume('No budget line matches the purchase category');
  }

  // Reserves.
  const reserves = dec(after.result.protectedReserves.amount);
  const lowestAfter = after.result.lowestProjectedBalance ? dec(after.result.lowestProjectedBalance.amount) : null;
  const reserveShortfallAfter =
    lowestAfter === null ? null : roundToCurrency(money(D.min(reserves, D.max(0, reserves.minus(D.max(0, lowestAfter)))), currency));
  if (reserveShortfallAfter && dec(reserveShortfallAfter.amount).greaterThan(0)) {
    ex.result('Protected reserves that would be used', reserveShortfallAfter);
  }

  // Commitments at risk: outflows (other than the purchase) that the projected balance cannot cover.
  const commitmentsAtRisk: PurchaseImpactResult['commitmentsAtRisk'] = [];
  for (const event of after.projection?.events ?? []) {
    if (event.direction !== 'out' || event.source === 'purchase') continue;
    if (!dec(event.balanceAfter.amount).isNegative()) continue;
    commitmentsAtRisk.push({ label: event.label, dueOn: event.date, amount: event.amount });
    ex.add(`At risk: ${event.label} on ${event.date}`, event.amount, 'result', { note: 'The projected balance would be negative after this payment', links: event.links });
  }

  // Goals.
  const goalsDelayed: PurchaseImpactResult['goalsDelayed'] = [];
  const activeGoals = (context.goals ?? []).filter((g) => g.status === 'active' && dec(remainingFor(g).amount).greaterThan(0));
  const capacity = context.monthlyGoalCapacity ?? null;
  if (activeGoals.length > 0 && capacity === null) {
    ex.missing('Monthly goal capacity is unknown, so goal delays could not be calculated');
  } else if (activeGoals.length > 0 && capacity !== null) {
    const queue = [];
    for (const g of activeGoals) {
      const remaining = remainingFor(g);
      const converted = convertOrNull(remaining, capacity.currency, base.today, base.fx);
      if (converted.value === null) {
        ex.missing(`${g.name}: ${converted.reason}`);
        continue;
      }
      queue.push({ id: g.id, name: g.name, remaining: converted.value, priority: g.priority });
    }
    const drains: Array<{ date: IsoDate; amount: Money }> = [];
    let drainsKnown = true;
    for (const item of instalments) {
      const converted = convertOrNull(item.amount!, capacity.currency, base.today, base.fx);
      if (converted.value === null) {
        drainsKnown = false;
        ex.missing(`Instalment on ${item.date} could not be converted to ${capacity.currency} for the goal projection`);
        break;
      }
      drains.push({ date: item.date, amount: converted.value });
    }
    if (drainsKnown) {
      const without = projectGoalCompletions(queue, capacity, base.today);
      const withPurchase = projectGoalCompletions(queue, capacity, base.today, drains);
      for (const g of queue) {
        const a = without.get(g.id) ?? null;
        const b = withPurchase.get(g.id) ?? null;
        if (a === b) continue;
        const delayDays = a !== null && b !== null ? diffDays(a, b) : null;
        goalsDelayed.push({ goalId: g.id, name: g.name, delayDays });
        ex.add(`${g.name} delayed`, null, 'result', {
          note: delayDays === null ? `Completion moves from ${a ?? 'never'} to ${b ?? 'beyond the projection'}` : `About ${delayDays} days later (${a} → ${b})`,
          links: [{ kind: 'goal', id: g.id, label: g.name }],
        });
      }
      ex.assume(`Goals are funded in priority order from ${capacity.amount} ${capacity.currency} a month`);
    }
  }

  // Verdict.
  const beforeShortfall = before.result.shortfall ? dec(before.result.shortfall.amount) : new D(0);
  const afterShortfall = after.result.shortfall ? dec(after.result.shortfall.amount) : new D(0);
  const ratio = dec(context.tightRatio ?? '0.1');
  const reasons: string[] = [];
  let verdict: PurchaseImpactResult['verdict'];
  if (inHorizon.length === 0) {
    verdict = 'unknown';
    reasons.push('the purchase falls after the safe-to-spend horizon');
  } else if (afterShortfall.greaterThan(beforeShortfall)) {
    verdict = 'does_not_fit';
    reasons.push('it would push projected cash below protected reserves or below zero');
  } else {
    const afterValue = dec(afterAmount.amount);
    const tightByRatio = afterValue.lessThan(dec(beforeAmount.amount).times(ratio));
    let tightByBuffer = false;
    if (context.tightBuffer) {
      const buffer = convertOrNull(context.tightBuffer, currency, base.today, base.fx);
      if (buffer.value) tightByBuffer = afterValue.lessThan(dec(buffer.value.amount));
      else ex.missing(`The tight buffer could not be converted to ${currency}`);
    }
    const overBudget = budgetLineAfter !== null && dec(budgetLineAfter.amount).isNegative();
    if (tightByRatio) reasons.push(`less than ${decStringPercent(ratio)} of safe to spend would remain`);
    if (tightByBuffer) reasons.push('safe to spend would fall below your buffer');
    if (overBudget) reasons.push('the budget line would be overspent');
    verdict = tightByRatio || tightByBuffer || overBudget ? 'tight' : 'fits';
  }
  const status = worstStatus(before.result.status, after.result.status);
  const goalNote = goalsDelayed.length > 0 ? ` It would delay ${goalsDelayed.length} goal${goalsDelayed.length === 1 ? '' : 's'}.` : '';
  ex.summary(
    `Verdict: ${verdict.replace(/_/g, ' ')}${reasons.length > 0 ? ` because ${reasons.join('; ')}` : ''}. Safe to spend goes from ${beforeAmount.amount} to ${afterAmount.amount} ${currency}.${goalNote}`,
  );

  return {
    result: {
      status,
      safeToSpendBefore: beforeAmount,
      safeToSpendAfter: afterAmount,
      budgetLineBefore,
      budgetLineAfter,
      reserveShortfallAfter,
      commitmentsAtRisk,
      goalsDelayed,
      verdict,
      explanation: ex.build(),
    },
    before,
    after,
    instalments,
  };
}

function decStringPercent(ratio: Dec): string {
  return `${ratio.times(100).toDecimalPlaces(2).toFixed()}%`;
}

export function purchaseImpact(purchase: PurchaseImpactInput, context: PurchaseImpactContext): PurchaseImpactResult {
  return simulatePurchase(purchase, context).result;
}
