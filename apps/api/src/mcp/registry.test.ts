import { describe, expect, it } from 'vitest';
import { McpToolRegistry, MUTATING_TOOL_ALLOWLIST, type McpToolDefinition } from './registry';
import { createDefaultToolRegistry } from './tools';

function tool(overrides: Partial<McpToolDefinition> = {}): McpToolDefinition {
  return {
    name: 'read_thing',
    description: 'Reads a thing.',
    requiredScope: 'read:summary',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    parse: (args) => (args ?? {}) as { entityId?: string },
    handler: async () => ({ ok: true }),
    ...overrides,
  } as McpToolDefinition;
}

describe('McpToolRegistry', () => {
  it('refuses a mutating tool that is not on the allowlist', () => {
    const registry = new McpToolRegistry();
    expect(() => registry.register(tool({ name: 'delete_everything', mutates: true }))).toThrow(/read-only/);
    expect(registry.list()).toHaveLength(0);
  });

  it('allows exactly one mutating tool', () => {
    expect([...MUTATING_TOOL_ALLOWLIST]).toEqual(['suggest_classification']);
    const registry = new McpToolRegistry();
    expect(() => registry.register(tool({ name: 'suggest_classification', mutates: true }))).not.toThrow();
  });

  it('refuses malformed tool names and duplicate registrations', () => {
    const registry = new McpToolRegistry();
    for (const name of ['', 'ab', 'Read_Thing', 'read-thing', '1read', 'read thing', `a${'b'.repeat(80)}`]) {
      expect(() => registry.register(tool({ name })), name).toThrow(/not valid/);
    }
    registry.register(tool());
    expect(() => registry.register(tool())).toThrow(/already registered/);
  });

  it('requires an object input schema', () => {
    const registry = new McpToolRegistry();
    expect(() => registry.register(tool({ inputSchema: { type: 'array' } as never }))).toThrow(/object input/);
  });

  it('replaces a tool in place', () => {
    const registry = new McpToolRegistry();
    registry.register(tool({ description: 'first' }));
    registry.replace(tool({ description: 'second' }));
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('read_thing')?.description).toBe('second');
  });
});

describe('default tool registry', () => {
  const registry = createDefaultToolRegistry();

  it('exposes only read tools plus the single suggestion tool', () => {
    const mutating = registry.list().filter((t) => t.mutates);
    expect(mutating.map((t) => t.name)).toEqual(['suggest_classification']);
  });

  it('gives every tool a scope and a closed input schema', () => {
    for (const t of registry.list()) {
      expect(t.requiredScope, t.name).toBeTruthy();
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
    }
  });

  it('rejects unknown arguments rather than ignoring them', () => {
    const summary = registry.get('get_summary');
    expect(summary).toBeDefined();
    expect(() => summary!.parse({ entityId: '00000000-0000-4000-8000-000000000001' })).not.toThrow();
    expect(() => summary!.parse({ notAField: 1 })).toThrow();
    expect(() => summary!.parse({ entityId: 'not-a-uuid' })).toThrow();
  });

  it('caps list sizes in the tool schemas', () => {
    const accounts = registry.get('list_accounts');
    expect(() => accounts!.parse({ limit: 1000 })).toThrow();
    expect(accounts!.parse({})).toMatchObject({ limit: 50 });
  });
});
