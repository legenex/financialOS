/**
 * Plan: budgets, goals and contributions, recurring items, obligations, the purchase-impact
 * simulator, versioned scenarios, reward products and tax facts.
 *
 * Budget actuals, goal progress, purchase impact and reward comparisons are all produced by
 * @financialos/domain from rows loaded through the read-model layer.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  BudgetInput,
  GoalContributionInput,
  GoalInput,
  ObligationInput,
  PurchaseImpactInput,
  RecurringItemInput,
  RewardComparisonInput,
  RewardProduct,
  ScenarioInput,
  TaxFactInput,
  type Budget,
  type Goal,
  type GoalContribution,
  type Obligation,
  type PurchaseImpactResult,
  type RecurringItem,
  type RewardComparisonResult,
  type Scenario,
  type TaxFact,
} from '@financialos/contracts';
import {
  budgetLines,
  budgets,
  goalContributions,
  goals as goalsTable,
  obligations as obligationsTable,
  recurringItems,
  rewardProducts,
  scenarioVersions,
  scenarios as scenariosTable,
  taxFacts,
} from '@financialos/db';
import { compareRewards, purchaseImpact, remainingFor } from '@financialos/domain';
import { errors } from '../../errors';
import { parseBody, parseQuery } from '../../validation';
import { normalizeDecimal, shiftDays } from '../../data/common';
import { buildSafeToSpendInput } from '../../data/finance';
import {
  budgetPeriod,
  contributionView,
  listBudgetRows,
  listObligationRows,
  listRecurringRows,
  listRewardRows,
  listScenarios,
  loadBudget,
  loadGoals,
  loadScenario,
  obligationView,
  recurringView,
  rewardView,
  taxFactView,
} from '../../data/planning';
import { loadClassifiedRows, toBudgetTransactions } from '../../data/transactions';
import { audit, financeBase, loadOne, ownerRoutes, requireUuid } from './_shared';

const BudgetQuery = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), entityId: z.uuid().optional() });
const RecurringQuery = z.object({ status: z.enum(['active', 'paused', 'cancelled', 'suggested']).optional(), entityId: z.uuid().optional() });
const ObligationQuery = z.object({ entityId: z.uuid().optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const RewardProductInput = RewardProduct.omit({ id: true });

export function registerPlanRoutes(app: FastifyInstance): void {
  ownerRoutes(app, (scope) => {
    // --- Budgets ---------------------------------------------------------------------------
    scope.get('/api/budgets', async (req): Promise<{ items: Budget[] }> => {
      const query = parseQuery(BudgetQuery, req.query);
      const base = await financeBase(req);
      const asOf = query.period ? `${query.period}-01` : base.today;
      const rows = await listBudgetRows(req.server.fos.db, query.entityId ? { entityIds: [query.entityId] } : {});
      const items: Budget[] = [];
      for (const row of rows) {
        const period = budgetPeriod(row, asOf);
        const accountIds = base.accounts.filter((b) => b.row.legalEntityId === row.entityId || b.row.economicOwnerEntityId === row.entityId).map((b) => b.row.id);
        const records = accountIds.length > 0 ? await loadClassifiedRows(req.server.fos.db, { accountIds, from: period.start, to: period.end }, 20_000) : [];
        items.push(await loadBudget(req.server.fos.db, row, { asOf, fx: base.fx, transactions: toBudgetTransactions(records) }));
      }
      return { items };
    });

    scope.post('/api/budgets', async (req, reply): Promise<Budget> => {
      const input = parseBody(BudgetInput, req.body);
      const { db } = req.server.fos;
      const base = await financeBase(req);
      const created = await db.transaction(async (tx) => {
        const [row] = await tx.insert(budgets).values({ name: input.name, entityId: input.entityId, currency: input.currency, periodKind: 'monthly' }).returning();
        if (!row) throw new Error('budget insert returned no row');
        if (input.lines.length > 0) {
          await tx.insert(budgetLines).values(input.lines.map((line) => ({ budgetId: row.id, categoryId: line.categoryId, kind: line.kind, planned: line.planned, rollover: line.rollover })));
        }
        return row;
      });
      await audit(req, 'budget.created', { type: 'budget', id: created.id }, `Budget created (${created.name})`, { lines: input.lines.length });
      reply.code(201);
      return loadBudget(db, created, { asOf: base.today, fx: base.fx, transactions: [] });
    });

    scope.put<{ Params: { id: string } }>('/api/budgets/:id', async (req): Promise<Budget> => {
      const id = requireUuid(req.params.id, 'budget_not_found');
      const input = parseBody(BudgetInput, req.body);
      const { db, clock } = req.server.fos;
      const base = await financeBase(req);
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(budgets)
          .set({ name: input.name, entityId: input.entityId, currency: input.currency, updatedAt: clock.now() })
          .where(eq(budgets.id, id))
          .returning();
        if (!updated) throw errors.notFound('budget_not_found', 'Budget not found.');
        await tx.delete(budgetLines).where(eq(budgetLines.budgetId, id));
        if (input.lines.length > 0) {
          await tx.insert(budgetLines).values(input.lines.map((line) => ({ budgetId: id, categoryId: line.categoryId, kind: line.kind, planned: line.planned, rollover: line.rollover })));
        }
        return updated;
      });
      await audit(req, 'budget.updated', { type: 'budget', id }, `Budget updated (${row.name})`, { lines: input.lines.length });
      const period = budgetPeriod(row, base.today);
      const accountIds = base.accounts.filter((b) => b.row.legalEntityId === row.entityId || b.row.economicOwnerEntityId === row.entityId).map((b) => b.row.id);
      const records = accountIds.length > 0 ? await loadClassifiedRows(db, { accountIds, from: period.start, to: period.end }, 20_000) : [];
      return loadBudget(db, row, { asOf: base.today, fx: base.fx, transactions: toBudgetTransactions(records) });
    });

    // --- Goals -----------------------------------------------------------------------------
    scope.get('/api/goals', async (req): Promise<{ items: Goal[] }> => {
      const base = await financeBase(req);
      return { items: await loadGoals(req.server.fos.db, { asOf: base.today, fx: base.fx }) };
    });

    scope.post('/api/goals', async (req, reply): Promise<Goal> => {
      const input = parseBody(GoalInput, req.body);
      const base = await financeBase(req);
      const [row] = await req.server.fos.db
        .insert(goalsTable)
        .values({
          name: input.name,
          kind: input.kind,
          targetAmount: input.target.amount,
          targetCurrency: input.target.currency,
          targetDate: input.targetDate,
          protected: input.protected,
          heldIn: input.heldIn,
          linkedAccountIds: input.linkedAccountIds,
          priority: input.priority,
          travel: input.travel,
        })
        .returning();
      if (!row) throw new Error('goal insert returned no row');
      await audit(req, 'goal.created', { type: 'goal', id: row.id }, `Goal created (${row.kind})`, { protected: row.protected });
      reply.code(201);
      const [goal] = await loadGoals(req.server.fos.db, { asOf: base.today, fx: base.fx, goalIds: [row.id] });
      if (!goal) throw new Error('goal vanished after insert');
      return goal;
    });

    scope.put<{ Params: { id: string } }>('/api/goals/:id', async (req): Promise<Goal> => {
      const id = requireUuid(req.params.id, 'goal_not_found');
      const input = parseBody(GoalInput, req.body);
      const { db, clock } = req.server.fos;
      const base = await financeBase(req);
      const [row] = await db
        .update(goalsTable)
        .set({
          name: input.name,
          kind: input.kind,
          targetAmount: input.target.amount,
          targetCurrency: input.target.currency,
          targetDate: input.targetDate,
          protected: input.protected,
          heldIn: input.heldIn,
          linkedAccountIds: input.linkedAccountIds,
          priority: input.priority,
          travel: input.travel,
          updatedAt: clock.now(),
        })
        .where(eq(goalsTable.id, id))
        .returning();
      if (!row) throw errors.notFound('goal_not_found', 'Goal not found.');
      await audit(req, 'goal.updated', { type: 'goal', id }, `Goal updated (${row.name})`);
      const [goal] = await loadGoals(db, { asOf: base.today, fx: base.fx, goalIds: [id] });
      if (!goal) throw errors.notFound('goal_not_found', 'Goal not found.');
      return goal;
    });

    scope.delete<{ Params: { id: string } }>('/api/goals/:id', async (req) => {
      const id = requireUuid(req.params.id, 'goal_not_found');
      const { db, clock } = req.server.fos;
      const [row] = await db.update(goalsTable).set({ status: 'archived', archivedAt: clock.now() }).where(eq(goalsTable.id, id)).returning();
      if (!row) throw errors.notFound('goal_not_found', 'Goal not found.');
      await audit(req, 'goal.archived', { type: 'goal', id }, `Goal archived (${row.name})`);
      return { archived: true };
    });

    scope.get<{ Params: { id: string } }>('/api/goals/:id/contributions', async (req): Promise<{ items: GoalContribution[] }> => {
      const id = requireUuid(req.params.id, 'goal_not_found');
      const rows = await req.server.fos.db
        .select()
        .from(goalContributions)
        .where(eq(goalContributions.goalId, id))
        .orderBy(desc(goalContributions.contributedOn))
        .limit(500);
      return { items: rows.map(contributionView) };
    });

    scope.post<{ Params: { id: string } }>('/api/goals/:id/contributions', async (req, reply): Promise<GoalContribution> => {
      const id = requireUuid(req.params.id, 'goal_not_found');
      const input = parseBody(GoalContributionInput, req.body);
      const { db, clock } = req.server.fos;
      const goal = await loadOne(db.select().from(goalsTable).where(eq(goalsTable.id, id)).limit(1), 'goal_not_found', 'Goal not found.');
      if (input.status === 'verified' && !input.transactionId) {
        throw errors.badRequest('A verified contribution must reference the transaction that proves it.');
      }
      const [row] = await db
        .insert(goalContributions)
        .values({
          goalId: id,
          amount: input.amount,
          currency: goal.targetCurrency,
          contributedOn: input.date,
          status: input.status,
          sourceRecordId: input.transactionId,
          note: input.note,
          verifiedAt: input.status === 'verified' ? clock.now() : null,
        })
        .returning();
      if (!row) throw new Error('contribution insert returned no row');
      await audit(req, 'goal.contribution_recorded', { type: 'goal', id }, `Goal contribution recorded (${input.status})`, { status: input.status });
      reply.code(201);
      return contributionView(row);
    });

    // --- Recurring -------------------------------------------------------------------------
    scope.get('/api/recurring', async (req): Promise<{ items: RecurringItem[] }> => {
      const query = parseQuery(RecurringQuery, req.query);
      const rows = await listRecurringRows(req.server.fos.db, {
        ...(query.entityId ? { entityIds: [query.entityId] } : {}),
        ...(query.status ? { status: query.status } : {}),
      });
      return { items: rows.map(recurringView) };
    });

    scope.post('/api/recurring', async (req, reply): Promise<RecurringItem> => {
      const input = parseBody(RecurringItemInput, req.body);
      const [row] = await req.server.fos.db
        .insert(recurringItems)
        .values({
          name: input.name,
          entityId: input.entityId,
          accountId: input.accountId,
          counterpartyName: input.counterparty,
          kind: input.kind,
          direction: input.direction,
          amount: input.amount,
          currency: input.amount === null ? null : input.currency,
          amountIsEstimate: input.amountIsEstimate,
          cadence: input.cadence,
          dayOfMonth: input.dayOfMonth,
          nextDueOn: input.nextDueOn,
          status: input.status,
          detected: false,
          confirmed: true,
          internalCounterpartyEntityId: input.internalCounterpartyEntityId,
        })
        .returning();
      if (!row) throw new Error('recurring insert returned no row');
      await audit(req, 'recurring.created', { type: 'recurring_item', id: row.id }, `Recurring item created (${row.kind})`);
      reply.code(201);
      return recurringView(row);
    });

    scope.put('/api/recurring', async (req): Promise<RecurringItem> => {
      const input = parseBody(RecurringItemInput.partial().extend({ id: z.uuid() }), req.body);
      const { db, clock } = req.server.fos;
      const { id, counterparty, amount, currency, ...rest } = input;
      const [row] = await db
        .update(recurringItems)
        .set({
          ...rest,
          ...(counterparty !== undefined ? { counterpartyName: counterparty } : {}),
          ...(amount !== undefined ? { amount, currency: amount === null ? null : (currency ?? null) } : {}),
          updatedAt: clock.now(),
        })
        .where(eq(recurringItems.id, id))
        .returning();
      if (!row) throw errors.notFound('recurring_not_found', 'Recurring item not found.');
      await audit(req, 'recurring.updated', { type: 'recurring_item', id }, `Recurring item updated (${row.name})`);
      return recurringView(row);
    });

    scope.post<{ Params: { id: string } }>('/api/recurring/:id/confirm', async (req): Promise<RecurringItem> => {
      const id = requireUuid(req.params.id, 'recurring_not_found');
      const { db, clock } = req.server.fos;
      const [row] = await db
        .update(recurringItems)
        .set({ status: 'active', confirmed: true, updatedAt: clock.now() })
        .where(eq(recurringItems.id, id))
        .returning();
      if (!row) throw errors.notFound('recurring_not_found', 'Recurring item not found.');
      await audit(req, 'recurring.confirmed', { type: 'recurring_item', id }, `Detected recurring item confirmed (${row.name})`);
      return recurringView(row);
    });

    scope.post<{ Params: { id: string } }>('/api/recurring/:id/dismiss', async (req): Promise<RecurringItem> => {
      const id = requireUuid(req.params.id, 'recurring_not_found');
      const { db, clock } = req.server.fos;
      const [row] = await db
        .update(recurringItems)
        .set({ status: 'cancelled', confirmed: false, updatedAt: clock.now() })
        .where(eq(recurringItems.id, id))
        .returning();
      if (!row) throw errors.notFound('recurring_not_found', 'Recurring item not found.');
      await audit(req, 'recurring.dismissed', { type: 'recurring_item', id }, `Detected recurring item dismissed (${row.name})`);
      return recurringView(row);
    });

    // --- Obligations -------------------------------------------------------------------------
    scope.get('/api/obligations', async (req): Promise<{ items: Obligation[] }> => {
      const query = parseQuery(ObligationQuery, req.query);
      const rows = await listObligationRows(req.server.fos.db, {
        ...(query.entityId ? { entityIds: [query.entityId] } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
      });
      return { items: rows.map(obligationView) };
    });

    scope.post('/api/obligations', async (req, reply): Promise<Obligation> => {
      const input = parseBody(ObligationInput, req.body);
      const [row] = await req.server.fos.db
        .insert(obligationsTable)
        .values({
          entityId: input.entityId,
          dueOn: input.dueOn,
          amount: input.amount,
          currency: input.amount === null ? null : input.currency,
          label: input.label,
          kind: input.kind,
          status: input.status,
        })
        .returning();
      if (!row) throw new Error('obligation insert returned no row');
      await audit(req, 'obligation.created', { type: 'obligation', id: row.id }, `Obligation recorded (${row.kind})`);
      reply.code(201);
      return obligationView(row);
    });

    scope.put('/api/obligations', async (req): Promise<Obligation> => {
      const input = parseBody(ObligationInput.partial().extend({ id: z.uuid() }), req.body);
      const { db, clock } = req.server.fos;
      const { id, amount, currency, ...rest } = input;
      const [row] = await db
        .update(obligationsTable)
        .set({
          ...rest,
          ...(amount !== undefined ? { amount, currency: amount === null ? null : (currency ?? null) } : {}),
          updatedAt: clock.now(),
        })
        .where(eq(obligationsTable.id, id))
        .returning();
      if (!row) throw errors.notFound('obligation_not_found', 'Obligation not found.');
      await audit(req, 'obligation.updated', { type: 'obligation', id }, `Obligation updated (${row.label})`);
      return obligationView(row);
    });

    // --- Purchase impact ----------------------------------------------------------------------
    scope.post('/api/plan/purchase-impact', async (req): Promise<PurchaseImpactResult> => {
      const input = parseBody(PurchaseImpactInput, req.body);
      const base = await financeBase(req);
      const safeToSpendInput = await buildSafeToSpendInput(req.server.fos, base);
      const goals = await loadGoals(req.server.fos.db, { asOf: base.today, fx: base.fx });
      const budgetRows = base.primaryOwner ? await listBudgetRows(req.server.fos.db, { entityIds: [base.primaryOwner.id] }) : [];
      const budgetRow = budgetRows[0];
      let budget: Pick<Budget, 'currency' | 'period' | 'lines'> | null = null;
      if (budgetRow) {
        const period = budgetPeriod(budgetRow, base.today);
        const accountIds = base.accounts.filter((b) => b.row.economicOwnerEntityId === budgetRow.entityId).map((b) => b.row.id);
        const records = accountIds.length > 0 ? await loadClassifiedRows(req.server.fos.db, { accountIds, from: period.start, to: period.end }, 20_000) : [];
        const loaded = await loadBudget(req.server.fos.db, budgetRow, { asOf: base.today, fx: base.fx, transactions: toBudgetTransactions(records) });
        budget = { currency: loaded.currency, period: loaded.period, lines: loaded.lines };
      }
      return purchaseImpact(input, {
        safeToSpend: safeToSpendInput,
        budget,
        goals: goals.map((g) => ({ id: g.id, name: g.name, target: g.target, fundedVerified: g.fundedVerified, priority: g.priority, status: g.status })),
        // Monthly capacity for goals is not recorded, so goal delays stay unknown rather than invented.
        monthlyGoalCapacity: null,
      });
    });

    // --- Scenarios ------------------------------------------------------------------------------
    scope.get('/api/scenarios', async (req): Promise<{ items: Scenario[] }> => {
      const query = parseQuery(z.object({ includeArchived: z.coerce.boolean().default(false) }), req.query);
      return { items: await listScenarios(req.server.fos.db, query.includeArchived) };
    });

    scope.post('/api/scenarios', async (req, reply): Promise<Scenario> => {
      const input = parseBody(ScenarioInput, req.body);
      const { db } = req.server.fos;
      const created = await db.transaction(async (tx) => {
        const [row] = await tx.insert(scenariosTable).values({ currentVersion: 1 }).returning();
        if (!row) throw new Error('scenario insert returned no row');
        await tx.insert(scenarioVersions).values({
          scenarioId: row.id,
          version: 1,
          name: input.name,
          description: input.description,
          adjustments: input.adjustments as unknown as Array<Record<string, unknown>>,
        });
        return row;
      });
      await audit(req, 'scenario.created', { type: 'scenario', id: created.id }, `Scenario created (${input.name})`, { adjustments: input.adjustments.length });
      reply.code(201);
      const bundle = await loadScenario(db, created.id);
      if (!bundle) throw new Error('scenario vanished after insert');
      return bundle.scenario;
    });

    scope.put<{ Params: { id: string } }>('/api/scenarios/:id', async (req): Promise<Scenario> => {
      const id = requireUuid(req.params.id, 'scenario_not_found');
      const input = parseBody(ScenarioInput, req.body);
      const { db, clock } = req.server.fos;
      const scenario = await loadOne(db.select().from(scenariosTable).where(eq(scenariosTable.id, id)).limit(1), 'scenario_not_found', 'Scenario not found.');
      const version = scenario.currentVersion + 1;
      await db.transaction(async (tx) => {
        await tx.insert(scenarioVersions).values({
          scenarioId: id,
          version,
          name: input.name,
          description: input.description,
          adjustments: input.adjustments as unknown as Array<Record<string, unknown>>,
        });
        await tx.update(scenariosTable).set({ currentVersion: version, updatedAt: clock.now() }).where(eq(scenariosTable.id, id));
      });
      await audit(req, 'scenario.updated', { type: 'scenario', id }, `Scenario updated to version ${version}`, { version });
      const bundle = await loadScenario(db, id);
      if (!bundle) throw errors.notFound('scenario_not_found', 'Scenario not found.');
      return bundle.scenario;
    });

    scope.delete<{ Params: { id: string } }>('/api/scenarios/:id', async (req) => {
      const id = requireUuid(req.params.id, 'scenario_not_found');
      const { db, clock } = req.server.fos;
      // Archiving keeps every version, so the change is reversible.
      const [row] = await db.update(scenariosTable).set({ archived: true, archivedAt: clock.now() }).where(eq(scenariosTable.id, id)).returning();
      if (!row) throw errors.notFound('scenario_not_found', 'Scenario not found.');
      await audit(req, 'scenario.archived', { type: 'scenario', id }, 'Scenario archived (versions kept)');
      return { archived: true };
    });

    // --- Rewards ---------------------------------------------------------------------------------
    scope.get('/api/rewards/products', async (req): Promise<{ items: RewardProduct[] }> => {
      const rows = await listRewardRows(req.server.fos.db);
      return { items: rows.map(rewardView) };
    });

    scope.post('/api/rewards/products', async (req, reply): Promise<RewardProduct> => {
      const input = parseBody(RewardProductInput, req.body);
      const [row] = await req.server.fos.db
        .insert(rewardProducts)
        .values({
          name: input.name,
          issuer: input.issuer,
          termsAsOf: input.termsAsOf,
          sourceUrl: input.sourceUrl,
          eligibility: input.eligibility,
          annualFee: input.annualFee?.amount ?? null,
          annualFeeCurrency: input.annualFee?.currency ?? null,
          earnRate: input.earnRate,
          earnUnit: input.earnUnit,
          pointValue: input.pointValue?.amount ?? null,
          pointValueCurrency: input.pointValue?.currency ?? null,
          fxFeePercent: input.fxFeePercent,
          paymentFeePercent: input.paymentFeePercent,
          notes: input.notes,
        })
        .returning();
      if (!row) throw new Error('reward product insert returned no row');
      await audit(req, 'reward_product.created', { type: 'reward_product', id: row.id }, `Reward product recorded (terms as of ${row.termsAsOf})`);
      reply.code(201);
      return rewardView(row);
    });

    scope.put('/api/rewards/products', async (req): Promise<RewardProduct> => {
      const input = parseBody(RewardProductInput.partial().extend({ id: z.uuid() }), req.body);
      const { db, clock } = req.server.fos;
      const { id, annualFee, pointValue, ...rest } = input;
      const [row] = await db
        .update(rewardProducts)
        .set({
          ...rest,
          ...(annualFee !== undefined ? { annualFee: annualFee?.amount ?? null, annualFeeCurrency: annualFee?.currency ?? null } : {}),
          ...(pointValue !== undefined ? { pointValue: pointValue?.amount ?? null, pointValueCurrency: pointValue?.currency ?? null } : {}),
          updatedAt: clock.now(),
        })
        .where(eq(rewardProducts.id, id))
        .returning();
      if (!row) throw errors.notFound('reward_product_not_found', 'Reward product not found.');
      await audit(req, 'reward_product.updated', { type: 'reward_product', id }, 'Reward product updated');
      return rewardView(row);
    });

    scope.post('/api/rewards/compare', async (req): Promise<RewardComparisonResult> => {
      const input = parseBody(RewardComparisonInput, req.body);
      const base = await financeBase(req);
      const rows = await listRewardRows(req.server.fos.db, input.productIds.length > 0 ? input.productIds : undefined);
      return compareRewards(input, rows.map(rewardView), { asOf: base.today, fx: base.fx });
    });

    // --- Tax facts ----------------------------------------------------------------------------------
    scope.get('/api/tax-facts', async (req): Promise<{ items: TaxFact[] }> => {
      const rows = await req.server.fos.db.select().from(taxFacts).orderBy(asc(taxFacts.jurisdiction), asc(taxFacts.topic)).limit(500);
      return { items: rows.map(taxFactView) };
    });

    scope.put('/api/tax-facts', async (req): Promise<TaxFact> => {
      const input = parseBody(TaxFactInput.extend({ id: z.uuid().optional() }), req.body);
      const { db, clock } = req.server.fos;
      const values = {
        jurisdiction: input.jurisdiction,
        topic: input.topic,
        status: input.status,
        value: input.value,
        deadline: input.deadline,
        accountantQuestion: input.accountantQuestion,
        documentIds: input.documentIds,
        updatedAt: clock.now(),
      };
      const row = input.id
        ? (await db.update(taxFacts).set(values).where(eq(taxFacts.id, input.id)).returning())[0]
        : (await db.insert(taxFacts).values(values).returning())[0];
      if (!row) throw errors.notFound('tax_fact_not_found', 'Tax fact not found.');
      await audit(req, 'tax_fact.updated', { type: 'tax_fact', id: row.id }, `Tax fact recorded (${row.jurisdiction}/${row.topic}, ${row.status})`);
      return taxFactView(row);
    });
  });
}

export { and, gte, inArray, isNull, lte, normalizeDecimal, remainingFor, shiftDays };
