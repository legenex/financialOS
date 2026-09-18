/**
 * Read model for planning records: recurring items, obligations, receivables/payables, goals and
 * their contributions, budgets, scenarios, reward products and tax facts.
 *
 * Every derived figure (goal progress, budget actuals, cash-flow expansion) is produced by
 * @financialos/domain from the rows loaded here.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  Budget,
  Goal,
  GoalContribution,
  Obligation,
  ReceivablePayable,
  RecurringItem,
  RewardProduct,
  Scenario,
  ScenarioAdjustment,
  TaxFact,
} from '@financialos/contracts';
import {
  budgetLines,
  budgets,
  categories as categoriesTable,
  goalContributions,
  goals as goalsTable,
  obligations as obligationsTable,
  receivablesPayables,
  recurringItems,
  rewardProducts,
  scenarioVersions,
  scenarios as scenariosTable,
  type taxFacts,
  type DbOrTx,
} from '@financialos/db';
import {
  budgetActuals,
  computeGoalProgress,
  type BudgetComputationInput,
  type BudgetLineDefinition,
  type BudgetTransaction,
  type FxTable,
  type GoalContributionRecord,
  type GoalDefinition,
  type IsoDate,
  type ObligationFlowSource,
  type ReceivablePayableFlowSource,
  type RecurringFlowSource,
} from '@financialos/domain';
import { iso, maybeMoneyOf, normalizeDecimal } from './common';

// ---------------------------------------------------------------------------------------------
// Recurring items
// ---------------------------------------------------------------------------------------------

export type RecurringRow = typeof recurringItems.$inferSelect;

export function recurringView(row: RecurringRow): RecurringItem {
  return {
    id: row.id,
    name: row.name,
    entityId: row.entityId,
    accountId: row.accountId,
    counterparty: row.counterpartyName,
    kind: row.kind,
    direction: row.direction,
    amount: maybeMoneyOf(row.amount, row.currency),
    amountIsEstimate: row.amountIsEstimate,
    cadence: row.cadence,
    dayOfMonth: row.dayOfMonth,
    nextDueOn: row.nextDueOn,
    status: row.status,
    detected: row.detected,
    confirmed: row.confirmed,
    internalCounterpartyEntityId: row.internalCounterpartyEntityId,
    lastSeenOn: row.lastSeenOn,
    links: row.accountId ? [{ kind: 'account', id: row.accountId, label: row.name }] : [],
  };
}

export async function listRecurringRows(db: DbOrTx, options: { entityIds?: readonly string[]; status?: RecurringRow['status'] } = {}): Promise<RecurringRow[]> {
  const conditions = [];
  if (options.entityIds) {
    if (options.entityIds.length === 0) return [];
    conditions.push(inArray(recurringItems.entityId, [...options.entityIds]));
  }
  if (options.status) conditions.push(eq(recurringItems.status, options.status));
  return db
    .select()
    .from(recurringItems)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(recurringItems.nextDueOn), asc(recurringItems.name))
    .limit(1000);
}

export function recurringFlowSources(rows: readonly RecurringRow[]): RecurringFlowSource[] {
  return rows.map(recurringView);
}

// ---------------------------------------------------------------------------------------------
// Obligations
// ---------------------------------------------------------------------------------------------

export type ObligationRow = typeof obligationsTable.$inferSelect;

export function obligationView(row: ObligationRow): Obligation {
  return {
    id: row.id,
    entityId: row.entityId,
    dueOn: row.dueOn,
    amount: maybeMoneyOf(row.amount, row.currency),
    label: row.label,
    kind: row.kind,
    status: row.status,
  };
}

export async function listObligationRows(
  db: DbOrTx,
  options: { entityIds?: readonly string[]; from?: IsoDate; to?: IsoDate; status?: ObligationRow['status'] } = {},
): Promise<ObligationRow[]> {
  const conditions = [];
  if (options.entityIds) {
    if (options.entityIds.length === 0) return [];
    conditions.push(inArray(obligationsTable.entityId, [...options.entityIds]));
  }
  if (options.from) conditions.push(gte(obligationsTable.dueOn, options.from));
  if (options.to) conditions.push(lte(obligationsTable.dueOn, options.to));
  if (options.status) conditions.push(eq(obligationsTable.status, options.status));
  return db
    .select()
    .from(obligationsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(obligationsTable.dueOn))
    .limit(2000);
}

export function obligationFlowSources(rows: readonly ObligationRow[]): ObligationFlowSource[] {
  return rows.map((row) => ({ ...obligationView(row), recurringItemId: row.recurringItemId }));
}

// ---------------------------------------------------------------------------------------------
// Receivables and payables
// ---------------------------------------------------------------------------------------------

export type ReceivableRow = typeof receivablesPayables.$inferSelect;

export function receivableView(row: ReceivableRow): ReceivablePayable {
  return {
    id: row.id,
    entityId: row.entityId,
    kind: row.kind,
    counterparty: row.counterpartyName,
    intercompanyEntityId: row.intercompanyEntityId,
    reference: row.reference,
    amount: { amount: normalizeDecimal(row.amount), currency: row.currency },
    outstanding: { amount: normalizeDecimal(row.outstanding), currency: row.currency },
    issuedOn: row.issuedOn,
    dueOn: row.dueOn,
    expectedOn: row.expectedOn,
    probability: normalizeDecimal(row.probability),
    status: row.status,
    source: row.source,
    category: row.category,
  };
}

export async function listReceivableRows(db: DbOrTx, options: { entityIds?: readonly string[]; kind?: 'receivable' | 'payable' } = {}): Promise<ReceivableRow[]> {
  const conditions = [];
  if (options.entityIds) {
    if (options.entityIds.length === 0) return [];
    conditions.push(inArray(receivablesPayables.entityId, [...options.entityIds]));
  }
  if (options.kind) conditions.push(eq(receivablesPayables.kind, options.kind));
  return db
    .select()
    .from(receivablesPayables)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(receivablesPayables.expectedOn), asc(receivablesPayables.dueOn))
    .limit(2000);
}

export function receivableFlowSources(rows: readonly ReceivableRow[]): ReceivablePayableFlowSource[] {
  return rows.map(receivableView);
}

// ---------------------------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------------------------

export type GoalRow = typeof goalsTable.$inferSelect;
export type GoalContributionRow = typeof goalContributions.$inferSelect;

export function goalDefinition(row: GoalRow): GoalDefinition {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    target: { amount: normalizeDecimal(row.targetAmount), currency: row.targetCurrency },
    targetDate: row.targetDate,
    protected: row.protected,
    heldIn: row.heldIn,
    linkedAccountIds: row.linkedAccountIds,
    status: row.status,
    priority: row.priority,
    travel: row.travel ?? null,
  };
}

export function contributionRecord(row: GoalContributionRow): GoalContributionRecord {
  return {
    id: row.id,
    goalId: row.goalId,
    amount: { amount: normalizeDecimal(row.amount), currency: row.currency },
    date: row.contributedOn,
    status: row.status,
    transactionId: row.sourceRecordId,
    note: row.note,
  };
}

export function contributionView(row: GoalContributionRow): GoalContribution {
  return contributionRecord(row);
}

export async function loadGoals(db: DbOrTx, options: { asOf: IsoDate; fx: FxTable; goalIds?: readonly string[]; includeArchived?: boolean }): Promise<Goal[]> {
  const conditions = [];
  if (options.goalIds) {
    if (options.goalIds.length === 0) return [];
    conditions.push(inArray(goalsTable.id, [...options.goalIds]));
  }
  if (!options.includeArchived) conditions.push(isNull(goalsTable.archivedAt));
  const rows = await db
    .select()
    .from(goalsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(goalsTable.priority), asc(goalsTable.name))
    .limit(500);
  if (rows.length === 0) return [];
  const contributions = await db
    .select()
    .from(goalContributions)
    .where(inArray(goalContributions.goalId, rows.map((r) => r.id)))
    .orderBy(asc(goalContributions.contributedOn))
    .limit(10_000);
  const byGoal = new Map<string, GoalContributionRow[]>();
  for (const row of contributions) {
    const list = byGoal.get(row.goalId) ?? [];
    list.push(row);
    byGoal.set(row.goalId, list);
  }
  return rows.map(
    (row) =>
      computeGoalProgress({
        goal: goalDefinition(row),
        contributions: (byGoal.get(row.id) ?? []).map(contributionRecord),
        asOf: options.asOf,
        fx: options.fx,
      }).goal,
  );
}

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------

export type BudgetRow = typeof budgets.$inferSelect;

export interface BudgetPeriod {
  start: IsoDate;
  end: IsoDate;
  label: string;
}

/** The calendar month containing `asOf`, unless the budget stores explicit bounds. */
export function budgetPeriod(row: BudgetRow, asOf: IsoDate): BudgetPeriod {
  if (row.periodStart && row.periodEnd) return { start: row.periodStart, end: row.periodEnd, label: `${row.periodStart} → ${row.periodEnd}` };
  const [year, month] = asOf.split('-');
  const start = `${year}-${month}-01`;
  const endDate = new Date(Date.UTC(Number(year), Number(month), 0));
  return { start, end: endDate.toISOString().slice(0, 10), label: `${year}-${month}` };
}

