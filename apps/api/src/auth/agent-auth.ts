import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { agentClients } from '@financialos/db';
import { AgentScope, type AgentScope as AgentScopeValue } from '@financialos/contracts';
import { isPrefixedCredential, sha256Hex } from '@financialos/security/tokens';
import type { AgentPrincipal } from '../context';
import { ApiError, errors } from '../errors';
import type { AgentCallContext } from '../providers';
import { UUID_SHAPE } from './sessions';

const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export function agentCredentialHash(credential: string): string {
  return sha256Hex(`agent-credential:${credential}`);
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{8,200})$/.exec(header);
  return match?.[1] ?? null;
}

/**
 * Agent-credential guard for /api/agent/* and /mcp. Session cookies and device credentials are
 * refused. Attaches `req.agent`.
 */
export async function requireAgent(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const { db, clock, sessions } = req.server.fos;
  if (req.cookies[sessions.cookieName] !== undefined) {
    throw new ApiError(401, 'session_cookie_not_accepted', 'Agent endpoints do not accept browser sessions.');
  }
  const token = bearerToken(req);
  if (!token || !isPrefixedCredential(token, 'agent')) {
    throw new ApiError(401, 'agent_unauthorized', 'A valid agent credential is required.', { headers: { 'www-authenticate': 'Bearer' } });
  }
  const [row] = await db.select().from(agentClients).where(eq(agentClients.credentialHash, agentCredentialHash(token))).limit(1);
  const now = clock.now();
  if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) {
    throw new ApiError(401, 'agent_unauthorized', 'The agent credential is not valid, was revoked, or expired.', {
      headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
    });
  }
  const scopes = row.scopes.filter((s): s is AgentScopeValue => AgentScope.safeParse(s).success);
  req.agent = { id: row.id, name: row.name, scopes, entityIds: [...row.entityIds] };
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS) {
    await db.update(agentClients).set({ lastUsedAt: now }).where(eq(agentClients.id, row.id));
  }
}

export function agentOf(req: FastifyRequest): AgentPrincipal {
  if (!req.agent) throw new ApiError(401, 'agent_unauthorized', 'A valid agent credential is required.');
  return req.agent;
}

export function hasScope(agent: AgentPrincipal, scope: AgentScopeValue): boolean {
  return agent.scopes.includes(scope);
}

/** Route-level scope check: `{ preHandler: requireScope('read:accounts') }`. */
export function requireScope(scope: AgentScopeValue) {
  return async function scopeGuard(req: FastifyRequest): Promise<void> {
    if (!hasScope(agentOf(req), scope)) {
      throw errors.forbidden('insufficient_scope', `This agent credential lacks the ${scope} scope.`);
    }
  };
}

export class EntityScopeError extends ApiError {
  constructor() {
    super(403, 'entity_out_of_scope', 'This agent credential may not read that entity.');
  }
}

/**
 * Entities a call may touch: the requested ones (each must be in the credential's scope) or,
 * when none is requested, every entity in scope. Never returns an empty list.
 */
export function resolveEntityScope(agent: AgentPrincipal, requested?: string | readonly string[] | null): string[] {
  const list = requested === undefined || requested === null ? [] : typeof requested === 'string' ? [requested] : [...requested];
  if (list.length === 0) {
    if (agent.entityIds.length === 0) throw new EntityScopeError();
    return [...agent.entityIds];
  }
  for (const id of list) {
    if (!UUID_SHAPE.test(id) || !agent.entityIds.includes(id.toLowerCase())) throw new EntityScopeError();
  }
  return [...new Set(list.map((id) => id.toLowerCase()))];
}

export function agentCallContext(req: FastifyRequest, entityIds: string[]): AgentCallContext {
  const agent = agentOf(req);
  return { clientId: agent.id, clientName: agent.name, scopes: agent.scopes, entityIds, now: req.server.fos.clock.now() };
}
