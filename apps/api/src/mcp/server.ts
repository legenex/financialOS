/**
 * Read-only MCP over Streamable HTTP in stateless mode: every POST creates a fresh server and
 * transport, handles one JSON-RPC exchange, and closes. Authentication is the agent credential;
 * each tool checks its scope and the entity scope, and every call is audited.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { APP_VERSION } from '../version';
import { ApiError } from '../errors';
import { RATE_LIMITS } from '../plugins/rate-limit';
import { ProviderUnavailableError } from '../providers';
import { agentCallContext, agentOf, EntityScopeError, hasScope, requireAgent, resolveEntityScope } from '../auth/agent-auth';

const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'mcp-protocol-version', 'last-event-id'];
const RETURNED_RESPONSE_HEADERS = ['content-type', 'mcp-protocol-version', 'allow'];

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

async function auditTool(req: FastifyRequest, tool: string, scope: string | null, entityScope: string[], outcome: string): Promise<void> {
  const agent = agentOf(req);
  await req.server.fos.audit.fromRequest(req, 'agent.mcp_tool', { type: 'agent_client', id: agent.id }, `MCP tool ${tool} (${outcome})`, {
    tool,
    scope,
    entityScope,
    outcome,
  });
}

function buildServer(req: FastifyRequest): Server {
  const { mcpTools, providers } = req.server.fos;
  const agent = agentOf(req);
  const server = new Server({ name: 'financialos', version: APP_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mcpTools
      .list()
      .filter((tool) => hasScope(agent, tool.requiredScope))
      .map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: !tool.mutates, destructiveHint: false, openWorldHint: false },
      })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const tool = mcpTools.get(name);
    if (!tool) {
      await auditTool(req, name.slice(0, 64), null, [], 'unknown_tool');
      return toolError('Unknown tool.');
    }
    if (!hasScope(agent, tool.requiredScope)) {
      await auditTool(req, tool.name, tool.requiredScope, [], 'denied_scope');
      return toolError(`This credential lacks the ${tool.requiredScope} scope.`);
    }
    let input;
    try {
      input = tool.parse(request.params.arguments ?? {});
    } catch (err) {
      await auditTool(req, tool.name, tool.requiredScope, [], 'invalid_arguments');
      const fields = err instanceof ZodError ? err.issues.map((i) => i.path.join('.') || '(root)').join(', ') : 'arguments';
      return toolError(`Invalid arguments: ${fields}.`);
    }
    let entityIds: string[];
    try {
      entityIds = resolveEntityScope(agent, input.entityId);
    } catch (err) {
      if (!(err instanceof EntityScopeError)) throw err;
      await auditTool(req, tool.name, tool.requiredScope, [], 'denied_entity');
      return toolError('That entity is outside this credential’s scope.');
    }
    const call = agentCallContext(req, entityIds);
    try {
      const result = await tool.handler(input, { call, providers });
      await auditTool(req, tool.name, tool.requiredScope, entityIds, 'ok');
      const structured = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
      return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        await auditTool(req, tool.name, tool.requiredScope, entityIds, 'unavailable');
        return toolError(err.message);
      }
      await auditTool(req, tool.name, tool.requiredScope, entityIds, 'error');
      req.log.error({ err, tool: tool.name }, 'MCP tool failed');
      return toolError('The tool failed. Try again later.');
    }
  });

  return server;
}

export function registerMcpRoutes(app: FastifyInstance): void {
  app.post('/mcp', { onRequest: requireAgent, config: { rateLimit: RATE_LIMITS.agent } }, async (req, reply) => {
    const server = buildServer(req);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const headers = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const body = JSON.stringify(req.body ?? null);
      const response = await transport.handleRequest(new Request('http://127.0.0.1/mcp', { method: 'POST', headers, body }), {
        parsedBody: req.body,
      });
      const text = await response.text();
      reply.code(response.status);
      for (const name of RETURNED_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value) reply.header(name, value);
      }
      return reply.send(text);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  const notAllowed = async () => {
    throw new ApiError(405, 'method_not_allowed', 'This MCP endpoint is stateless and accepts POST only.', { headers: { allow: 'POST' } });
  };
  app.get('/mcp', { onRequest: requireAgent }, notAllowed);
  app.delete('/mcp', { onRequest: requireAgent }, notAllowed);
}