export async function loadBudget(
  db: DbOrTx,
  row: BudgetRow,
  options: { asOf: IsoDate; fx: FxTable; transactions: readonly BudgetTransaction[]; coverageComplete?: boolean },
): Promise<Budget> {
  const lines = await db
    .select({ line: budgetLines, categoryName: categoriesTable.name })
    .from(budgetLines)
    .innerJoin(categoriesTable, eq(budgetLines.categoryId, categoriesTable.id))
    .where(eq(budgetLines.budgetId, row.id))
    .orderBy(asc(categoriesTable.name));
  const categoryRows = await db.select({ id: categoriesTable.id, parentId: categoriesTable.parentId }).from(categoriesTable).limit(2000);
  const categoryParents: Record<string, string | null> = {};
  for (const c of categoryRows) categoryParents[c.id] = c.parentId;
  const definitions: BudgetLineDefinition[] = lines.map((l) => ({
    id: l.line.id,
    categoryId: l.line.categoryId,
    categoryName: l.categoryName,
    kind: l.line.kind,
    planned: { amount: normalizeDecimal(l.line.planned), currency: row.currency },
    rollover: l.line.rollover,
  }));
  const input: BudgetComputationInput = {
    id: row.id,
    name: row.name,
    entityId: row.entityId,
    currency: row.currency,
    period: budgetPeriod(row, options.asOf),
    lines: definitions,
    transactions: options.transactions,
    categoryParents,
    coverageComplete: options.coverageComplete ?? true,
    fx: options.fx,
  };
  return budgetActuals(input);
}

