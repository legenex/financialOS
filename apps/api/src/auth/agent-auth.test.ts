import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AgentPrincipal } from '../context';
import { EntityScopeError, agentCredentialHash, hasScope, resolveEntityScope } from './agent-auth';

const E1 = randomUUID();
const E2 = randomUUID();

function agent(entityIds: string[] = [E1, E2]): AgentPrincipal {
  return { id: randomUUID(), name: 'Test agent', scopes: ['read:summary'], entityIds };
}

describe('resolveEntityScope', () => {
  it('defaults to every entity in the credential', () => {
    expect(resolveEntityScope(agent())).toEqual([E1, E2]);
    expect(resolveEntityScope(agent(), null)).toEqual([E1, E2]);
    expect(resolveEntityScope(agent(), undefined)).toEqual([E1, E2]);
  });

  it('accepts a requested entity that is in scope, in any case', () => {
    expect(resolveEntityScope(agent(), E1)).toEqual([E1]);
    expect(resolveEntityScope(agent(), E1.toUpperCase())).toEqual([E1]);
    expect(resolveEntityScope(agent(), [E2, E1])).toEqual([E2, E1]);
    expect(resolveEntityScope(agent(), [E1, E1])).toEqual([E1]);
  });

  it('refuses an entity outside the credential', () => {
    expect(() => resolveEntityScope(agent([E1]), E2)).toThrow(EntityScopeError);
    expect(() => resolveEntityScope(agent([E1]), [E1, E2])).toThrow(EntityScopeError);
  });

  it('refuses anything that is not a uuid', () => {
    for (const bad of ['*', '', 'all', "' or 1=1 --", '../', `${E1} `, `${E1},${E2}`]) {
      expect(() => resolveEntityScope(agent(), bad), bad).toThrow(EntityScopeError);
    }
  });

  it('never returns an empty scope', () => {
    expect(() => resolveEntityScope(agent([]))).toThrow(EntityScopeError);
    expect(() => resolveEntityScope(agent([]), [])).toThrow(EntityScopeError);
  });
});

describe('scope checks', () => {
  it('only reports scopes the credential actually holds', () => {
    const principal: AgentPrincipal = { id: 'x', name: 'x', scopes: ['read:summary', 'read:accounts'], entityIds: [E1] };
    expect(hasScope(principal, 'read:summary')).toBe(true);
    expect(hasScope(principal, 'read:transactions')).toBe(false);
    expect(hasScope(principal, 'suggest:classification')).toBe(false);
  });
});

describe('agentCredentialHash', () => {
  it('is a domain-separated sha-256 that never contains the credential', () => {
    const credential = `fos_agent_${'A'.repeat(43)}`;
    const hash = agentCredentialHash(credential);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('A'.repeat(10));
    expect(agentCredentialHash(credential)).toBe(hash);
    expect(agentCredentialHash(`${credential}x`)).not.toBe(hash);
  });
});
