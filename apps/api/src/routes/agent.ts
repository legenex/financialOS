/**
 * Agent API (`/api/agent/v1/*`) and owner management of agent credentials.
 *
 * Agent credentials are separate from the owner session: they cannot mint sessions, they are
 * refused on owner routes, and session cookies are refused here. Every call is audited with
 * its scope and entity scope (never its arguments).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { agentClients } from '@financialos/db';
import { AgentClientInput, type AgentClient, type AgentClientCreated, type AgentScope } from '@financialos/contracts';
import { generatePrefixedCredential } from '@financialos/security/tokens';
import { addSeconds } from '../clock';
import { ApiError, errors } from '../errors';
import { RATE_LIMITS } from '../plugins/rate-limit';
import { ProviderUnavailableError, type AgentCallContext } from '../providers';
import { parseBody } from '../validation';
import { agentCallContext, agentCredentialHash, agentOf, requireAgent, requireScope, resolveEntityScope } from '../auth/agent-auth';
import { registerOwnerRoutes } from '../auth/guards';
import { UUID_SHAPE } from '../auth/sessions';

type AgentClientRow = typeof agentClients.$inferSelect;

export const AgentQuery = z.object({
  entityId: z.uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.string().regex(/^[a-z_]{1,32}$/).optional(),
});

const SuggestClassificationBody = z.object({
  entityId: z.uuid().optional(),
  transactionId: z.uuid(),
  nature: z.string().regex(/^[a-z_]{1,40}$/),
  categoryId: z.uuid().nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']),
  rationale: z.string().min(1).max(1000),
});

const DraftBody = z.object({ entityId: z.uuid().optional() }).catchall(z.unknown());

function clientView(row: AgentClientRow): AgentClient {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes as AgentScope[],
    entityIds: row.entityIds,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

async function auditAgentCall(req: FastifyRequest, route: string, scope: AgentScope, ctx: AgentCallContext, outcome: string): Promise<void> {
  const agent = agentOf(req);
  await req.server.fos.audit.fromRequest(req, 'agent.api_call', { type: 'agent_client', id: agent.id }, `Agent ${route} (${outcome})`, {
    route,
    scope,
    entityScope: ctx.entityIds,
    outcome,
  });
}

/** Runs a provider call with auditing and honest unavailability errors. */
async function runAgentCall<T>(req: FastifyRequest, route: string, scope: AgentScope, ctx: AgentCallContext, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    await auditAgentCall(req, route, scope, ctx, 'ok');
    return result;
  } catch (err) {
    await auditAgentCall(req, route, scope, ctx, err instanceof ProviderUnavailableError ? 'unavailable' : 'error');
    if (err instanceof ProviderUnavailableError) throw new ApiError(503, 'provider_unavailable', err.message);
    throw err;
  }
}

