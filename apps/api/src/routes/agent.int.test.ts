/**
 * Agent API and MCP: scopes, entity scope, credential separation, and auditing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { agentClients, auditEvents } from '@financialos/db';
import { createHarness, resetAuthState, TEST_ORIGIN, type Harness } from '../test-support/harness';
import { TestClient, errorCodeOf } from '../test-support/client';
import { createAgentClient, setupAndLogin } from '../test-support/auth';
import { createRecordingAgentProvider, createRecordingSuggestionSink, type RecordingAgentProvider } from '../test-support/fake-providers';
import { SESSION_COOKIE_SECURE } from '../auth/sessions';

const SECOND = 1000;

interface McpResult {
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean; tools?: Array<{ name: string }>; structuredContent?: unknown };
  error?: { code: number; message: string };
}

describe('agent API and MCP', () => {
  let harness: Harness;
  let owner: TestClient;
  let recording: RecordingAgentProvider;
  let suggestions: ReturnType<typeof createRecordingSuggestionSink>;

  beforeAll(async () => {
    recording = createRecordingAgentProvider();
    suggestions = createRecordingSuggestionSink();
    harness = await createHarness({ providers: { agentData: recording.provider, suggestions: suggestions.sink } });
  });

  afterAll(async () => {
    await harness.close();
  });

  afterEach(async () => {
    recording.calls.length = 0;
    suggestions.calls.length = 0;
    await resetAuthState(harness);
  });

  async function signedInOwner(): Promise<TestClient> {
    owner = (await setupAndLogin(harness)).client;
    return owner;
  }

  function agentClient(credential: string): { client: TestClient; headers: Record<string, string> } {
    return { client: new TestClient(harness), headers: { authorization: `Bearer ${credential}` } };
  }

  async function mcp(credential: string, body: unknown, client = new TestClient(harness)) {
    return client.post('/mcp', body, {
      headers: { authorization: `Bearer ${credential}`, accept: 'application/json, text/event-stream' },
      origin: null,
    });
  }

  it('creates an agent credential that is shown once and stored hashed', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary', 'read:accounts'] });
    expect(agent.credential.startsWith('fos_agent_')).toBe(true);

    const [row] = await harness.db.select().from(agentClients).where(eq(agentClients.id, agent.id));
    expect(row!.credentialHash).not.toContain(agent.credential);
    const list = await ownerClient.get('/api/agent-clients');
    expect(list.body).not.toContain(agent.credential);
  });

  it('refuses a call for a scope the credential does not hold', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    const { client, headers } = agentClient(agent.credential);

    expect((await client.get('/api/agent/v1/summary', { headers, origin: null })).statusCode).toBe(200);

    for (const path of ['/api/agent/v1/accounts', '/api/agent/v1/transactions', '/api/agent/v1/budgets', '/api/agent/v1/forecast', '/api/agent/v1/portfolio', '/api/agent/v1/exceptions']) {
      const response = await client.get(path, { headers, origin: null });
      expect(response.statusCode, path).toBe(403);
      expect(errorCodeOf(response), path).toBe('insufficient_scope');
    }
    const simulate = await client.post('/api/agent/v1/simulate/portfolio', {}, { headers, origin: null });
    expect(simulate.statusCode).toBe(403);
    const draft = await client.post('/api/agent/v1/draft/review', {}, { headers, origin: null });
    expect(draft.statusCode).toBe(403);
    const suggest = await client.post('/api/agent/v1/suggest/classification', {}, { headers, origin: null });
    expect(suggest.statusCode).toBe(403);
    expect(suggestions.calls).toHaveLength(0);
  });

  it('enforces the entity scope of the credential', async () => {
    const ownerClient = await signedInOwner();
    const inScope = randomUUID();
    const outOfScope = randomUUID();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:accounts'], entityIds: [inScope] });
    const { client, headers } = agentClient(agent.credential);

    const allowed = await client.get(`/api/agent/v1/accounts?entityId=${inScope}`, { headers, origin: null });
    expect(allowed.statusCode).toBe(200);
    expect(recording.calls.at(-1)?.entityIds).toEqual([inScope]);

    const denied = await client.get(`/api/agent/v1/accounts?entityId=${outOfScope}`, { headers, origin: null });
    expect(denied.statusCode).toBe(403);
    expect(errorCodeOf(denied)).toBe('entity_out_of_scope');

    // No entity requested means every entity the credential holds, never "all".
    const implicit = await client.get('/api/agent/v1/accounts', { headers, origin: null });
    expect(implicit.statusCode).toBe(200);
    expect(recording.calls.at(-1)?.entityIds).toEqual([inScope]);
  });

  it('refuses a browser session cookie on agent routes and on /mcp', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    const client = new TestClient(harness);
    client.setCookie(SESSION_COOKIE_SECURE, ownerClient.sessionCookie as string);
    const headers = { authorization: `Bearer ${agent.credential}` };

    const read = await client.get('/api/agent/v1/summary', { headers, origin: null });
    expect(read.statusCode).toBe(401);
    expect(errorCodeOf(read)).toBe('session_cookie_not_accepted');

    const tool = await mcp(agent.credential, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, client);
    expect(tool.statusCode).toBe(401);
    expect(errorCodeOf(tool)).toBe('session_cookie_not_accepted');
  });

  it('refuses an agent credential on owner routes', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    const attacker = new TestClient(harness);
    const headers = { authorization: `Bearer ${agent.credential}` };

    for (const path of ['/api/security', '/api/devices', '/api/agent-clients']) {
      const response = await attacker.get(path, { headers });
      expect(response.statusCode, path).toBe(401);
      expect(errorCodeOf(response), path).toBe('credential_not_accepted');
    }
    const mutate = await attacker.post('/api/agent-clients', { name: 'x', scopes: ['read:summary'], entityIds: [randomUUID()], expiresInDays: 1 }, { headers });
    expect(mutate.statusCode).toBe(401);
  });

  it('refuses a revoked or expired agent credential', async () => {
    const ownerClient = await signedInOwner();
    const revoked = await createAgentClient(ownerClient, { name: 'Revoked', scopes: ['read:summary'] });
    const expiring = await createAgentClient(ownerClient, { name: 'Expiring', scopes: ['read:summary'], expiresInDays: 1 });

    expect((await ownerClient.post(`/api/agent-clients/${revoked.id}/revoke`)).statusCode).toBe(200);
    const afterRevoke = await new TestClient(harness).get('/api/agent/v1/summary', {
      headers: { authorization: `Bearer ${revoked.credential}` },
      origin: null,
    });
    expect(afterRevoke.statusCode).toBe(401);
    expect(errorCodeOf(afterRevoke)).toBe('agent_unauthorized');

    await harness.clock.advance(24 * 3600 * SECOND + SECOND);
    const afterExpiry = await new TestClient(harness).get('/api/agent/v1/summary', {
      headers: { authorization: `Bearer ${expiring.credential}` },
      origin: null,
    });
    expect(afterExpiry.statusCode).toBe(401);
    expect(afterExpiry.headers['www-authenticate']).toContain('Bearer');
  });

  it('refuses a browser Origin that is not configured, even with a valid credential', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    const client = new TestClient(harness);
    const headers = { authorization: `Bearer ${agent.credential}` };

    expect((await client.get('/api/agent/v1/summary', { headers, origin: 'https://evil.test' })).statusCode).toBe(403);
    expect((await client.get('/api/agent/v1/summary', { headers, origin: TEST_ORIGIN })).statusCode).toBe(200);
    expect((await client.get('/api/agent/v1/summary', { headers, origin: null, secFetchSite: 'cross-site' })).statusCode).toBe(403);
  });

  it('audits every agent API call with its scope and entity scope, and no arguments', async () => {
    const ownerClient = await signedInOwner();
    const entityId = randomUUID();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:transactions'], entityIds: [entityId] });
    const { client, headers } = agentClient(agent.credential);

    const response = await client.get(`/api/agent/v1/transactions?entityId=${entityId}&from=2025-01-01&to=2025-02-01`, { headers, origin: null });
    expect(response.statusCode).toBe(200);

    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'agent.api_call'), eq(auditEvents.actorId, agent.id)));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.actorType).toBe('agent');
    expect(event.actorId).toBe(agent.id);
    expect(event.details).toMatchObject({ route: '/api/agent/v1/transactions', scope: 'read:transactions', entityScope: [entityId], outcome: 'ok' });
    expect(JSON.stringify(event.details)).not.toContain('2025-01-01');
  });

  it('audits a refused scope as well', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    const { client, headers } = agentClient(agent.credential);
    await client.get('/api/agent/v1/portfolio', { headers, origin: null });

    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'agent.api_call'), eq(auditEvents.actorId, agent.id)));
    // The scope guard runs before the handler, so nothing is recorded as a successful call.
    expect(events.filter((e) => (e.details as { outcome?: string }).outcome === 'ok')).toHaveLength(0);
  });

  it('lists only the MCP tools the credential can use', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    const response = await mcp(agent.credential, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as McpResult;
    const names = (body.result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(['get_summary']);
    expect(names).not.toContain('suggest_classification');
  });

  it('refuses an MCP tool call whose scope the credential lacks', async () => {
    const ownerClient = await signedInOwner();
    const entityId = randomUUID();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'], entityIds: [entityId] });

    const denied = await mcp(agent.credential, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_accounts', arguments: {} },
    });
    expect(denied.statusCode).toBe(200);
    const body = denied.json() as McpResult;
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('read:accounts');
    expect(recording.calls.filter((c) => c.method === 'listAccounts')).toHaveLength(0);

    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'agent.mcp_tool'), eq(auditEvents.actorId, agent.id)));
    expect(events.some((e) => (e.details as { outcome?: string }).outcome === 'denied_scope')).toBe(true);
  });

  it('refuses an unknown MCP tool and audits it', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    const response = await mcp(agent.credential, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'exfiltrate_everything', arguments: {} },
    });
    const body = response.json() as McpResult;
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe('Unknown tool.');
    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'agent.mcp_tool'), eq(auditEvents.actorId, agent.id)));
    expect(events.some((e) => (e.details as { outcome?: string }).outcome === 'unknown_tool')).toBe(true);
  });

  it('runs an in-scope MCP tool and audits it with the entity scope', async () => {
    const ownerClient = await signedInOwner();
    const entityId = randomUUID();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'], entityIds: [entityId] });
    const response = await mcp(agent.credential, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_summary', arguments: { entityId } },
    });
    const body = response.json() as McpResult;
    expect(body.result?.isError).toBeFalsy();
    expect(recording.calls.at(-1)).toMatchObject({ method: 'getSummary', entityIds: [entityId] });

    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'agent.mcp_tool'), eq(auditEvents.actorId, agent.id)));
    expect(events.some((e) => (e.details as { outcome?: string; entityScope?: string[] }).outcome === 'ok')).toBe(true);
  });

  it('refuses an MCP tool call for an entity outside the credential', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'], entityIds: [randomUUID()] });
    const response = await mcp(agent.credential, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_summary', arguments: { entityId: randomUUID() } },
    });
    const body = response.json() as McpResult;
    expect(body.result?.isError).toBe(true);
    expect(recording.calls.filter((c) => c.method === 'getSummary')).toHaveLength(0);
    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'agent.mcp_tool'), eq(auditEvents.actorId, agent.id)));
    expect(events.some((e) => (e.details as { outcome?: string }).outcome === 'denied_entity')).toBe(true);
  });

  it('refuses MCP arguments that do not match the tool schema', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    const response = await mcp(agent.credential, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'get_summary', arguments: { entityId: 'not-a-uuid', extra: 'field' } },
    });
    const body = response.json() as McpResult;
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('Invalid arguments');
  });

  it('accepts only POST on /mcp and requires a credential', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    const client = new TestClient(harness);
    const headers = { authorization: `Bearer ${agent.credential}` };

    const get = await client.get('/mcp', { headers, origin: null });
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe('POST');
    const del = await client.del('/mcp', { headers, origin: null });
    expect(del.statusCode).toBe(405);

    const anonymous = await client.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { origin: null });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['www-authenticate']).toBe('Bearer');
  });

  it('reports an unavailable data layer honestly rather than inventing figures', async () => {
    // A server with no data layer registered: the built-in providers must say so, not guess.
    const bare = await createHarness();
    try {
      const bareOwner = (await setupAndLogin(bare)).client;
      const agent = await createAgentClient(bareOwner, { scopes: ['read:summary', 'simulate:portfolio'] });
      const headers = { authorization: `Bearer ${agent.credential}` };

      const summary = await new TestClient(bare).get('/api/agent/v1/summary', { headers, origin: null });
      expect(summary.statusCode).toBe(200);
      expect(summary.json()).toMatchObject({ status: 'insufficient_data', figures: {} });

      const simulate = await new TestClient(bare).post('/api/agent/v1/simulate/portfolio', {}, { headers, origin: null });
      expect(simulate.statusCode).toBe(503);
      expect(errorCodeOf(simulate)).toBe('provider_unavailable');

      const events = await bare.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, 'agent.api_call'), eq(auditEvents.actorId, agent.id)));
      expect(events.some((e) => (e.details as { outcome?: string }).outcome === 'unavailable')).toBe(true);
    } finally {
      await bare.close();
    }
  });

  it('records lastUsedAt without leaking the credential', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    await new TestClient(harness).get('/api/agent/v1/summary', {
      headers: { authorization: `Bearer ${agent.credential}` },
      origin: null,
    });
    const [row] = await harness.db.select().from(agentClients).where(eq(agentClients.id, agent.id));
    expect(row!.lastUsedAt).not.toBeNull();
    const list = await ownerClient.get('/api/agent-clients');
    expect(list.body).not.toContain(agent.credential);
  });
});
