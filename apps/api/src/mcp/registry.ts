/**
 * Registry of MCP tools exposed at /mcp. Tools are read-only by default; the single allowed
 * write is `suggest_classification`, which only creates an exception for the owner to review.
 */
import type { AgentScope } from '@financialos/contracts';
import type { AgentCallContext, AppProviders } from '../providers';

export type JsonSchemaObject = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export interface McpToolContext {
  call: AgentCallContext;
  providers: AppProviders;
}

export interface McpToolDefinition<I extends { entityId?: string } = { entityId?: string }> {
  /** snake_case, 3–64 characters. */
  name: string;
  title?: string;
  description: string;
  requiredScope: AgentScope;
  /** Advertised to clients in tools/list. */
  inputSchema: JsonSchemaObject;
  /** Validates and normalises arguments. Throw to reject. */
  parse(args: unknown): I;
  /** True only for the one tool allowed to create a suggestion. */
  mutates?: boolean;
  handler(input: I, ctx: McpToolContext): Promise<unknown>;
}

export const MUTATING_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(['suggest_classification']);
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;

export class McpToolRegistry {
  readonly #tools = new Map<string, McpToolDefinition>();

  register<I extends { entityId?: string }>(tool: McpToolDefinition<I>): this {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`MCP tool name is not valid: ${tool.name}`);
    if (this.#tools.has(tool.name)) throw new Error(`MCP tool already registered: ${tool.name}`);
    if (tool.mutates && !MUTATING_TOOL_ALLOWLIST.has(tool.name)) {
      throw new Error(`MCP tool ${tool.name} may not mutate data; MCP is read-only`);
    }
    if (tool.inputSchema.type !== 'object') throw new Error(`MCP tool ${tool.name} must take an object input`);
    this.#tools.set(tool.name, tool as unknown as McpToolDefinition);
    return this;
  }

  /** Replaces a registered tool (used by the data layer to swap in real providers). */
  replace<I extends { entityId?: string }>(tool: McpToolDefinition<I>): this {
    this.#tools.delete(tool.name);
    return this.register(tool);
  }

  get(name: string): McpToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): McpToolDefinition[] {
    return [...this.#tools.values()];
  }
}