export function registerAgentRoutes(app: FastifyInstance): void {
  app.register(async (scope) => {
    scope.addHook('onRequest', requireAgent);

    const read = (path: string, needed: AgentScope, fn: (ctx: AgentCallContext, query: z.infer<typeof AgentQuery>, req: FastifyRequest) => Promise<unknown>) => {
      scope.get(path, { preHandler: requireScope(needed), config: { rateLimit: RATE_LIMITS.agent } }, async (req) => {
        const query = parseBody(AgentQuery, req.query);
        const ctx = agentCallContext(req, resolveEntityScope(agentOf(req), query.entityId));
        return runAgentCall(req, path, needed, ctx, () => fn(ctx, query, req));
      });
    };

    read('/api/agent/v1/summary', 'read:summary', (ctx, _q, req) => req.server.fos.providers.agentData.getSummary(ctx));
    read('/api/agent/v1/accounts', 'read:accounts', (ctx, q, req) => req.server.fos.providers.agentData.listAccounts(ctx, q));
    read('/api/agent/v1/transactions', 'read:transactions', (ctx, q, req) => req.server.fos.providers.agentData.listTransactions(ctx, q));
    read('/api/agent/v1/budgets', 'read:budgets', (ctx, q, req) => req.server.fos.providers.agentData.getBudgets(ctx, q));
    read('/api/agent/v1/forecast', 'read:forecast', (ctx, _q, req) => req.server.fos.providers.agentData.getForecast(ctx));
    read('/api/agent/v1/portfolio', 'read:portfolio', (ctx, _q, req) => req.server.fos.providers.agentData.getPortfolio(ctx));
    read('/api/agent/v1/exceptions', 'read:exceptions', (ctx, q, req) => req.server.fos.providers.agentData.listExceptions(ctx, q));

    const limited = { config: { rateLimit: RATE_LIMITS.agent } };

    scope.post('/api/agent/v1/simulate/portfolio', { ...limited, preHandler: requireScope('simulate:portfolio') }, async (req) => {
      const body = parseBody(DraftBody, req.body);
      const ctx = agentCallContext(req, resolveEntityScope(agentOf(req), body.entityId));
      return runAgentCall(req, '/api/agent/v1/simulate/portfolio', 'simulate:portfolio', ctx, () =>
        req.server.fos.providers.agentData.simulatePortfolio(ctx, body),
      );
    });

    scope.post('/api/agent/v1/draft/review', { ...limited, preHandler: requireScope('draft:review') }, async (req) => {
      const body = parseBody(DraftBody, req.body);
      const ctx = agentCallContext(req, resolveEntityScope(agentOf(req), body.entityId));
      return runAgentCall(req, '/api/agent/v1/draft/review', 'draft:review', ctx, () => req.server.fos.providers.agentData.draftReview(ctx, body));
    });

    scope.post('/api/agent/v1/suggest/classification', { ...limited, preHandler: requireScope('suggest:classification') }, async (req, reply) => {
      const body = parseBody(SuggestClassificationBody, req.body);
      const ctx = agentCallContext(req, resolveEntityScope(agentOf(req), body.entityId));
      const result = await runAgentCall(req, '/api/agent/v1/suggest/classification', 'suggest:classification', ctx, () =>
        req.server.fos.providers.suggestions.createAgentSuggestion(ctx, {
          transactionId: body.transactionId,
          nature: body.nature,
          categoryId: body.categoryId,
          confidence: body.confidence,
          rationale: body.rationale,
        }),
      );
      return reply.code(201).send(result);
    });
  });

  registerOwnerRoutes(app, (scope) => {
    scope.get('/api/agent-clients', async (req): Promise<AgentClient[]> => {
      const rows = await req.server.fos.db.select().from(agentClients).orderBy(desc(agentClients.createdAt)).limit(200);
      return rows.map(clientView);
    });

    scope.post('/api/agent-clients', async (req, reply): Promise<AgentClientCreated> => {
      const input = parseBody(AgentClientInput, req.body);
      const { db, clock, audit } = req.server.fos;
      const now = clock.now();
      const credential = generatePrefixedCredential('agent');
      const [row] = await db
        .insert(agentClients)
        .values({
          name: input.name,
          credentialHash: agentCredentialHash(credential),
          scopes: [...new Set(input.scopes)],
          entityIds: [...new Set(input.entityIds.map((id) => id.toLowerCase()))],
          createdAt: now,
          expiresAt: addSeconds(now, input.expiresInDays * 24 * 3600),
        })
        .returning();
      if (!row) throw new Error('agent client insert returned no row');
      await audit.fromRequest(req, 'agent_client.created', { type: 'agent_client', id: row.id }, `Agent credential created (${row.name})`, {
        scopes: row.scopes,
        entityIds: row.entityIds,
        expiresAt: row.expiresAt.toISOString(),
      });
      reply.code(201);
      return { client: clientView(row), credential };
    });

    scope.post<{ Params: { id: string } }>('/api/agent-clients/:id/revoke', async (req): Promise<AgentClient> => {
      if (!UUID_SHAPE.test(req.params.id)) throw errors.notFound();
      const { db, clock, audit } = req.server.fos;
      const [updated] = await db
        .update(agentClients)
        .set({ revokedAt: clock.now() })
        .where(and(eq(agentClients.id, req.params.id), isNull(agentClients.revokedAt)))
        .returning();
      const row = updated ?? (await db.select().from(agentClients).where(eq(agentClients.id, req.params.id)).limit(1))[0];
      if (!row) throw errors.notFound('agent_client_not_found', 'Agent credential not found.');
      if (updated) await audit.fromRequest(req, 'agent_client.revoked', { type: 'agent_client', id: row.id }, `Agent credential revoked (${row.name})`);
      return clientView(row);
    });
  });
}
