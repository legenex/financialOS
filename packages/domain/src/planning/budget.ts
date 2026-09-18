/**
 * Budget actuals: plan vs actual per category for a period.
 *
 * Only consumption-type natures count as spending (default: consumption and fees). Split lines are honoured,
 * refunds net against their category, and transfers, investment, property, third-party and income flows are
 * excluded. Envelopes with rollover carry the previous period's remaining amount (positive or negative).
 * Budgets are virtual: they never move money between banks or accounts.
 */
import type { Budget, BudgetLine, Explanation, Money, SplitLine, TransactionNature } from '@financialos/contracts';
import { addMonths, type IsoDate } from '../dates';
import type { FxTable } from '../fx';
import { D, dec, money, roundToCurrency, zero, type Dec } from '../money';
import { ExplanationBuilder } from './explain-local';
import { compareStrings, convertOrNull, PlanningError } from './shared';

export const BUDGET_NOTE =
  'Budgets and envelopes are a plan for your money. Virtual envelopes do not move money between banks or accounts; the money stays where it is until you move it yourself.';

export const DEFAULT_SPENDING_NATURES: readonly TransactionNature[] = ['consumption', 'fee'];

export interface BudgetLineDefinition {
  id: string;
  categoryId: string;
  categoryName: string;
  kind: BudgetLine['kind'];
  planned: Money;
  rollover: boolean;
}

export interface BudgetTransaction {
  id: string;
  date: IsoDate;
  /** Signed amount: negative = money out. */
  amount: Money;
  nature: TransactionNature;
  categoryId: string | null;
  status?: 'pending' | 'posted' | 'reversed' | 'superseded';
  /** Split lines use the same sign convention as the transaction and should add up to it. */
  splits?: ReadonlyArray<Pick<SplitLine, 'amount' | 'categoryId' | 'nature'>> | null;
  /** Whose money it was. Undefined = the budget's entity; null = unconfirmed. */
  economicOwnerEntityId?: string | null;
  description?: string;
}

export interface BudgetComputationInput {
  id: string;
  name: string;
  entityId: string;
  currency: string;
  period: { start: IsoDate; end: IsoDate; label: string };
  lines: readonly BudgetLineDefinition[];
  transactions: readonly BudgetTransaction[];
  /**
   * Remaining amounts carried from the previous period, by category. `undefined`/`null` means this is the
   * first budget period (nothing to carry). A null `remaining` means the previous figure is unknown.
   */
  previousRemaining?: ReadonlyArray<{ categoryId: string; remaining: Money | null }> | null;
  /** Category tree (child → parent) so spending in sub-categories rolls up to a budgeted ancestor. */
  categoryParents?: Readonly<Record<string, string | null>>;
  spendingNatures?: readonly TransactionNature[];
  /** False when the period's transaction history is known to be incomplete. */
  coverageComplete?: boolean;
  fx: FxTable;
}

export interface BudgetComputation {
  budget: Budget;
  /** Spending in categories that have no budget line. */
  unbudgeted: Array<{ categoryId: string; amount: Money }>;
  /** Totals of flows that are not spending, by nature. */
  excludedByNature: Array<{ nature: TransactionNature; count: number }>;
  explanation: Explanation;
}

interface Part {
  amount: Dec;
  categoryId: string | null;
  nature: TransactionNature;
}

function partsOf(tx: BudgetTransaction, ex: ExplanationBuilder): Part[] {
  const total = dec(tx.amount.amount);
  if (!tx.splits || tx.splits.length === 0) return [{ amount: total, categoryId: tx.categoryId, nature: tx.nature }];
  const parts: Part[] = tx.splits.map((s) => ({ amount: dec(s.amount), categoryId: s.categoryId, nature: s.nature }));
  const remainder = total.minus(parts.reduce((acc, p) => acc.plus(p.amount), new D(0)));
  if (!remainder.isZero()) {
    parts.push({ amount: remainder, categoryId: null, nature: 'unknown' });
    ex.missing(`Split lines of ${tx.description ?? tx.id} do not add up to the transaction; the difference is treated as unclassified`, {
      value: money(remainder, tx.amount.currency),
      links: [{ kind: 'transaction', id: tx.id, label: tx.description ?? 'Transaction' }],
    });
  }
  return parts;
}

/**
 * Monthly amount needed to reach `target` by `targetDate`, assuming one contribution now and one on the same
 * day of each following month up to and including the target date. Rounded up to the currency's minor units.
 * Null when the target date or the saved amount is unknown.
 */
export function sinkingFundMonthlyAmount(target: Money, saved: Money | null, targetDate: IsoDate | null, asOf: IsoDate): Money | null {
  if (targetDate === null || saved === null) return null;
  if (saved.currency !== target.currency) throw new PlanningError('Saved amount must be in the target currency');
  const remaining = dec(target.amount).minus(dec(saved.amount));
  if (!remaining.greaterThan(0)) return zero(target.currency);
  const count = Math.max(1, contributionsUntil(asOf, targetDate));
  return roundToCurrency(money(remaining.dividedBy(count), target.currency), 'up');
}

