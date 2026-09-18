/**
 * Deliberately over-sharing providers. They return amounts and rows the caller may not be
 * allowed to see, so the masking and scoping in the API core is what the tests measure.
 */
import type { GlanceResponse } from '@financialos/contracts';
import type { AgentCallContext, AgentDataProvider, AgentPage, GlanceProvider, SuggestionSink } from '../providers';

const money = (amount: string) => ({ amount, currency: 'EUR' });

/** Ignores `revealedFields` entirely and always returns every amount. */
export const oversharingGlanceProvider: GlanceProvider = {
  async getGlance({ now }): Promise<GlanceResponse> {
    return {
      generatedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 300_000).toISOString(),
      privacy: { masked: false, revealedFields: ['safe_to_spend', 'budget_remaining', 'goal_amounts', 'due_amounts'] },
      spending: {
        status: 'on_track',
        periodLabel: 'March',
        percentOfPlanUsed: 42,
        percentOfPeriodElapsed: 50,
        safeToSpend: money('1234.56'),
        safeToSpendStatus: 'ok',
        budgetRemaining: money('789.01'),
      },
      goals: [
        { label: 'Buffer', percent: 40, amount: money('2500.00') },
        { label: 'Laptop', percent: 10, amount: money('300.00') },
        { label: 'Trip', percent: 5, amount: money('150.00') },
        { label: 'Fourth goal beyond the cap', percent: 1, amount: money('10.00') },
      ],
      dueSoon: { count: 3, windowDays: 7, nextLabel: 'Rent', total: money('1800.00') },
      nudge: { text: 'Two transactions need a category', kind: 'review' },
      freshness: { state: 'fresh', lastDataAt: now.toISOString() },
      attention: { openExceptions: 2 },
    };
  },
};

export interface RecordedAgentCall {
  method: string;
  entityIds: string[];
  scopes: string[];
  query?: Record<string, unknown>;
}

export interface RecordingAgentProvider {
  provider: AgentDataProvider;
  calls: RecordedAgentCall[];
}

export function createRecordingAgentProvider(): RecordingAgentProvider {
  const calls: RecordedAgentCall[] = [];
  const record = (method: string, ctx: AgentCallContext, query?: Record<string, unknown>) => {
    calls.push({ method, entityIds: [...ctx.entityIds], scopes: [...ctx.scopes], ...(query ? { query } : {}) });
  };
  const page = (ctx: AgentCallContext): AgentPage => ({ items: ctx.entityIds.map((id) => ({ entityId: id })), nextCursor: null });

  const provider: AgentDataProvider = {
    async getSummary(ctx) {
      record('getSummary', ctx);
      return { generatedAt: ctx.now.toISOString(), status: 'ok', entityIds: [...ctx.entityIds], figures: { netWorth: '100.00' }, notes: [] };
    },
    async listAccounts(ctx, query) {
      record('listAccounts', ctx, { ...query });
      return page(ctx);
    },
    async listTransactions(ctx, query) {
      record('listTransactions', ctx, { ...query });
      return page(ctx);
    },
    async getBudgets(ctx, query) {
      record('getBudgets', ctx, { ...query });
      return page(ctx);
    },
    async getForecast(ctx) {
      record('getForecast', ctx);
      return { weeks: [], entityIds: [...ctx.entityIds] };
    },
    async getPortfolio(ctx) {
      record('getPortfolio', ctx);
      return { holdings: [], entityIds: [...ctx.entityIds] };
    },
    async listExceptions(ctx, query) {
      record('listExceptions', ctx, { ...query });
      return page(ctx);
    },
    async simulatePortfolio(ctx, input) {
      record('simulatePortfolio', ctx, input);
      return { simulated: true, entityIds: [...ctx.entityIds] };
    },
    async draftReview(ctx, input) {
      record('draftReview', ctx, input);
      return { draft: true, entityIds: [...ctx.entityIds] };
    },
  };
  return { provider, calls };
}

export function createRecordingSuggestionSink(): { sink: SuggestionSink; calls: Array<{ ctx: AgentCallContext; input: unknown }> } {
  const calls: Array<{ ctx: AgentCallContext; input: unknown }> = [];
  return {
    calls,
    sink: {
      async createAgentSuggestion(ctx, input) {
        calls.push({ ctx, input });
        return { exceptionId: '00000000-0000-4000-8000-000000000001' };
      },
    },
  };
}
