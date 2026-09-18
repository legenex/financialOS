import { Budget } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { budgetActuals, BUDGET_NOTE, computeBudget, contributionsUntil, sinkingFundMonthlyAmount, type BudgetComputationInput, type BudgetTransaction } from './budget';
import { PlanningError } from './shared';
import { OWNER_ID, THIRD_PARTY_ID, uid, usd, zar } from './testing';

const GROCERIES = uid(10);
const DINING = uid(11);
const FOOD = uid(12);
const TRAVEL = uid(13);
const UNBUDGETED = uid(14);
const FIXED = uid(15);

let n = 0;
function tx(date: string, amount: string, nature: BudgetTransaction['nature'], categoryId: string | null, extra: Partial<BudgetTransaction> = {}): BudgetTransaction {
  n += 1;
  return { id: uid(1000 + n), date, amount: zar(amount), nature, categoryId, description: `Item ${n}`, ...extra };
}

function input(overrides: Partial<BudgetComputationInput> = {}): BudgetComputationInput {
  return {
    id: uid(1),
    name: 'Household',
    entityId: OWNER_ID,
    currency: 'ZAR',
    period: { start: '2026-03-01', end: '2026-03-31', label: 'March 2026' },
    lines: [
      { id: uid(20), categoryId: FOOD, categoryName: 'Food', kind: 'envelope', planned: zar('5000'), rollover: true },
      { id: uid(21), categoryId: TRAVEL, categoryName: 'Travel', kind: 'sinking_fund', planned: zar('1000'), rollover: true },
      { id: uid(22), categoryId: FIXED, categoryName: 'Insurance', kind: 'fixed', planned: zar('800'), rollover: false },
    ],
    categoryParents: { [GROCERIES]: FOOD, [DINING]: FOOD },
    transactions: [
      tx('2026-03-02', '-1200', 'consumption', GROCERIES),
      tx('2026-03-05', '-300', 'consumption', DINING),
      tx('2026-03-06', '150', 'refund', GROCERIES),
      tx('2026-03-07', '-800', 'consumption', FIXED),
      tx('2026-03-08', '-25', 'fee', FIXED),
      tx('2026-03-09', '-5000', 'transfer_internal', null),
      tx('2026-03-10', '-10000', 'investment_contribution', null),
      tx('2026-03-11', '-900000', 'property_purchase', null),
      tx('2026-03-12', '-700', 'third_party', GROCERIES),
      tx('2026-03-13', '30000', 'salary', null),
      tx('2026-02-28', '-999', 'consumption', GROCERIES),
      tx('2026-04-01', '-999', 'consumption', GROCERIES),
      tx('2026-03-14', '-999', 'consumption', GROCERIES, { status: 'reversed' }),
      tx('2026-03-15', '-450', 'consumption', UNBUDGETED),
    ],
    fx: new FxTable(),
    ...overrides,
  };
}

