import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SafeFetch } from '@financialos/security/net';
import type { AdapterContext } from '../core/context';
import { InvalidConfigError, ProviderUnavailableError, ReadOnlyViolationError } from '../core/errors';
import { redactUrl } from '../core/redact';
import { inertText } from './http';

/**
 * Streamable HTTP MCP client for remote, owner-approved servers.
 *
 * Three rules hold for every server, including the provider's own:
 *  1. Only tools that are demonstrably read-only may be called. Unknown is denied.
 *  2. Tool output is size-capped and reduced to inert text. It is data about the owner's money, never an
 *     instruction to this program or to any model downstream.
 *  3. Every byte travels through safeFetch, so the SSRF policy and the owner's outbound allowlist apply.
 */

export const MCP_CLIENT_NAME = 'financialos';
export const MCP_CLIENT_VERSION = '0.1.0';

/** Verbs that indicate an action rather than a read. A match anywhere in the tool name is fatal. */
export const WRITE_VERBS = [
  'pay',
  'transfer',
  'send',
  'order',
  'trade',
  'place',
  'cancel',
  'modify',
  'submit',
  'approve',
  'create',
  'update',
  'delete',
  'remove',
  'revoke',
  'execute',
  'buy',
  'sell',
  'withdraw',
  'deposit',
  'move',
  'issue',
  'freeze',
  'unfreeze',
  'reveal',
  'upload',
  'write',
  'set',
  'edit',
  'invite',
  'close',
  'open',
  'sign',
  'authorize',
] as const;

/** Prefixes that name a read. A tool must look like one of these unless it declares `readOnlyHint`. */
export const READ_PREFIXES = [
  'get',
  'list',
  'read',
  'fetch',
  'search',
  'query',
  'find',
  'lookup',
  'show',
  'view',
  'describe',
  'summarize',
  'summarise',
  'report',
  'count',
  'check',
  'inspect',
  'balance',
  'position',
  'holding',
  'portfolio',
  'account',
  'transaction',
  'statement',
  'history',
  'price',
  'quote',
  'market',
  'info',
  'status',
] as const;

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolInfo {
  name: string;
  title: string | null;
  description: string;
  annotations: McpToolAnnotations | null;
  inputSchema: unknown;
}

export interface ToolVerdict {
  allowed: boolean;
  reason: string;
}

export interface ToolPolicyOptions {
  /** Tool names the owner explicitly approved. They still fail if the name contains a write verb. */
  extraAllowed?: readonly string[];
  /** Tool names the owner explicitly refused. Checked first. */
  denied?: readonly string[];
}

