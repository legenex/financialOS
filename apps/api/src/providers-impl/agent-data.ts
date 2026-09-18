/**
 * Read-only data for the agent API and the MCP tools.
 *
 * Every method filters by the credential's entity scope, which the core guard has already narrowed.
 * Nothing here writes: the single write path an agent has is a classification suggestion, which
 * becomes an exception for the owner (see suggestions.ts).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ExceptionItem } from '@financialos/contracts';
import { exceptions as exceptionsTable } from '@financialos/db';
import { simulateTargetAllocation, type TargetWeight } from '@financialos/domain';
import { z } from 'zod';
import type { AppContext } from '../context';
import { ProviderUnavailableError, type AgentCallContext, type AgentDataProvider, type AgentListQuery, type AgentPage, type AgentSummary } from '../providers';
import { shiftDays } from '../data/common';
import { loadCoachFacts } from '../data/coach';
import { allRunways, forecastFor, loadFinanceBase, safeToSpendFor, wealthFor, type FinanceBase } from '../data/finance';
import { listBudgetRows, budgetPeriod, loadBudget } from '../data/planning';
import { loadPortfolio, loadPortfolioComputation } from '../data/portfolio';
import { loadTransactionPage, loadClassifiedRows, toBudgetTransactions } from '../data/transactions';
import { buildReview } from '../data/coach';

const SimulateInput = z.object({
  by: z.enum(['kind', 'symbol']).default('kind'),
  currency: z.string().regex(/^[A-Z0-9]{2,10}$/).optional(),
  targets: z.array(z.object({ label: z.string().min(1).max(40), weight: z.string().regex(/^0?\.\d{1,18}$|^[01](\.0+)?$/) })).min(1).max(30),
});

const DraftReviewInput = z.object({ kind: z.enum(['weekly', 'monthly']).default('weekly') });

function scopedAccountIds(base: FinanceBase, entityIds: readonly string[]): string[] {
  const scope = new Set(entityIds);
  return base.accounts.filter((b) => (b.row.legalEntityId && scope.has(b.row.legalEntityId)) || (b.row.economicOwnerEntityId && scope.has(b.row.economicOwnerEntityId))).map((b) => b.row.id);
}

export class DbAgentDataProvider implements AgentDataProvider {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async #base(): Promise<FinanceBase> {
    return loadFinanceBase(this.#ctx);
  }

  async getSummary(call: AgentCallContext): Promise<AgentSummary> {
    const base = await this.#base();
    const notes: string[] = [];
    const entityIds = [...call.entityIds];
    const scope = new Set(entityIds);
    const ownerInScope = base.primaryOwner !== null && scope.has(base.primaryOwner.id);

    // wealthFor throws for a scope its inputs cannot resolve (e.g. an entity id the finance base
    // does not know about, such as a credential scoped before any entity was confirmed); that is
    // an "unavailable" result here, not a server error.
    let wealth: ReturnType<typeof wealthFor> | null = null;
    try {
      wealth = ownerInScope ? wealthFor(base, { kind: 'personal' }) : entityIds.length === 1 && entityIds[0] ? wealthFor(base, { kind: 'entity', entityId: entityIds[0] }) : null;
    } catch {
      wealth = null;
    }
    if (!wealth) notes.push('Wealth is reported only for a single entity scope or for the owner.');

    const safeToSpend = ownerInScope ? await safeToSpendFor(this.#ctx, base).catch(() => null) : null;
    if (!ownerInScope) notes.push('Safe-to-spend belongs to the owner and is not in this credential’s entity scope.');

    const runways = (await allRunways(this.#ctx, base)).filter((r) => (r.scope.entityId ? scope.has(r.scope.entityId) : false));

    const statuses = [wealth?.status, safeToSpend?.status].filter((value): value is 'ok' | 'provisional' | 'insufficient_data' => Boolean(value));
    const status: AgentSummary['status'] = statuses.length === 0 ? 'insufficient_data' : statuses.includes('insufficient_data') ? 'insufficient_data' : statuses.includes('provisional') ? 'provisional' : 'ok';

    return {
      generatedAt: call.now.toISOString(),
      status,
      entityIds,
      figures: {
        reportingCurrency: base.settings.reportingCurrency,
        netWorthKnown: wealth?.netWorthKnown ?? null,
        wealthStatus: wealth?.status ?? 'insufficient_data',
        safeToSpend: safeToSpend?.amount ?? null,
        safeToSpendStatus: safeToSpend?.status ?? 'insufficient_data',
        runway: runways.map((r) => ({ scope: r.scope.label, status: r.status, months: r.months })),
        accountsInScope: scopedAccountIds(base, entityIds).length,
      },
      notes,
    };
  }

  async listAccounts(call: AgentCallContext, query: AgentListQuery): Promise<AgentPage> {
    const base = await this.#base();
    const scope = new Set(call.entityIds);
    const items = base.accounts
      .filter((b) => (b.row.legalEntityId && scope.has(b.row.legalEntityId)) || (b.row.economicOwnerEntityId && scope.has(b.row.economicOwnerEntityId)))
      .slice(0, query.limit)
      .map((b) => ({
        id: b.row.id,
        name: b.row.name,
        kind: b.row.kind,
        currency: b.row.currency,
        liquidityClass: b.row.liquidityClass,
        legalEntityId: b.row.legalEntityId,
        economicOwnerEntityId: b.row.economicOwnerEntityId,
        valuation: b.account.valuation,
        freshness: b.account.freshness,
      }));
    return { items, nextCursor: null };
  }

  async listTransactions(call: AgentCallContext, query: AgentListQuery): Promise<AgentPage> {
    const base = await this.#base();
    const accountIds = scopedAccountIds(base, call.entityIds);
    if (accountIds.length === 0) return { items: [], nextCursor: null };
    const page = await loadTransactionPage(
      this.#ctx.db,
      {
        accountIds,
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
      },
      { reportingCurrency: base.settings.reportingCurrency, fx: base.fx },
    );
    return { items: page.items as unknown as Array<Record<string, unknown>>, nextCursor: page.nextCursor };
  }

  async getBudgets(call: AgentCallContext, query: AgentListQuery): Promise<AgentPage> {
    const base = await this.#base();
    const rows = await listBudgetRows(this.#ctx.db, { entityIds: [...call.entityIds] });
    const items: Array<Record<string, unknown>> = [];
    for (const row of rows.slice(0, query.limit)) {
      const period = budgetPeriod(row, base.today);
      const accountIds = base.accounts.filter((b) => b.row.legalEntityId === row.entityId || b.row.economicOwnerEntityId === row.entityId).map((b) => b.row.id);
      const records = accountIds.length > 0 ? await loadClassifiedRows(this.#ctx.db, { accountIds, from: period.start, to: period.end }, 20_000) : [];
      const budget = await loadBudget(this.#ctx.db, row, { asOf: base.today, fx: base.fx, transactions: toBudgetTransactions(records) });
      items.push(budget as unknown as Record<string, unknown>);
    }
    return { items, nextCursor: null };
  }

  async getForecast(call: AgentCallContext): Promise<Record<string, unknown>> {
    const base = await this.#base();
    const entityId = call.entityIds.length === 1 ? (call.entityIds[0] as string) : null;
    if (entityId && !base.entityRows.some((e) => e.id === entityId)) {
      return { generatedAt: call.now.toISOString(), status: 'insufficient_data', weeks: [], notes: ['The entity in scope does not exist.'] };
    }
    const forecast = await forecastFor(this.#ctx, base, { entityId });
    return forecast as unknown as Record<string, unknown>;
  }

  async getPortfolio(call: AgentCallContext): Promise<Record<string, unknown>> {
    const base = await this.#base();
    const scope = new Set(call.entityIds);
    const accounts = base.accounts.filter((b) => (b.row.legalEntityId && scope.has(b.row.legalEntityId)) || (b.row.economicOwnerEntityId && scope.has(b.row.economicOwnerEntityId)));
    const summary = await loadPortfolio(this.#ctx.db, {
      accounts,
      currency: base.settings.reportingCurrency,
      asOf: base.today,
      from: shiftDays(base.today, -365),
      fx: base.fx,
    });
    return summary as unknown as Record<string, unknown>;
  }

  async listExceptions(call: AgentCallContext, query: AgentListQuery): Promise<AgentPage<ExceptionItem | Record<string, unknown>>> {
    const scope = [...call.entityIds];
    const conditions = [inArray(exceptionsTable.entityId, scope)];
    if (query.status) conditions.push(eq(exceptionsTable.status, query.status as 'open'));
    else conditions.push(eq(exceptionsTable.status, 'open'));
    const rows = await this.#ctx.db
      .select()
      .from(exceptionsTable)
      .where(and(...conditions))
      .orderBy(desc(exceptionsTable.createdAt))
      .limit(query.limit);
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        status: row.status,
        title: row.title,
        detail: row.body,
        subject: { type: row.subjectType, id: row.subjectId, label: row.subjectLabel },
        entityId: row.entityId,
        suggestedActions: row.suggestedActions,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
        resolution: row.resolution,
      })),
      nextCursor: null,
    };
  }

  /** Paper simulation only. It produces the trades that would match target weights; it places none. */
  async simulatePortfolio(call: AgentCallContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = SimulateInput.safeParse(input);
    if (!parsed.success) throw new ProviderUnavailableError('The simulation input is not valid: give target weights that add up to at most 1.');
    const base = await this.#base();
    const scope = new Set(call.entityIds);
    const accounts = base.accounts.filter((b) => (b.row.legalEntityId && scope.has(b.row.legalEntityId)) || (b.row.economicOwnerEntityId && scope.has(b.row.economicOwnerEntityId)));
    const currency = parsed.data.currency ?? base.settings.reportingCurrency;
    const computation = await loadPortfolioComputation(this.#ctx.db, { accounts, currency, asOf: base.today, from: shiftDays(base.today, -365), fx: base.fx });
    const summary = computation.summary;
    if (summary.status === 'insufficient_data') {
      return { mode: 'paper', status: 'insufficient_data', trades: [], caveats: ['There are no valued holdings in this entity scope, so no simulation is possible.'] };
    }
    const positions = computation.positions;
    const targets: TargetWeight[] = parsed.data.targets;
    const result = simulateTargetAllocation(positions, targets, { currency, by: parsed.data.by });
    return { mode: 'paper', status: summary.status, ...result };
  }

  /** Produces a review draft from the deterministic coach. It changes no record. */
  async draftReview(call: AgentCallContext, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = DraftReviewInput.safeParse(input);
    const kind = parsed.success ? parsed.data.kind : 'weekly';
    const base = await this.#base();
    const facts = await loadCoachFacts(this.#ctx, base);
    const review = buildReview(kind, facts);
    return { ...review, generatedAt: call.now.toISOString(), persisted: false };
  }
}