describe('budget actuals', () => {
  it('counts only consumption-type spending, rolls sub-categories up and nets refunds', () => {
    const computation = computeBudget(input());
    const budget = computation.budget;
    expect(() => Budget.parse(budget)).not.toThrow();
    const food = budget.lines.find((l) => l.categoryId === FOOD)!;
    expect(food.actual).toEqual(zar('1350'));
    expect(food.carriedIn).toEqual(zar('0'));
    expect(food.remaining).toEqual(zar('3650'));
    const insurance = budget.lines.find((l) => l.categoryId === FIXED)!;
    expect(insurance.actual).toEqual(zar('825'));
    expect(insurance.remaining).toEqual(zar('-25'));
    expect(insurance.carriedIn).toBeNull();
    expect(budget.totals).toEqual({ planned: zar('6800'), actual: zar('2175'), remaining: zar('4625') });
    expect(budget.status).toBe('ok');
    expect(budget.unclassifiedSpending).toEqual(zar('0'));
    expect(computation.unbudgeted).toEqual([{ categoryId: UNBUDGETED, amount: zar('450') }]);
    expect(computation.excludedByNature).toEqual([
      { nature: 'investment_contribution', count: 1 },
      { nature: 'property_purchase', count: 1 },
      { nature: 'salary', count: 1 },
      { nature: 'third_party', count: 1 },
      { nature: 'transfer_internal', count: 1 },
    ]);
    expect(computation.explanation.assumptions).toContain('This is the first budget period, so nothing is carried in');
  });

  it('says that virtual envelopes do not move money', () => {
    const budget = budgetActuals(input());
    expect(budget.note).toBe(BUDGET_NOTE);
    expect(budget.note).toMatch(/do not move money between banks/);
  });

  it('honours split lines and treats an unbalanced remainder as unclassified', () => {
    const split = tx('2026-03-20', '-1000', 'consumption', null, {
      splits: [
        { amount: '-600', categoryId: GROCERIES, nature: 'consumption' },
        { amount: '-300', categoryId: TRAVEL, nature: 'consumption' },
        { amount: '-50', categoryId: null, nature: 'transfer_internal' },
      ],
    });
    const computation = computeBudget(input({ transactions: [split] }));
    const lines = computation.budget.lines;
    expect(lines.find((l) => l.categoryId === FOOD)?.actual).toEqual(zar('600'));
    expect(lines.find((l) => l.categoryId === TRAVEL)?.actual).toEqual(zar('300'));
    expect(computation.budget.unclassifiedSpending).toEqual(zar('50'));
    expect(computation.budget.status).toBe('provisional');
    expect(computation.explanation.missing.some((m) => m.startsWith('Split lines of Item'))).toBe(true);
  });

  it('reports unclassified spending separately and marks the budget provisional', () => {
    const computation = computeBudget(
      input({
        transactions: [
          tx('2026-03-02', '-100', 'unknown', null),
          tx('2026-03-03', '-40', 'consumption', null),
          tx('2026-03-04', '500', 'unknown', null),
          tx('2026-03-05', '-60', 'consumption', GROCERIES, { economicOwnerEntityId: null }),
          tx('2026-03-06', '-70', 'transfer_internal', null, { economicOwnerEntityId: null }),
          tx('2026-03-07', '20', 'refund', null),
        ],
      }),
    );
    expect(computation.budget.unclassifiedSpending).toEqual(zar('200'));
    expect(computation.budget.status).toBe('provisional');
    expect(computation.budget.totals.actual).toEqual(zar('0'));
    expect(computation.explanation.missing).toContain('3 spending items not yet classified');
    expect(computation.explanation.items).toContainEqual(expect.objectContaining({ label: 'Refunds without a category', value: zar('20') }));
  });

  it('excludes spending that belongs to another owner', () => {
    const computation = computeBudget(input({ transactions: [tx('2026-03-02', '-100', 'consumption', GROCERIES, { economicOwnerEntityId: THIRD_PARTY_ID })] }));
    expect(computation.budget.totals.actual).toEqual(zar('0'));
    expect(computation.explanation.assumptions).toContain('1 transactions belonging to other owners were left out');
  });

  it('carries the previous remaining into rollover envelopes, including overspending', () => {
    const budget = budgetActuals(
      input({
        previousRemaining: [
          { categoryId: FOOD, remaining: zar('-400') },
          { categoryId: TRAVEL, remaining: zar('2500') },
          { categoryId: FIXED, remaining: zar('99') },
        ],
      }),
    );
    expect(budget.lines.find((l) => l.categoryId === FOOD)).toEqual(expect.objectContaining({ carriedIn: zar('-400'), remaining: zar('3250') }));
    expect(budget.lines.find((l) => l.categoryId === TRAVEL)).toEqual(expect.objectContaining({ carriedIn: zar('2500'), remaining: zar('3500') }));
    expect(budget.lines.find((l) => l.categoryId === FIXED)?.carriedIn).toBeNull();
  });

  it('keeps an unknown carry-over unknown', () => {
    const budget = budgetActuals(input({ previousRemaining: [{ categoryId: FOOD, remaining: null }] }));
    const food = budget.lines.find((l) => l.categoryId === FOOD)!;
    expect(food.carriedIn).toBeNull();
    expect(food.remaining).toBeNull();
    expect(food.actual).toEqual(zar('1350'));
    expect(budget.totals.remaining).toBeNull();
    expect(budget.status).toBe('provisional');
    expect(budget.lines.find((l) => l.categoryId === TRAVEL)?.carriedIn).toEqual(zar('0'));
  });

  it('converts foreign spending at the transaction date and keeps unconvertible actuals unknown', () => {
    const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18.123', asOf: '2026-03-01', source: 'test' }]);
    const foreign = { ...tx('2026-03-03', '-10', 'consumption', TRAVEL), amount: usd('-10.01') };
    const converted = budgetActuals(input({ transactions: [foreign], fx }));
    expect(converted.lines.find((l) => l.categoryId === TRAVEL)?.actual).toEqual(zar('181.41'));
    const missing = computeBudget(input({ transactions: [foreign] }));
    expect(missing.budget.lines.find((l) => l.categoryId === TRAVEL)?.actual).toBeNull();
    expect(missing.budget.totals.actual).toBeNull();
    expect(missing.budget.status).toBe('provisional');
  });

  it('allows custom spending natures and incomplete coverage', () => {
    const budget = budgetActuals(input({ transactions: [tx('2026-03-02', '-300', 'tax', FIXED)], spendingNatures: ['consumption', 'fee', 'tax'], coverageComplete: false }));
    expect(budget.lines.find((l) => l.categoryId === FIXED)?.actual).toEqual(zar('300'));
    expect(budget.status).toBe('provisional');
  });

  it('rejects invalid budgets', () => {
    expect(() => budgetActuals(input({ period: { start: '2026-03-31', end: '2026-03-01', label: 'x' } }))).toThrow(PlanningError);
    expect(() => budgetActuals(input({ lines: [{ id: uid(30), categoryId: FOOD, categoryName: 'Food', kind: 'spending', planned: usd('1'), rollover: false }] }))).toThrow(PlanningError);
    const dup = { id: uid(31), categoryId: FOOD, categoryName: 'Food', kind: 'spending' as const, planned: zar('1'), rollover: false };
    expect(() => budgetActuals(input({ lines: [dup, { ...dup, id: uid(32) }] }))).toThrow(PlanningError);
  });

  it('survives cycles in the category tree', () => {
    const budget = budgetActuals(input({ categoryParents: { [uid(40)]: uid(41), [uid(41)]: uid(40) }, transactions: [tx('2026-03-02', '-5', 'consumption', uid(40))] }));
    expect(budget.totals.actual).toEqual(zar('0'));
  });
});

