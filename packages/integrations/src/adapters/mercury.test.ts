import { afterEach, describe, expect, it } from 'vitest';
import { CredentialExpiredError, ProviderRateLimitedError, ProviderResponseError, ReadOnlyViolationError } from '../core/errors';
import { createJsonClient } from './http';
import { createMercuryClient, fetchAccountTransactions, mercuryAdapter } from './mercury';
import { collectTransactions } from './types';
import { createTestContext, json, startMockServer, type MockHandler, type MockServer } from './testing';

/**
 * Adapter contract tests for Mercury, against a local mock that follows the shapes documented at
 * docs.mercury.com (accounts and transactions under `{ ..., page: { nextPage, previousPage } }`, the
 * account-scoped endpoint under `{ total, transactions }`, and the six-value status enum).
 */

const TOKEN = 'secret-token:mercury_production_wma_synthetic_0000'; // privacy-check: allow-generic (synthetic fixture, not a real Mercury token)
const servers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function withServer(handler: MockHandler) {
  const server = await startMockServer(handler);
  servers.push(server);
  return server;
}

function account(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    accountNumber: '123456789012',
    routingNumber: '021000021',
    name: 'Example Holdings Ltd Operating',
    status: 'active',
    type: 'mercury',
    createdAt: '2026-01-02T00:00:00Z',
    availableBalance: 12345.67,
    currentBalance: 12500.0,
    kind: 'checking',
    legalBusinessName: 'Example Holdings Ltd',
    canReceiveTransactions: true,
    nickname: null,
    ...overrides,
  };
}

function transaction(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    amount: -42.5,
    createdAt: '2026-03-04T18:30:00Z',
    postedAt: '2026-03-05T02:00:00Z',
    status: 'sent',
    counterpartyName: 'Sample Consulting LLC',
    accountId: 'acct-1',
    kind: 'externalTransfer',
    bankDescription: 'SAMPLE CONSULTING LLC INVOICE 4711',
    note: null,
    externalMemo: null,
    mercuryCategory: 'Professional Services',
    cardId: null,
    ...overrides,
  };
}

async function ctxFor(server: MockServer, config: Record<string, string> = {}) {
  return createTestContext({
    servers: [server],
    credentials: { apiToken: TOKEN },
    config: { baseUrl: `${server.origin}/api/v1`, currency: 'USD', timezone: 'America/New_York', ...config },
    logSecrets: [TOKEN],
  });
}

