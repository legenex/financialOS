/**
 * Data interfaces that the API core depends on but does not implement. The data-routes layer
 * registers real implementations through `buildApp({ providers })`. The defaults below are
 * honest: they report unknown / empty results and never invent numbers.
 */
import type { AgentScope, ExceptionItem, GlanceResponse, RevealableField } from '@financialos/contracts';

export interface GlanceInput {
  revealedFields: RevealableField[];
  now: Date;
  deviceId: string;
}

/** Produces the extension glance. Must only include amounts for fields listed in `revealedFields`. */
export interface GlanceProvider {
  getGlance(input: GlanceInput): Promise<GlanceResponse>;
}

/** Scope information passed to every agent data call. Implementations must filter by `entityIds`. */
export interface AgentCallContext {
  clientId: string;
  clientName: string;
  scopes: readonly AgentScope[];
  /** Entities this call may read. Always non-empty and always a subset of the client's entities. */
  entityIds: readonly string[];
  now: Date;
}

export interface AgentPage<T = Record<string, unknown>> {
  items: T[];
  nextCursor: string | null;
}

export interface AgentListQuery {
  cursor?: string;
  limit: number;
  from?: string;
  to?: string;
  status?: string;
}

export interface AgentSummary {
  generatedAt: string;
  status: 'ok' | 'provisional' | 'insufficient_data';
  entityIds: string[];
  /** Deterministic figures computed by the domain engine, as decimal strings. */
  figures: Record<string, unknown>;
  notes: string[];
}

export interface ClassificationSuggestionInput {
  transactionId: string;
  nature: string;
  categoryId: string | null;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
}

/** Read-only data access for the agent API and MCP tools. */
export interface AgentDataProvider {
  getSummary(ctx: AgentCallContext): Promise<AgentSummary>;
  listAccounts(ctx: AgentCallContext, query: AgentListQuery): Promise<AgentPage>;
  listTransactions(ctx: AgentCallContext, query: AgentListQuery): Promise<AgentPage>;
  getBudgets(ctx: AgentCallContext, query: AgentListQuery): Promise<AgentPage>;
  getForecast(ctx: AgentCallContext): Promise<Record<string, unknown>>;
  getPortfolio(ctx: AgentCallContext): Promise<Record<string, unknown>>;
  listExceptions(ctx: AgentCallContext, query: AgentListQuery): Promise<AgentPage<ExceptionItem | Record<string, unknown>>>;
  /** Paper simulation only. Never places orders. */
  simulatePortfolio(ctx: AgentCallContext, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Produces a review draft. Never changes records. */
  draftReview(ctx: AgentCallContext, input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * The only write path available to agents: a classification suggestion becomes an exception of
 * kind `agent_suggestion` for the owner to accept or dismiss.
 */
export interface SuggestionSink {
  createAgentSuggestion(ctx: AgentCallContext, input: ClassificationSuggestionInput): Promise<{ exceptionId: string }>;
}

export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';
}

const UNAVAILABLE_NOTE = 'No data layer is registered on this server, so no figures are available.';

export const unavailableGlanceProvider: GlanceProvider = {
  async getGlance({ now }) {
    const iso = now.toISOString();
    return {
      generatedAt: iso,
      validUntil: new Date(now.getTime() + 5 * 60_000).toISOString(),
      privacy: { masked: true, revealedFields: [] },
      spending: {
        status: 'unknown',
        periodLabel: 'This period',
        percentOfPlanUsed: null,
        percentOfPeriodElapsed: 0,
        safeToSpend: null,
        safeToSpendStatus: 'insufficient_data',
        budgetRemaining: null,
      },
      goals: [],
      dueSoon: { count: 0, windowDays: 7, nextLabel: null, total: null },
      nudge: { text: 'Open FinancialOS to review', kind: 'review' },
      freshness: { state: 'unknown', lastDataAt: null },
      attention: { openExceptions: 0 },
    };
  },
};

const emptyPage = async (): Promise<AgentPage> => ({ items: [], nextCursor: null });

export const unavailableAgentDataProvider: AgentDataProvider = {
  async getSummary(ctx) {
    return {
      generatedAt: ctx.now.toISOString(),
      status: 'insufficient_data',
      entityIds: [...ctx.entityIds],
      figures: {},
      notes: [UNAVAILABLE_NOTE],
    };
  },
  listAccounts: emptyPage,
  listTransactions: emptyPage,
  getBudgets: emptyPage,
  async getForecast(ctx) {
    return { generatedAt: ctx.now.toISOString(), status: 'insufficient_data', weeks: [], notes: [UNAVAILABLE_NOTE] };
  },
  async getPortfolio(ctx) {
    return { generatedAt: ctx.now.toISOString(), status: 'insufficient_data', holdings: [], notes: [UNAVAILABLE_NOTE] };
  },
  listExceptions: emptyPage,
  async simulatePortfolio() {
    throw new ProviderUnavailableError('Portfolio simulation is not available on this server.');
  },
  async draftReview() {
    throw new ProviderUnavailableError('Review drafting is not available on this server.');
  },
};

export const unavailableSuggestionSink: SuggestionSink = {
  async createAgentSuggestion() {
    throw new ProviderUnavailableError('Classification suggestions are not available on this server.');
  },
};

export interface AppProviders {
  glance: GlanceProvider;
  agentData: AgentDataProvider;
  suggestions: SuggestionSink;
}

export function resolveProviders(partial: Partial<AppProviders> = {}): AppProviders {
  return {
    glance: partial.glance ?? unavailableGlanceProvider,
    agentData: partial.agentData ?? unavailableAgentDataProvider,
    suggestions: partial.suggestions ?? unavailableSuggestionSink,
  };
}