function wordsOf(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasWriteWord(words: readonly string[]): string | null {
  for (const word of words) {
    for (const verb of WRITE_VERBS) {
      if (word === verb || word === `${verb}s` || word === `${verb}d` || word === `${verb}ed` || word === `${verb}ing`) return verb;
    }
  }
  return null;
}

/**
 * Decides whether a tool may be called. Denial is the default: a tool passes only when its name reads like a
 * query, or the server explicitly annotates it `readOnlyHint: true`, and in neither case may the *name* carry
 * an action verb. `readOnlyHint` is a server's claim, so it can rescue a description but never a name.
 */
export function classifyTool(tool: McpToolInfo, options: ToolPolicyOptions = {}): ToolVerdict {
  const name = tool.name.trim();
  if (!name || name.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(name)) {
    return { allowed: false, reason: 'the tool name is missing or has an unexpected shape' };
  }
  if (options.denied?.includes(name)) return { allowed: false, reason: 'the owner refused this tool' };
  const nameWords = wordsOf(name);
  const nameVerb = hasWriteWord(nameWords);
  if (nameVerb) return { allowed: false, reason: `the tool name contains the action verb "${nameVerb}"` };
  const readOnlyHint = tool.annotations?.readOnlyHint === true;
  if (tool.annotations?.readOnlyHint === false) return { allowed: false, reason: 'the server declares readOnlyHint: false' };
  if (tool.annotations?.destructiveHint === true) return { allowed: false, reason: 'the server declares destructiveHint: true' };
  if (!readOnlyHint) {
    const descVerb = hasWriteWord(wordsOf(tool.description.slice(0, 600)));
    if (descVerb) return { allowed: false, reason: `the description mentions "${descVerb}" and the server does not declare readOnlyHint` };
  }
  if (readOnlyHint) return { allowed: true, reason: 'the server declares readOnlyHint: true and the name contains no action verb' };
  if (options.extraAllowed?.includes(name)) return { allowed: true, reason: 'the owner approved this tool by name' };
  const first = nameWords[0] ?? '';
  if (READ_PREFIXES.some((p) => first === p || first.startsWith(p))) {
    return { allowed: true, reason: `the name begins with the read verb "${first}"` };
  }
  return { allowed: false, reason: 'the tool is not recognisably read-only and the server gives no readOnlyHint' };
}

export interface McpContentItem {
  kind: 'text' | 'other';
  /** Inert text for `kind: 'text'`. Never interpreted, never forwarded as instructions. */
  text: string;
  /** Original content type reported by the server, for non-text items. */
  mediaType: string | null;
}

export interface McpToolResult {
  toolName: string;
  content: McpContentItem[];
  /** Structured content, when the tool declares an output schema. Parsed as data only. */
  structured: unknown;
  isError: boolean;
  truncated: boolean;
  bytes: number;
}

export interface McpSession {
  serverInfo: { name: string; version: string } | null;
  listTools(): Promise<{ allowed: McpToolInfo[]; denied: Array<{ name: string; reason: string }> }>;
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

export interface McpConnectOptions {
  /** Absolute https URL (or an allowlisted local host) of the MCP endpoint. */
  url: string;
  /** Bearer token, when the server needs one. */
  accessToken?: string | null;
  policy?: ToolPolicyOptions;
  /** Total bytes of tool output kept. Anything beyond is dropped and the result is marked truncated. */
  maxOutputBytes?: number;
  /** Per-request timeout for MCP calls. */
  requestTimeoutMs?: number;
  clientName?: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Wraps safeFetch as a WHATWG-shaped fetch for the MCP SDK transport. The SDK never gets a raw fetch, so it
 * cannot reach a destination the owner has not allowed.
 */
export function safeFetchAsFetch(safeFetch: SafeFetch, defaults: { signal?: AbortSignal; totalTimeoutMs?: number; maxResponseBytes?: number } = {}): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
      throw new ReadOnlyViolationError(`MCP transport attempted ${method}`);
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers as ConstructorParameters<typeof Headers>[0]).forEach((value, key) => {
      headers[key] = value;
    });
    let body: string | null = null;
    if (typeof init.body === 'string') body = init.body;
    else if (init.body instanceof Uint8Array) body = Buffer.from(init.body).toString('utf8');
    else if (init.body != null) throw new InvalidConfigError('The MCP transport tried to send an unsupported body type');
    const signal = (init.signal as AbortSignal | null | undefined) ?? defaults.signal;
    const response = await safeFetch(url, {
      method: method as 'GET' | 'POST' | 'DELETE',
      headers,
      ...(body === null ? {} : { body }),
      ...(signal ? { signal } : {}),
      totalTimeoutMs: defaults.totalTimeoutMs ?? 120_000,
      maxResponseBytes: defaults.maxResponseBytes ?? 8 * 1024 * 1024,
      redirect: 'follow',
      sensitiveHeaders: ['authorization', 'mcp-session-id'],
    });
    return new Response(response.body as ConstructorParameters<typeof Response>[0], { status: response.status, headers: response.headers });
  };
}

function toToolInfo(raw: unknown): McpToolInfo {
  const record = (raw ?? {}) as Record<string, unknown>;
  const annotations = (record.annotations ?? null) as McpToolAnnotations | null;
  return {
    name: typeof record.name === 'string' ? record.name : '',
    title: typeof record.title === 'string' ? inertText(record.title, 200) : null,
    description: inertText(record.description, 2000),
    annotations: annotations && typeof annotations === 'object' ? annotations : null,
    inputSchema: record.inputSchema ?? null,
  };
}