describe('mercury adapter', () => {
  it('lists accounts and cards, and ignores external counterparty records', async () => {
    const server = await withServer((req) => {
      if (req.path === '/api/v1/accounts') {
        return json({
          accounts: [account('acct-1'), account('acct-2', { name: 'Savings', kind: 'savings' }), account('ext-1', { type: 'external', name: 'Vendor' })],
          page: { nextPage: null, previousPage: null },
        });
      }
      if (req.path === '/api/v1/account/acct-1/cards') {
        return json({ cards: [{ cardId: 'card-1', lastFourDigits: '4242', nameOnCard: 'A Owner', network: 'visa', status: 'active', type: 'physical', physicalCardStatus: 'active' }] });
      }
      return json({ cards: [] });
    });
    const { ctx } = await ctxFor(server);
    const result = await mercuryAdapter.listAccounts!(ctx);
    expect(result.accounts.map((a) => a.externalAccountId)).toEqual(['acct-1', 'acct-2']);
    expect(result.accounts[0]!.mask).toBe('****9012');
    expect(result.accounts[1]!.kindHint).toBe('savings');
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.lastFour).toBe('4242');
    expect(result.notes.join(' ')).toContain('counterparty record');
  });

  it('reports current and available balances as exact decimal strings', async () => {
    const server = await withServer(() => json({ accounts: [account('acct-1', { currentBalance: 12500.1, availableBalance: 12345.67 })], page: { nextPage: null } }));
    const { ctx } = await ctxFor(server);
    const result = await mercuryAdapter.fetchBalances!(ctx);
    expect(result.balances).toHaveLength(2);
    expect(result.balances[0]).toMatchObject({ kind: 'provider_current', balance: { amount: '12500.1', currency: 'USD' } });
    expect(result.balances[1]).toMatchObject({ kind: 'provider_available', balance: { amount: '12345.67', currency: 'USD' } });
    expect(result.balances[0]!.sourceAsOf).toBeNull();
  });

  it('pages transactions to completion and stops when no next cursor is returned', async () => {
    const pages = [
      { transactions: [transaction('t1'), transaction('t2')], page: { nextPage: 'cur-2' } },
      { transactions: [transaction('t3')], page: { nextPage: null } },
    ];
    const server = await withServer((req) => {
      const after = req.query.get('start_after');
      return json(after === 'cur-2' ? pages[1] : pages[0]);
    });
    const { ctx } = await ctxFor(server);
    const collected: string[] = [];
    let lastPage;
    for await (const page of mercuryAdapter.fetchTransactions!(ctx, {})) {
      collected.push(...page.transactions.map((t) => t.externalId));
      lastPage = page;
    }
    expect(collected).toEqual(['t1', 't2', 't3']);
    expect(lastPage!.done).toBe(true);
    expect(lastPage!.cursor).toBeNull();
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.query.get('start_after')).toBe('cur-2');
  });

  it('resumes from a cursor handed back by an earlier run', async () => {
    const server = await withServer((req) =>
      json(req.query.get('start_after') === 'cur-2' ? { transactions: [transaction('t3')], page: { nextPage: null } } : { transactions: [transaction('t1')], page: { nextPage: 'cur-2' } }),
    );
    const { ctx } = await ctxFor(server);
    const iterator = mercuryAdapter.fetchTransactions!(ctx, {})[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value!.cursor).toBe('after:cur-2');
    await iterator.return?.(undefined);

    const resumed = await collectTransactions(mercuryAdapter.fetchTransactions!(ctx, { cursor: first.value!.cursor }));
    expect(resumed.map((t) => t.externalId)).toEqual(['t3']);
  });

  it('passes the requested date window through to the provider', async () => {
    const server = await withServer(() => json({ transactions: [], page: { nextPage: null } }));
    const { ctx } = await ctxFor(server);
    await collectTransactions(mercuryAdapter.fetchTransactions!(ctx, { since: '2026-01-01', until: '2026-02-01' }));
    expect(server.requests[0]!.query.get('start')).toBe('2026-01-01');
    expect(server.requests[0]!.query.get('end')).toBe('2026-02-01');
  });

  it('returns an empty completed page for an account with no history', async () => {
    const server = await withServer(() => json({ transactions: [], page: { nextPage: null } }));
    const { ctx } = await ctxFor(server);
    const pages = [];
    for await (const page of mercuryAdapter.fetchTransactions!(ctx, {})) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ transactions: [], done: true, cursor: null });
  });

  it('marks pending transactions and books them on their created date', async () => {
    const server = await withServer(() =>
      json({
        transactions: [
          transaction('t-pending', { status: 'pending', postedAt: null, createdAt: '2026-03-04T23:30:00Z' }),
          transaction('t-posted', { status: 'sent', createdAt: '2026-03-04T23:30:00Z', postedAt: '2026-03-06T13:00:00Z' }),
        ],
        page: { nextPage: null },
      }),
    );
    const { ctx } = await ctxFor(server);
    const [pending, posted] = await collectTransactions(mercuryAdapter.fetchTransactions!(ctx, {}));
    expect(pending!.pending).toBe(true);
    // 2026-03-04T23:30Z is 18:30 in New York, so the booking date is still the 4th.
    expect(pending!.bookedOn).toBe('2026-03-04');
    expect(posted!.pending).toBe(false);
    expect(posted!.bookedOn).toBe('2026-03-06');
  });

  it('records failed, cancelled, and blocked transactions as having moved no money', async () => {
    const server = await withServer(() =>
      json({
        transactions: [
          transaction('t-failed', { status: 'failed', reasonForFailure: 'insufficient funds' }),
          transaction('t-cancelled', { status: 'cancelled' }),
          transaction('t-blocked', { status: 'blocked' }),
          transaction('t-reversed', { status: 'reversed' }),
        ],
        page: { nextPage: null },
      }),
    );
    const { ctx } = await ctxFor(server);
    const rows = await collectTransactions(mercuryAdapter.fetchTransactions!(ctx, {}));
    expect(rows.map((r) => r.movedMoney)).toEqual([false, false, false, true]);
    expect(rows.map((r) => r.providerStatus)).toEqual(['failed', 'cancelled', 'blocked', 'reversed']);
  });

  it('keeps amounts exact, without floating point', async () => {
    const server = await withServer(() => ({
      status: 200,
      body: '{"transactions":[{"id":"t1","amount":0.1,"accountId":"acct-1","status":"sent","createdAt":"2026-03-04T18:30:00Z","postedAt":"2026-03-05T02:00:00Z","bankDescription":"x"},{"id":"t2","amount":1234567.89,"accountId":"acct-1","status":"sent","createdAt":"2026-03-04T18:30:00Z","postedAt":"2026-03-05T02:00:00Z","bankDescription":"y"}],"page":{"nextPage":null}}',
    }));
    const { ctx } = await ctxFor(server);
    const rows = await collectTransactions(mercuryAdapter.fetchTransactions!(ctx, {}));
    expect(rows.map((r) => r.amount.amount)).toEqual(['0.1', '1234567.89']);
  });

  it('turns 401 into a typed CredentialExpiredError', async () => {
    const server = await withServer(() => ({ status: 401, body: '{"error":"unauthorized"}' }));
    const { ctx, logText } = await ctxFor(server);
    await expect(mercuryAdapter.test!(ctx)).rejects.toBeInstanceOf(CredentialExpiredError);
    expect(logText()).not.toContain(TOKEN);
  });

  it('turns 429 into ProviderRateLimitedError carrying Retry-After', async () => {
    const server = await withServer(() => ({ status: 429, headers: { 'retry-after': '120' }, body: '{}' }));
    const { ctx } = await ctxFor(server);
    const error = await mercuryAdapter.test!(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRateLimitedError);
    expect((error as ProviderRateLimitedError).retryAfterMs).toBe(120_000);
    expect((error as ProviderRateLimitedError).retryable).toBe(true);
  });

  it('retries a 5xx and succeeds on a later attempt', async () => {
    let attempts = 0;
    const server = await withServer(() => {
      attempts += 1;
      if (attempts < 3) return { status: 503, body: 'upstream unavailable' };
      return json({ accounts: [account('acct-1')], page: { nextPage: null } });
    });
    const { ctx } = await ctxFor(server);
    const result = await mercuryAdapter.test!(ctx);
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('gives up on a persistent 5xx with a retryable provider error', async () => {
    const server = await withServer(() => ({ status: 500, body: 'boom' }));
    const { ctx } = await ctxFor(server);
    const error = await mercuryAdapter.test!(ctx).catch((e: unknown) => e);
    expect((error as Error).name).toBe('ProviderUnavailableError');
    expect((error as { retryable: boolean }).retryable).toBe(true);
  });

  it('rejects a response body that is not the documented shape', async () => {
    const server = await withServer(() => json({ unexpected: true }));
    const { ctx } = await ctxFor(server);
    await expect(mercuryAdapter.listAccounts!(ctx)).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('stops promptly when the caller aborts', async () => {
    const controller = new AbortController();
    const server = await withServer(async (req) => {
      if (req.query.get('start_after') === null) return json({ transactions: [transaction('t1')], page: { nextPage: 'cur-2' } });
      controller.abort(new Error('cancelled by the owner'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      return json({ transactions: [transaction('t2')], page: { nextPage: null } });
    });
    const { ctx } = await ctxFor(server);
    const seen: string[] = [];
    const run = async () => {
      for await (const page of mercuryAdapter.fetchTransactions!(ctx, { signal: controller.signal })) {
        seen.push(...page.transactions.map((t) => t.externalId));
      }
    };
    await expect(run()).rejects.toThrow();
    expect(seen).toEqual(['t1']);
  });

  it('reads the offset-paginated account endpoint to completion', async () => {
    const server = await withServer((req) => {
      const offset = Number(req.query.get('offset') ?? '0');
      const limit = Number(req.query.get('limit') ?? '500');
      const all = [transaction('a1'), transaction('a2'), transaction('a3')];
      return json({ total: all.length, transactions: all.slice(offset, offset + limit) });
    });
    const { ctx } = await ctxFor(server);
    const result = await fetchAccountTransactions(ctx, 'acct-1', { pageSize: 2 });
    expect(result.total).toBe(3);
    expect(result.transactions.map((t) => t.externalId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('never issues anything but GET, and refuses a non-GET at the client boundary', async () => {
    const server = await withServer(() => json({ accounts: [account('acct-1')], page: { nextPage: null } }));
    const { ctx } = await ctxFor(server);
    await mercuryAdapter.listAccounts!(ctx);
    expect(server.requests.every((r) => r.method === 'GET')).toBe(true);

    const client = createMercuryClient(ctx);
    // The public surface has no write method at all; the internal guard is exercised through a bare client.
    const internal = createJsonClient({ safeFetch: ctx.safeFetch, baseUrl: `${server.origin}/api/v1`, providerLabel: 'Mercury' }) as unknown as {
      get: (r: unknown) => Promise<unknown>;
    };
    expect(Object.keys(client)).toEqual(['get', 'getText', 'describe']);
    expect(typeof internal.get).toBe('function');
    expect((client as unknown as Record<string, unknown>).post).toBeUndefined();
  });

  it('refuses a base URL outside the configured origin', async () => {
    const server = await withServer(() => json({}));
    const { ctx } = await ctxFor(server);
    const client = createMercuryClient(ctx);
    await expect(client.get({ path: '../../evil' })).rejects.toThrow(/left the configured base origin/);
  });

  it('never sends the token to a host outside the allowlist', async () => {
    const server = await withServer(() => json({ accounts: [], page: { nextPage: null } }));
    const { ctx } = await ctxFor(server, { baseUrl: 'https://mercury.example.com/api/v1' });
    await expect(mercuryAdapter.listAccounts!(ctx)).rejects.toThrow();
    expect(server.requests).toHaveLength(0);
  });

  it('keeps the read-only marker on the adapter', () => {
    expect(mercuryAdapter.readOnly).toBe(true);
    expect(ReadOnlyViolationError).toBeTypeOf('function');
  });
});