describe('sinking funds', () => {
  it('spreads the remaining amount over the monthly contributions left, rounding up', () => {
    expect(contributionsUntil('2026-03-10', '2026-06-01')).toBe(3);
    expect(contributionsUntil('2026-03-10', '2026-06-10')).toBe(4);
    expect(sinkingFundMonthlyAmount(zar('12000'), zar('2000'), '2026-06-10', '2026-03-10')).toEqual(zar('2500'));
    expect(sinkingFundMonthlyAmount(zar('1000'), zar('0'), '2026-06-01', '2026-03-10')).toEqual(zar('333.34'));
  });

  it('asks for everything now when the date has passed and nothing when funded', () => {
    expect(sinkingFundMonthlyAmount(zar('1000'), zar('400'), '2026-01-01', '2026-03-10')).toEqual(zar('600'));
    expect(sinkingFundMonthlyAmount(zar('1000'), zar('1000'), '2026-06-01', '2026-03-10')).toEqual(zar('0'));
  });

  it('returns null without a date or a known saved amount', () => {
    expect(sinkingFundMonthlyAmount(zar('1000'), zar('0'), null, '2026-03-10')).toBeNull();
    expect(sinkingFundMonthlyAmount(zar('1000'), null, '2026-06-01', '2026-03-10')).toBeNull();
    expect(() => sinkingFundMonthlyAmount(zar('1000'), usd('1'), '2026-06-01', '2026-03-10')).toThrow(PlanningError);
  });
});
