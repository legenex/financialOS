import { z } from 'zod';
import type { AllowlistEntry } from '@financialos/security/net';
import type { AdapterContext } from '../core/context';
import { InvalidConfigError, ReadOnlyViolationError } from '../core/errors';
import { connectMcp, type McpSession, type McpToolResult } from './mcpClient';
import { getAccessToken, type TokenStore } from './mcpOAuth';
import type { ConnectionTestResult, ProviderAdapter } from './types';

/**
 * Owner-approved remote MCP servers.
 *
 * A custom MCP server is a network endpoint, never a program. Any configuration that names a command, an
 * argument list, an environment block, or the stdio transport is rejected outright: FinancialOS does not
 * launch processes on behalf of a connection, and a configuration that asks it to is treated as a mistake or
 * an attack, not as an alternative transport.
 */

/** Keys that mean "run a local program". Their presence fails validation. */
export const FORBIDDEN_MCP_CONFIG_KEYS = ['command', 'args', 'argv', 'env', 'cwd', 'stdio', 'spawn', 'exec', 'shell', 'entrypoint'] as const;

export const CustomMcpConfig = z
  .object({
    url: z.string().max(2048),
    transport: z.literal('http').optional(),
    /** Tool names the owner approved by name, beyond what the read-only classifier accepts on its own. */
    allowTools: z.array(z.string().max(128)).max(100).default([]),
    denyTools: z.array(z.string().max(128)).max(100).default([]),
    maxOutputBytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(256 * 1024),
    requestTimeoutMs: z.number().int().min(1000).max(120_000).default(60_000),
  })
  .strict();
export type CustomMcpConfig = z.infer<typeof CustomMcpConfig>;

function assertNoProcessTransport(raw: unknown): void {
  if (raw === null || typeof raw !== 'object') return;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const lower = key.toLowerCase();
    if ((FORBIDDEN_MCP_CONFIG_KEYS as readonly string[]).includes(lower)) {
      throw new ReadOnlyViolationError(
        `the MCP connection configuration contains "${key}". FinancialOS connects to remote MCP servers over HTTPS only and never launches a local process for a connection.`,
      );
    }
  }
  const transport = record.transport;
  if (typeof transport === 'string' && transport.toLowerCase() !== 'http' && transport.toLowerCase() !== 'streamable-http') {
    throw new ReadOnlyViolationError(`the MCP transport "${transport}" is not supported. Only remote Streamable HTTP servers are allowed.`);
  }
}

function hostIsAllowlisted(allowlist: readonly AllowlistEntry[], url: URL): boolean {
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  return allowlist.some((entry) => entry.scheme === scheme && entry.host.toLowerCase() === host && entry.port === port);
}

/**
 * Validates an owner-supplied MCP configuration. Rejects process transports first, then requires https unless
 * the owner has explicitly allowlisted the host and port for plain http.
 */
export function parseCustomMcpConfig(raw: unknown, allowlist: readonly AllowlistEntry[] = []): CustomMcpConfig {
  assertNoProcessTransport(raw);
  const parsed = CustomMcpConfig.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new InvalidConfigError(`The custom MCP configuration is not valid${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
  }
  const config = parsed.data;
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new InvalidConfigError('The MCP server URL is not a valid absolute URL.');
  }
  if (url.protocol === 'http:') {
    if (!hostIsAllowlisted(allowlist, url)) {
      throw new InvalidConfigError('Plain http is only allowed for a host the owner has added to the outbound allowlist.');
    }
  } else if (url.protocol !== 'https:') {
    throw new InvalidConfigError(`The MCP server URL must use https (got ${url.protocol}).`);
  }
  if (url.username || url.password) throw new InvalidConfigError('Credentials in the MCP server URL are not accepted.');
  return config;
}

export interface CustomMcpSessionOptions {
  /** Supplies a bearer token when the server is OAuth-protected. Omit for a server that needs none. */
  tokenStore?: TokenStore | null;
}

/** Opens a session against an owner-approved server and closes it when `run` finishes. */
export async function withCustomMcpSession<T>(ctx: AdapterContext, run: (session: McpSession, config: CustomMcpConfig) => Promise<T>, options: CustomMcpSessionOptions = {}): Promise<T> {
  const config = parseCustomMcpConfig(ctx.config.server ?? ctx.config, ctx.allowlist);
  let accessToken: string | null = null;
  if (options.tokenStore) {
    accessToken = (await getAccessToken(ctx, options.tokenStore)).accessToken;
  } else if (ctx.credentials.accessToken) {
    accessToken = ctx.credentials.accessToken;
  }
  const session = await connectMcp(ctx, {
    url: config.url,
    accessToken,
    policy: { extraAllowed: config.allowTools, denied: config.denyTools },
    maxOutputBytes: config.maxOutputBytes,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  try {
    await session.listTools();
    return await run(session, config);
  } finally {
    await session.close();
  }
}

/** Calls one approved read-only tool and returns its output as inert data. */
export async function callCustomMcpTool(ctx: AdapterContext, toolName: string, args: Record<string, unknown> = {}, options: CustomMcpSessionOptions = {}): Promise<McpToolResult> {
  return withCustomMcpSession(ctx, async (session) => session.callTool(toolName, args), options);
}

export const customMcpAdapter: ProviderAdapter = {
  key: 'custom_mcp',
  method: 'mcp_oauth',
  readOnly: true,

  async test(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const config = parseCustomMcpConfig(ctx.config.server ?? ctx.config, ctx.allowlist);
    return withCustomMcpSession(ctx, async (session) => {
      const { allowed, denied } = await session.listTools();
      return {
        ok: true,
        detail: `The server exposed ${allowed.length + denied.length} tool(s); ${allowed.length} passed the read-only check.`,
        grantedScopes: [],
        identity: session.serverInfo ? `${session.serverInfo.name} ${session.serverInfo.version}` : null,
        observations: [
          `Allowed tools: ${allowed.map((t) => t.name).join(', ') || 'none'}`,
          `Refused tools: ${denied.map((d) => `${d.name} (${d.reason})`).join('; ') || 'none'}`,
          `Output cap: ${config.maxOutputBytes} bytes per tool call.`,
          'Tool output is returned as inert data. Text from a remote server is never treated as an instruction.',
        ],
      } satisfies ConnectionTestResult;
    });
  },
};
