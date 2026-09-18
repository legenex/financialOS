import { z } from 'zod';
import { McpToolRegistry, type JsonSchemaObject } from './registry';

const entityIdSchema = { type: 'string', format: 'uuid', description: 'Limit the result to one entity in this credential’s scope.' };
const pageProps = {
  cursor: { type: 'string', maxLength: 200 },
  limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
};

const SummaryInput = z.object({ entityId: z.uuid().optional() }).strict();
const ListInput = z
  .object({
    entityId: z.uuid().optional(),
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
const ExceptionsInput = ListInput.extend({ status: z.enum(['open', 'resolved', 'dismissed', 'snoozed']).optional() }).strict();
const SuggestInput = z
  .object({
    entityId: z.uuid().optional(),
    transactionId: z.uuid(),
    nature: z.string().regex(/^[a-z_]{1,40}$/),
    categoryId: z.uuid().nullable().default(null),
    confidence: z.enum(['high', 'medium', 'low']),
    rationale: z.string().min(1).max(1000),
  })
  .strict();

const obj = (properties: Record<string, unknown>, required: string[] = []): JsonSchemaObject => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** The default tool set. Data comes from the injected providers. */
export function createDefaultToolRegistry(): McpToolRegistry {
  const registry = new McpToolRegistry();
  registry.register({
    name: 'get_summary',
    title: 'Financial summary',
    description: 'Deterministic summary figures for the entities in scope. Amounts are decimal strings; unknown values are null.',
    requiredScope: 'read:summary',
    inputSchema: obj({ entityId: entityIdSchema }),
    parse: (args) => SummaryInput.parse(args ?? {}),
    handler: (_input, { call, providers }) => providers.agentData.getSummary(call),
  });
  registry.register({
    name: 'list_accounts',
    title: 'Accounts',
    description: 'Accounts for the entities in scope, with ownership and liquidity class.',
    requiredScope: 'read:accounts',
    inputSchema: obj({ entityId: entityIdSchema, ...pageProps }),
    parse: (args) => ListInput.parse(args ?? {}),
    handler: (input, { call, providers }) =>
      providers.agentData.listAccounts(call, { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) }),
  });
  registry.register({
    name: 'list_exceptions',
    title: 'Exception inbox',
    description: 'Open review items (unclassified transactions, reconciliation questions, stale connections) in scope.',
    requiredScope: 'read:exceptions',
    inputSchema: obj({ entityId: entityIdSchema, status: { type: 'string', enum: ['open', 'resolved', 'dismissed', 'snoozed'] }, ...pageProps }),
    parse: (args) => ExceptionsInput.parse(args ?? {}),
    handler: (input, { call, providers }) =>
      providers.agentData.listExceptions(call, {
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.status ? { status: input.status } : {}),
      }),
  });
  registry.register({
    name: 'suggest_classification',
    title: 'Suggest a classification',
    description:
      'Proposes a classification for one transaction. Creates an item in the owner’s exception inbox; it never changes the ledger.',
    requiredScope: 'suggest:classification',
    mutates: true,
    inputSchema: obj(
      {
        entityId: entityIdSchema,
        transactionId: { type: 'string', format: 'uuid' },
        nature: { type: 'string', pattern: '^[a-z_]{1,40}$' },
        categoryId: { type: ['string', 'null'], format: 'uuid' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        rationale: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      ['transactionId', 'nature', 'confidence', 'rationale'],
    ),
    parse: (args) => SuggestInput.parse(args ?? {}),
    handler: (input, { call, providers }) =>
      providers.suggestions.createAgentSuggestion(call, {
        transactionId: input.transactionId,
        nature: input.nature,
        categoryId: input.categoryId,
        confidence: input.confidence,
        rationale: input.rationale,
      }),
  });
  return registry;
}