export async function listBudgetRows(db: DbOrTx, options: { entityIds?: readonly string[] } = {}): Promise<BudgetRow[]> {
  const conditions = [eq(budgets.status, 'active')];
  if (options.entityIds) {
    if (options.entityIds.length === 0) return [];
    conditions.push(inArray(budgets.entityId, [...options.entityIds]));
  }
  return db.select().from(budgets).where(and(...conditions)).orderBy(asc(budgets.name)).limit(200);
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

export interface ScenarioBundle {
  scenario: Scenario;
  adjustments: ScenarioAdjustment[];
}

export async function loadScenario(db: DbOrTx, id: string): Promise<ScenarioBundle | null> {
  const [row] = await db.select().from(scenariosTable).where(eq(scenariosTable.id, id)).limit(1);
  if (!row) return null;
  const [version] = await db
    .select()
    .from(scenarioVersions)
    .where(and(eq(scenarioVersions.scenarioId, id), eq(scenarioVersions.version, row.currentVersion)))
    .limit(1);
  if (!version) return null;
  const adjustments = version.adjustments as unknown as ScenarioAdjustment[];
  return {
    scenario: {
      id: row.id,
      name: version.name,
      description: version.description,
      adjustments,
      version: row.currentVersion,
      archived: row.archived,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    },
    adjustments,
  };
}

export async function listScenarios(db: DbOrTx, includeArchived = false): Promise<Scenario[]> {
  const rows = await db
    .select()
    .from(scenariosTable)
    .where(includeArchived ? undefined : eq(scenariosTable.archived, false))
    .orderBy(desc(scenariosTable.updatedAt))
    .limit(200);
  const out: Scenario[] = [];
  for (const row of rows) {
    const bundle = await loadScenario(db, row.id);
    if (bundle) out.push(bundle.scenario);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rewards and tax facts
// ---------------------------------------------------------------------------------------------

export type RewardRow = typeof rewardProducts.$inferSelect;

export function rewardView(row: RewardRow): RewardProduct {
  return {
    id: row.id,
    name: row.name,
    issuer: row.issuer,
    termsAsOf: row.termsAsOf,
    sourceUrl: row.sourceUrl,
    eligibility: row.eligibility,
    annualFee: row.annualFee !== null && row.annualFeeCurrency !== null ? { amount: normalizeDecimal(row.annualFee), currency: row.annualFeeCurrency } : null,
    earnRate: normalizeDecimal(row.earnRate),
    earnUnit: row.earnUnit,
    pointValue: row.pointValue !== null && row.pointValueCurrency !== null ? { amount: normalizeDecimal(row.pointValue), currency: row.pointValueCurrency } : null,
    fxFeePercent: normalizeDecimal(row.fxFeePercent),
    paymentFeePercent: normalizeDecimal(row.paymentFeePercent),
    notes: row.notes,
  };
}

export async function listRewardRows(db: DbOrTx, ids?: readonly string[]): Promise<RewardRow[]> {
  const conditions = [isNull(rewardProducts.archivedAt)];
  if (ids) {
    if (ids.length === 0) return [];
    conditions.push(inArray(rewardProducts.id, [...ids]));
  }
  return db.select().from(rewardProducts).where(and(...conditions)).orderBy(asc(rewardProducts.name)).limit(200);
}

export function taxFactView(row: typeof taxFacts.$inferSelect): TaxFact {
  return {
    id: row.id,
    jurisdiction: row.jurisdiction,
    topic: row.topic,
    status: row.status,
    value: row.value,
    deadline: row.deadline,
    accountantQuestion: row.accountantQuestion,
    documentIds: row.documentIds,
    updatedAt: iso(row.updatedAt),
  };
}

export { and, asc, desc, eq, inArray, isNull, or, sql };