/**
 * Connects to a remote MCP server. Only `https` URLs are accepted unless the owner has allowlisted the host
 * for plain http (the SSRF policy decides that, not this module). A stdio or command-based configuration can
 * never reach this function: it takes a URL, and callers validate their configuration first.
 */
export async function connectMcp(ctx: Pick<AdapterContext, 'safeFetch' | 'logger' | 'signal'>, options: McpConnectOptions): Promise<McpSession> {
  let endpoint: URL;
  try {
    endpoint = new URL(options.url);
  } catch {
    throw new InvalidConfigError('The MCP server URL is not a valid absolute URL');
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new InvalidConfigError(`The MCP server URL must use https (got ${endpoint.protocol})`);
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const requestInit: RequestInit = options.accessToken ? { headers: { authorization: `Bearer ${options.accessToken}` } } : {};
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: safeFetchAsFetch(ctx.safeFetch, { ...(ctx.signal ? { signal: ctx.signal } : {}) }),
    requestInit,
  });
  const client = new Client({ name: options.clientName ?? MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout });
  } catch (err) {
    await transport.close().catch(() => undefined);
    throw new ProviderUnavailableError(`The MCP server at ${redactUrl(endpoint)} could not be reached or refused the connection`, err);
  }
  const rawInfo = client.getServerVersion();
  const serverInfo = rawInfo ? { name: inertText(rawInfo.name, 120), version: inertText(rawInfo.version, 60) } : null;
  let allowedNames = new Set<string>();

  return {
    serverInfo,
    async listTools() {
      const response = await client.listTools({}, { timeout });
      const allowed: McpToolInfo[] = [];
      const denied: Array<{ name: string; reason: string }> = [];
      for (const raw of response.tools ?? []) {
        const tool = toToolInfo(raw);
        const verdict = classifyTool(tool, options.policy ?? {});
        if (verdict.allowed) allowed.push(tool);
        else denied.push({ name: tool.name || '(unnamed)', reason: verdict.reason });
      }
      allowedNames = new Set(allowed.map((t) => t.name));
      ctx.logger.info('mcp tools listed', { server: redactUrl(endpoint), allowed: allowed.length, denied: denied.length });
      return { allowed, denied };
    },
    async callTool(name, args = {}) {
      if (!allowedNames.has(name)) {
        // The tool list is the allowlist. A name that was never approved is refused before any request.
        throw new ReadOnlyViolationError(`MCP tool "${inertText(name, 80)}" is not on this server's read-only allowlist`);
      }
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
      const content: McpContentItem[] = [];
      let bytes = 0;
      let truncated = false;
      for (const raw of (result.content ?? []) as Array<Record<string, unknown>>) {
        if (bytes >= maxOutputBytes) {
          truncated = true;
          break;
        }
        if (raw?.type === 'text' && typeof raw.text === 'string') {
          const remaining = maxOutputBytes - bytes;
          const slice = raw.text.length > remaining ? raw.text.slice(0, remaining) : raw.text;
          if (slice.length < raw.text.length) truncated = true;
          bytes += slice.length;
          content.push({ kind: 'text', text: inertText(slice, remaining), mediaType: 'text/plain' });
        } else {
          const mediaType = typeof raw?.mimeType === 'string' ? inertText(raw.mimeType, 80) : null;
          content.push({ kind: 'other', text: '', mediaType });
        }
      }
      let structured: unknown = null;
      if (result.structuredContent !== undefined) {
        const serialized = JSON.stringify(result.structuredContent);
        if (typeof serialized === 'string' && serialized.length + bytes <= maxOutputBytes) {
          structured = result.structuredContent;
          bytes += serialized.length;
        } else {
          truncated = true;
        }
      }
      return { toolName: name, content, structured, isError: result.isError === true, truncated, bytes };
    },
    async close() {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}