/** Number of monthly contribution dates (asOf, asOf + 1 month, …) on or before `targetDate`. */
export function contributionsUntil(asOf: IsoDate, targetDate: IsoDate): number {
  let contributions = 0;
  while (contributions < 1200 && addMonths(asOf, contributions) <= targetDate) contributions += 1;
  return contributions;
}

export function computeBudget(input: BudgetComputationInput): BudgetComputation {
  const { currency, period } = input;
  if (period.end < period.start) throw new PlanningError('Budget period ends before it starts');
  const spendingNatures = new Set(input.spendingNatures ?? DEFAULT_SPENDING_NATURES);
  const ex = new ExplanationBuilder(
    '',
    'actual = spending in the category (including sub-categories and split lines) − refunds; remaining = planned + carried in − actual',
  );
  const lineByCategory = new Map<string, BudgetLineDefinition>();
  for (const line of input.lines) {
    if (line.planned.currency !== currency) throw new PlanningError(`Budget line ${line.categoryName} must be planned in ${currency}`);
    if (lineByCategory.has(line.categoryId)) throw new PlanningError(`Duplicate budget line for category ${line.categoryName}`);
    lineByCategory.set(line.categoryId, line);
  }
  const resolveLine = (categoryId: string): BudgetLineDefinition | null => {
    const seen = new Set<string>();
    let current: string | null | undefined = categoryId;
    while (current && !seen.has(current)) {
      const line = lineByCategory.get(current);
      if (line) return line;
      seen.add(current);
      current = input.categoryParents?.[current];
    }
    return null;
  };

  const actuals = new Map<string, Dec>();
  const unknownActual = new Set<string>();
  const unbudgeted = new Map<string, Dec>();
  let unclassified = new D(0);
  let unclassifiedUnknown = false;
  let unclassifiedCount = 0;
  const excluded = new Map<TransactionNature, number>();
  let unassignedRefunds = new D(0);
  let otherOwner = 0;

  for (const tx of input.transactions) {
    if (tx.status === 'reversed' || tx.status === 'superseded') continue;
    if (tx.date < period.start || tx.date > period.end) continue;
    if (tx.economicOwnerEntityId !== undefined && tx.economicOwnerEntityId !== null && tx.economicOwnerEntityId !== input.entityId) {
      otherOwner += 1;
      continue;
    }
    const ownerUnconfirmed = tx.economicOwnerEntityId === null;
    const link = { kind: 'transaction' as const, id: tx.id, label: tx.description ?? 'Transaction' };
    const converted = convertOrNull(tx.amount, currency, tx.date, input.fx, { method: 'historical' });
    const rate = converted.value === null ? null : converted.fx ? dec(converted.fx.rate) : new D(1);
    if (converted.value === null) ex.missing(`${tx.description ?? tx.id}: ${converted.reason}`, { value: tx.amount, links: [link] });
    for (const part of partsOf(tx, ex)) {
      const isSpendingNature = spendingNatures.has(part.nature);
      const isRefund = part.nature === 'refund';
      if (!isSpendingNature && !isRefund && part.nature !== 'unknown') {
        excluded.set(part.nature, (excluded.get(part.nature) ?? 0) + 1);
        continue;
      }
      // Unclassified: unknown nature, or spending whose owner is not confirmed yet.
      const isUnknown = part.nature === 'unknown' || ownerUnconfirmed;
      const value = rate === null ? null : roundToCurrency(money(part.amount.times(rate), currency));
      // Spending is positive in the budget; money coming back (refunds, merchant credits) is negative.
      const spend = value === null ? null : dec(value.amount).negated();
      if (isUnknown || part.categoryId === null) {
        if (isRefund && spend !== null && spend.isNegative()) {
          unassignedRefunds = unassignedRefunds.plus(spend.negated());
          continue;
        }
        if (spend !== null && !spend.greaterThan(0)) continue;
        unclassifiedCount += 1;
        if (spend === null) unclassifiedUnknown = true;
        else unclassified = unclassified.plus(spend);
        continue;
      }
      const line = resolveLine(part.categoryId);
      if (!line) {
        if (spend !== null) unbudgeted.set(part.categoryId, (unbudgeted.get(part.categoryId) ?? new D(0)).plus(spend));
        continue;
      }
      if (spend === null) {
        unknownActual.add(line.id);
        continue;
      }
      actuals.set(line.id, (actuals.get(line.id) ?? new D(0)).plus(spend));
    }
  }

  const previous = input.previousRemaining ?? null;
  if (previous === null && input.lines.some((l) => l.rollover)) ex.assume('This is the first budget period, so nothing is carried in');
  const lines: BudgetLine[] = input.lines.map((def) => {
    let carriedIn: Money | null = null;
    if (def.rollover) {
      if (previous === null) carriedIn = zero(currency);
      else {
        const prev = previous.find((p) => p.categoryId === def.categoryId);
        if (!prev) carriedIn = zero(currency);
        else if (prev.remaining === null) {
          carriedIn = null;
          ex.missing(`${def.categoryName}: last period's remaining amount is unknown, so the carry-over is unknown`);
        } else {
          if (prev.remaining.currency !== currency) throw new PlanningError(`Carried amount for ${def.categoryName} must be in ${currency}`);
          carriedIn = prev.remaining;
        }
      }
    }
    const actual = unknownActual.has(def.id) ? null : roundToCurrency(money(actuals.get(def.id) ?? new D(0), currency));
    if (actual === null) ex.missing(`${def.categoryName}: some spending could not be converted, so the actual is unknown`);
    const remaining =
      actual === null || (def.rollover && carriedIn === null)
        ? null
        : roundToCurrency(money(dec(def.planned.amount).plus(carriedIn ? dec(carriedIn.amount) : 0).minus(dec(actual.amount)), currency));
    const note = def.kind === 'envelope' || def.rollover ? 'Virtual envelope: no money is moved' : null;
    ex.input(`${def.categoryName}: planned`, def.planned, { note, links: [] });
    if (carriedIn && !dec(carriedIn.amount).isZero()) ex.added(`${def.categoryName}: carried in`, carriedIn);
    if (actual) ex.subtracted(`${def.categoryName}: actual`, actual);
    return {
      id: def.id,
      categoryId: def.categoryId,
      categoryName: def.categoryName,
      kind: def.kind,
      planned: def.planned,
      actual,
      remaining,
      rollover: def.rollover,
      carriedIn,
    };
  });

  const sumOrNull = (values: Array<Money | null>): Money | null =>
    values.some((v) => v === null) ? null : roundToCurrency(money(values.reduce((acc, v) => acc.plus(dec(v!.amount)), new D(0)), currency));
  const totals = {
    planned: roundToCurrency(money(lines.reduce((acc, l) => acc.plus(dec(l.planned.amount)), new D(0)), currency)),
    actual: sumOrNull(lines.map((l) => l.actual)),
    remaining: sumOrNull(lines.map((l) => l.remaining)),
  };

  const unclassifiedSpending = unclassifiedUnknown ? null : roundToCurrency(money(unclassified, currency));
  if (unclassifiedCount > 0) {
    ex.missing(`${unclassifiedCount} spending item${unclassifiedCount === 1 ? '' : 's'} not yet classified`, { value: unclassifiedSpending });
  }
  const unbudgetedList = [...unbudgeted.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([categoryId, amount]) => ({ categoryId, amount: roundToCurrency(money(amount, currency)) }));
  for (const u of unbudgetedList) ex.excluded(`Spending in a category without a budget line (${u.categoryId})`, u.amount, { note: 'Not part of any line' });
  if (!unassignedRefunds.isZero()) ex.excluded('Refunds without a category', roundToCurrency(money(unassignedRefunds, currency)), { note: 'Classify them to net them against a line' });
  if (otherOwner > 0) ex.assume(`${otherOwner} transactions belonging to other owners were left out`);
  const excludedByNature = [...excluded.entries()].sort((a, b) => compareStrings(a[0], b[0])).map(([nature, count]) => ({ nature, count }));
  if (excludedByNature.length > 0) {
    ex.assume(`Not spending and excluded: ${excludedByNature.map((e) => `${e.count} ${e.nature.replace(/_/g, ' ')}`).join(', ')}`);
  }
  if (input.coverageComplete === false) ex.missing('Transaction history for this period is incomplete');

  const provisional = unclassifiedCount > 0 || unknownActual.size > 0 || lines.some((l) => l.remaining === null) || input.coverageComplete === false;
  ex.result('Total planned', totals.planned);
  ex.result('Total actual', totals.actual);
  ex.result('Total remaining', totals.remaining);
  ex.summary(
    `${period.label}: ${totals.actual?.amount ?? 'unknown'} of ${totals.planned.amount} ${currency} spent${unclassifiedCount > 0 ? `, plus ${unclassifiedSpending?.amount ?? 'an unknown amount'} not yet classified` : ''}.`,
  );

  const budget: Budget = {
    id: input.id,
    name: input.name,
    entityId: input.entityId,
    currency,
    period,
    lines,
    totals,
    status: provisional ? 'provisional' : 'ok',
    unclassifiedSpending,
    note: BUDGET_NOTE,
  };
  return { budget, unbudgeted: unbudgetedList, excludedByNature, explanation: ex.build() };
}

export function budgetActuals(input: BudgetComputationInput): Budget {
  return computeBudget(input).budget;
}
