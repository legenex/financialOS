/**
 * Real implementations of the interfaces the API core depends on, plus the wiring that installs
 * them.
 *
 * `buildApp` resolves providers before any route module runs and every core handler reads
 * `req.server.fos.providers.*` at call time, so `registerDataProviders` can swap the honest
 * "nothing is registered" defaults for the database-backed implementations. An implementation that
 * was injected explicitly through `buildApp({ providers })` (a test fake, for instance) is left
 * alone.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import {
  unavailableAgentDataProvider,
  unavailableGlanceProvider,
  unavailableSuggestionSink,
  type AppProviders,
} from '../providers';
import type { JsonSchemaObject } from '../mcp/registry';
import { DbAgentDataProvider } from './agent-data';
import { DbGlanceProvider } from './glance';
import { DbSuggestionSink } from './suggestions';

export { DbAgentDataProvider, DbGlanceProvider, DbSuggestionSink };

/** Every provider the data layer implements, bound to one application context. */
export function createDataProviders(ctx: AppContext): AppProviders {
  return {
    glance: new DbGlanceProvider(ctx),
    agentData: new DbAgentDataProvider(ctx),
    suggestions: new DbSuggestionSink(ctx),
  };
}

const entityIdSchema = { type: 'string', format: 'uuid', description: 'Limit the result to one entity in this credential’s scope.' };
const pageProps = { cursor: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } };

const obj = (properties: Record<string, unknown>, required: string[] = []): JsonSchemaObject => ({ type: 'object', properties, required, additionalProperties: false });

const ListInput = z.object({ entityId: z.uuid().optional(), cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).default(50) }).strict();
const RangeInput = ListInput.extend({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();
const ScopeInput = z.object({ entityId: z.uuid().optional() }).strict();
const SimulateInput = z
  .object({
    entityId: z.uuid().optional(),
    by: z.enum(['kind', 'symbol']).default('kind'),
    currency: z.string().regex(/^[A-Z0-9]{2,10}$/).optional(),
    targets: z.array(z.object({ label: z.string().min(1).max(40), weight: z.string() })).min(1).max(30),
  })
  .strict();
const DraftInput = z.object({ entityId: z.uuid().optional(), kind: z.enum(['weekly', 'monthly']).default('weekly') }).strict();

/**
 * The read-only MCP tools that go with the real providers. The core registry already carries
 * get_summary, list_accounts, list_exceptions and suggest_classification.
 */
export function registerDataMcpTools(ctx: AppContext): void {
  const registry = ctx.mcpTools;
  const add = <I extends { entityId?: string }>(tool: Parameters<typeof registry.register<I>>[0]) => {
    if (!registry.get(tool.name)) registry.register(tool);
  };

  add({
    name: 'list_transactions',
    title: 'Transactions',
    description: 'Classified transactions for the entities in scope. Amounts are decimal strings; unknown values are null.',
    requiredScope: 'read:transactions',
    inputSchema: obj({ entityId: entityIdSchema, from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, ...pageProps }),
    parse: (args) => RangeInput.parse(args ?? {}),
    handler: (input, { call, providers }) =>
      providers.agentData.listTransactions(call, {
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
      }),
  });

  add({
    name: 'get_budgets',
    title: 'Budgets',
    description: 'Budgets with actuals for the entities in scope. Actuals are provisional while transactions are unclassified.',
    requiredScope: 'read:budgets',
    inputSchema: obj({ entityId: entityIdSchema, ...pageProps }),
    parse: (args) => ListInput.parse(args ?? {}),
    handler: (input, { call, providers }) => providers.agentData.getBudgets(call, { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) }),
  });

  add({
    name: 'get_forecast',
    title: 'Cash forecast',
    description: 'The 13-week cash forecast for the entity in scope, with its warnings and explanation.',
    requiredScope: 'read:forecast',
    inputSchema: obj({ entityId: entityIdSchema }),
    parse: (args) => ScopeInput.parse(args ?? {}),
    handler: (_input, { call, providers }) => providers.agentData.getForecast(call),
  });

  add({
    name: 'get_portfolio',
    title: 'Portfolio',
    description: 'Allocation, currency exposure, concentration and restricted holdings for the entities in scope.',
    requiredScope: 'read:portfolio',
    inputSchema: obj({ entityId: entityIdSchema }),
    parse: (args) => ScopeInput.parse(args ?? {}),
    handler: (_input, { call, providers }) => providers.agentData.getPortfolio(call),
  });

  add({
    name: 'simulate_portfolio',
    title: 'Simulate a target allocation',
    description: 'Paper simulation of the trades that would match target weights. It never places an order and changes no record.',
    requiredScope: 'simulate:portfolio',
    inputSchema: obj(
      {
        entityId: entityIdSchema,
        by: { type: 'string', enum: ['kind', 'symbol'] },
        currency: { type: 'string', pattern: '^[A-Z0-9]{2,10}$' },
        targets: {
          type: 'array',
          maxItems: 30,
          items: obj({ label: { type: 'string', maxLength: 40 }, weight: { type: 'string', description: 'Fraction of the marketable total, e.g. "0.25".' } }, ['label', 'weight']),
        },
      },
      ['targets'],
    ),
    parse: (args) => SimulateInput.parse(args ?? {}),
    handler: (input, { call, providers }) => providers.agentData.simulatePortfolio(call, input as unknown as Record<string, unknown>),
  });

  add({
    name: 'draft_review',
    title: 'Draft a review',
    description: 'A weekly or monthly review draft built from the records. It is returned only: nothing is saved.',
    requiredScope: 'draft:review',
    inputSchema: obj({ entityId: entityIdSchema, kind: { type: 'string', enum: ['weekly', 'monthly'] } }),
    parse: (args) => DraftInput.parse(args ?? {}),
    handler: (input, { call, providers }) => providers.agentData.draftReview(call, input as unknown as Record<string, unknown>),
  });
}

/**
 * Route module that installs the real providers and their MCP tools. It is listed in
 * `dataRouteModules`, so `buildApp` runs it after the core routes are in place.
 */
export function registerDataProviders(app: FastifyInstance): void {
  const ctx = app.fos;
  const real = createDataProviders(ctx);
  // Only the honest defaults are replaced: an explicitly injected provider wins.
  if (ctx.providers.glance === unavailableGlanceProvider) ctx.providers.glance = real.glance;
  if (ctx.providers.agentData === unavailableAgentDataProvider) ctx.providers.agentData = real.agentData;
  if (ctx.providers.suggestions === unavailableSuggestionSink) ctx.providers.suggestions = real.suggestions;
  registerDataMcpTools(ctx);
}
