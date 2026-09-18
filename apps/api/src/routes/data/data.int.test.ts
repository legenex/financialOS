/**
 * Integration tests for the owner data API: a real Fastify app on a disposable test database,
 * driven over HTTP through the cookie-aware test client.
 *
 * Fixtures are synthetic throughout (`Example Holdings Ltd`, `Sample Consulting LLC`, example.com).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  accounts as accountsTable,
  balanceSnapshots,
  classifications,
  connections as connectionsTable,
  connectionSecrets,
  entities as entitiesTable,
  fxRates,
  importBatches,
  institutions as institutionsTable,
  jobRecords,
  sourceRecords,
} from '@financialos/db';
import type { JobEnqueuer } from '../../context';
import { TestClient, errorCodeOf } from '../../test-support/client';
import { createHarness, TEST_EXTENSION_ORIGIN, type Harness } from '../../test-support/harness';
import { createAgentClient, pairDevice, setupAndLogin, type OwnerCredentials } from '../../test-support/auth';

interface EnqueuedJob {
  queue: string;
  data: Record<string, unknown>;
  options: { singletonKey?: string; startAfterSeconds?: number } | undefined;
}

const enqueued: EnqueuedJob[] = [];
const recordingJobs: JobEnqueuer = {
  async enqueue(queue, data, options) {
    enqueued.push({ queue, data, options });
    return { jobId: randomUUID() };
  },
};

let harness: Harness;
let client: TestClient;
let credentials: OwnerCredentials;
let opsDir: string;

const OWNER_ENTITY = '10000000-0000-4000-8000-000000000001';
const BUSINESS_ENTITY = '10000000-0000-4000-8000-000000000002';
const PERSONAL_ACCOUNT = '20000000-0000-4000-8000-000000000001';
const BUSINESS_ACCOUNT = '20000000-0000-4000-8000-000000000002';
const UNKNOWN_BALANCE_ACCOUNT = '20000000-0000-4000-8000-000000000003';
const INSTITUTION = '30000000-0000-4000-8000-000000000001';

/** Synthetic records: an owner, a company, three accounts and a handful of classified movements. */
async function seed(): Promise<void> {
  const db = harness.db;
  const now = harness.clock.now();
  await db.insert(entitiesTable).values([
    { id: OWNER_ENTITY, name: 'Example Owner', kind: 'person', ownerControlled: true, primaryOwner: true, legalStatusConfirmed: true, baseCurrency: 'ZAR' },
    { id: BUSINESS_ENTITY, name: 'Example Holdings Ltd', kind: 'company', ownerControlled: true, primaryOwner: false, legalStatusConfirmed: true, baseCurrency: 'USD' },
  ]);
  await db.insert(institutionsTable).values({ id: INSTITUTION, name: 'Example Bank', kind: 'bank', country: 'ZA' });
  await db.insert(accountsTable).values([
    {
      id: PERSONAL_ACCOUNT,
      name: 'Everyday account',
      kind: 'current',
      currency: 'ZAR',
      institutionId: INSTITUTION,
      legalEntityId: OWNER_ENTITY,
      economicOwnerEntityId: OWNER_ENTITY,
      ownershipConfirmed: true,
      liquidityClass: 'cash',
      includeInSafeToSpend: true,
      createdFrom: 'user',
    },
    {
      id: BUSINESS_ACCOUNT,
      name: 'Operating account',
      kind: 'current',
      currency: 'USD',
      institutionId: INSTITUTION,
      legalEntityId: BUSINESS_ENTITY,
      economicOwnerEntityId: BUSINESS_ENTITY,
      ownershipConfirmed: true,
      liquidityClass: 'cash',
      includeInSafeToSpend: false,
      createdFrom: 'user',
    },
    {
      id: UNKNOWN_BALANCE_ACCOUNT,
      name: 'Savings account',
      kind: 'savings',
      currency: 'ZAR',
      legalEntityId: OWNER_ENTITY,
      economicOwnerEntityId: OWNER_ENTITY,
      ownershipConfirmed: true,
      liquidityClass: 'cash',
      includeInSafeToSpend: true,
      createdFrom: 'user',
    },
  ]);
  await db.insert(fxRates).values({ base: 'USD', quote: 'ZAR', rate: '18.5', asOf: '2025-02-01', source: 'test-fixture' });
  await db.insert(balanceSnapshots).values([
    {
      accountId: PERSONAL_ACCOUNT,
      kind: 'owner_reported_total',
      amount: '12500.00',
      currency: 'ZAR',
      reportedAt: now,
      approximate: false,
      completeness: 'complete',
      source: 'Owner',
      provenance: { sourceKind: 'owner_reported', verified: false },
    },
    {
      accountId: BUSINESS_ACCOUNT,
      kind: 'owner_reported_total',
      amount: '4000.00',
      currency: 'USD',
      reportedAt: now,
      approximate: false,
      completeness: 'complete',
      source: 'Owner',
      provenance: { sourceKind: 'owner_reported', verified: false },
    },
  ]);

  const rows = [
    { accountId: PERSONAL_ACCOUNT, bookedOn: '2025-02-10', amount: '-1234.50', currency: 'ZAR', description: 'Example Grocer', nature: 'consumption' as const },
    { accountId: PERSONAL_ACCOUNT, bookedOn: '2025-02-12', amount: '-99.00', currency: 'ZAR', description: '=SUM(A1:A9)+cmd', nature: 'consumption' as const },
    { accountId: PERSONAL_ACCOUNT, bookedOn: '2025-02-14', amount: '25000.00', currency: 'ZAR', description: 'Salary from Example Holdings Ltd', nature: 'salary' as const },
    { accountId: BUSINESS_ACCOUNT, bookedOn: '2025-02-13', amount: '-500.00', currency: 'USD', description: 'Sample Consulting LLC invoice', nature: 'consumption' as const },
  ];
  for (const [index, row] of rows.entries()) {
    const id = randomUUID();
    await db.insert(sourceRecords).values({
      id,
      accountId: row.accountId,
      origin: 'import',
      recordKind: 'transaction',
      dedupeKey: `seed-${index}`,
      contentHash: `hash-${index}`,
      raw: { seed: index },
      bookedOn: row.bookedOn,
      amount: row.amount,
      currency: row.currency,
      description: row.description,
      counterpartyName: null,
      pending: false,
    });
    await db.insert(classifications).values({
      sourceRecordId: id,
      version: 1,
      isCurrent: true,
      nature: row.nature,
      confidence: 'medium',
      method: 'rule',
      needsReview: false,
      createdBy: 'system',
    });
  }
}

async function resetData(): Promise<void> {
  // source_records and audit_events are append-only in production (see migrations/0001); this
  // isolated per-test database has no need for that guard between test cases, so it is disabled
  // for the truncate only, exactly as an application role never can. `SET LOCAL` and the truncate
  // must run on the same connection, hence the transaction (the pool otherwise may hand the two
  // statements to different connections).
  await harness.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`
      truncate table classifications, source_records, balance_snapshots, holding_lines, holdings_snapshots,
        import_rows, import_batches, documents, accounts, institutions, entities, fx_rates, job_records,
        connection_secrets, connections, exceptions, goals, goal_contributions, budgets, budget_lines,
        recurring_items, obligations, receivables_payables, audit_events cascade`);
  });
  await seed();
}

beforeAll(async () => {
  opsDir = mkdtempSync(join(tmpdir(), 'fos-ops-status-'));
  harness = await createHarness({ jobs: recordingJobs, clockStart: '2025-02-20T09:00:00.000Z', config: { opsStatusDir: opsDir } });
  const session = await setupAndLogin(harness);
  client = session.client;
  credentials = session.credentials;
});

afterAll(async () => {
  await harness?.close();
  rmSync(opsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  enqueued.length = 0;
  await resetData();
});

/** A fresh signed-in client (each sign-in revokes the previous session). */
async function signIn(): Promise<TestClient> {
  const { login } = await import('../../test-support/auth');
  client = await login(harness, credentials);
  return client;
}

describe('authorization on every data route', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/api/today'],
    ['GET', '/api/safe-to-spend'],
    ['GET', '/api/runway'],
    ['GET', '/api/wealth'],
    ['GET', '/api/entities'],
    ['GET', '/api/accounts'],
    ['GET', '/api/transactions'],
    ['GET', '/api/transactions/export.csv'],
    ['GET', '/api/categories'],
    ['GET', '/api/rules'],
    ['GET', '/api/portfolio'],
    ['GET', '/api/restrictions'],
    ['GET', '/api/watch-events'],
    ['GET', '/api/documents'],
    ['GET', '/api/imports'],
    ['GET', '/api/import-templates'],
    ['GET', '/api/budgets'],
    ['GET', '/api/goals'],
    ['GET', '/api/recurring'],
    ['GET', '/api/obligations'],
    ['GET', '/api/scenarios'],
    ['GET', '/api/rewards/products'],
    ['GET', '/api/tax-facts'],
    ['GET', '/api/business/entities'],
    ['GET', '/api/business/consolidated'],
    ['GET', '/api/business/forecast'],
    ['GET', '/api/business/receivables-payables'],
    ['GET', '/api/business/clearing'],
    ['GET', '/api/business/support'],
    ['GET', '/api/coach/threads'],
    ['GET', '/api/reviews'],
    ['GET', '/api/achievements'],
    ['GET', '/api/providers'],
    ['GET', '/api/connections'],
    ['GET', '/api/outbound-allowlist'],
    ['GET', '/api/ai-providers'],
    ['GET', '/api/jobs'],
    ['GET', '/api/settings'],
    ['GET', '/api/schedules'],
    ['GET', '/api/system'],
    ['GET', '/api/backups'],
    ['GET', '/api/audit'],
    ['GET', '/api/notifications'],
    ['GET', '/api/search?q=example'],
    ['GET', '/api/exceptions'],
    ['GET', '/api/trade-proposals'],
    ['GET', '/api/risk-policy'],
    ['GET', '/api/execution-status'],
  ];

  it('rejects a request with no session', async () => {
    const anonymous = new TestClient(harness);
    for (const [method, url] of routes) {
      const response = await anonymous.request(method as 'GET', url);
      expect.soft(`${url}:${response.statusCode}`).toBe(`${url}:401`);
      expect.soft(`${url}:${errorCodeOf(response)}`).toBe(`${url}:unauthenticated`);
    }
  });

  it('rejects a device credential and an agent credential on owner routes', async () => {
    await signIn();
    const device = await pairDevice(harness, client);
    const agent = await createAgentClient(client, { scopes: ['read:summary'], entityIds: [OWNER_ENTITY] });
    for (const [method, url] of routes) {
      for (const credential of [device.credential, agent.credential]) {
        const attacker = new TestClient(harness);
        const response = await attacker.request(method as 'GET', url, { headers: { authorization: `Bearer ${credential}` } });
        expect.soft(`${url}:${response.statusCode}`).toBe(`${url}:401`);
        expect.soft(`${url}:${errorCodeOf(response)}`).toBe(`${url}:credential_not_accepted`);
      }
    }
  });

  it('never serves a cached copy of a data route', async () => {
    await signIn();
    for (const url of ['/api/today', '/api/accounts', '/api/transactions', '/api/system', '/api/settings']) {
      const response = await client.get(url);
      expect.soft(`${url}:${response.statusCode}`).toBe(`${url}:200`);
      expect.soft(`${url}:${response.headers['cache-control']}`).toBe(`${url}:no-store`);
      expect.soft(`${url}:${response.headers.pragma}`).toBe(`${url}:no-cache`);
    }
  });
});

describe('CSRF and Origin enforcement on mutations', () => {
  beforeEach(async () => {
    await signIn();
  });

  const mutation = { name: 'Second entity', kind: 'company', jurisdiction: null, baseCurrency: 'USD', ownerControlled: true, legalStatusConfirmed: false, notes: null };

  it('refuses a mutation without the CSRF header', async () => {
    const response = await client.post('/api/entities', mutation, { csrf: null });
    expect(response.statusCode).toBe(403);
    expect(errorCodeOf(response)).toBe('csrf_failed');
  });

  it('refuses a mutation with the wrong CSRF token', async () => {
    const response = await client.post('/api/entities', mutation, { csrf: 'not-the-token' });
    expect(response.statusCode).toBe(403);
    expect(errorCodeOf(response)).toBe('csrf_failed');
  });

  it('refuses a mutation from another origin and one with no Origin at all', async () => {
    const foreign = await client.post('/api/entities', mutation, { origin: 'https://attacker.example.com' });
    expect(foreign.statusCode).toBe(403);
    expect(errorCodeOf(foreign)).toBe('origin_not_allowed');
    const missing = await client.post('/api/entities', mutation, { origin: null });
    expect(missing.statusCode).toBe(403);
    expect(errorCodeOf(missing)).toBe('origin_not_allowed');
    const extension = await client.post('/api/entities', mutation, { origin: TEST_EXTENSION_ORIGIN });
    expect(extension.statusCode).toBe(403);
  });

  it('accepts the same mutation with a session, the CSRF header and the canonical Origin', async () => {
    const response = await client.post('/api/entities', mutation);
    expect(response.statusCode).toBe(201);
    expect((response.json() as { name: string }).name).toBe('Second entity');
  });
});

describe('accounts, entity scope and honest unknowns', () => {
  beforeEach(async () => {
    await signIn();
  });

  it('filters accounts by entity scope', async () => {
    const all = await client.get('/api/accounts');
    expect(all.statusCode).toBe(200);
    expect((all.json() as { items: unknown[] }).items).toHaveLength(3);

    const business = await client.get(`/api/accounts?entityId=${BUSINESS_ENTITY}`);
    const items = (business.json() as { items: Array<{ id: string; legalEntityId: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(BUSINESS_ACCOUNT);
  });

  it('reports an account with no recorded balance as unknown, never as zero', async () => {
    const response = await client.get(`/api/accounts/${UNKNOWN_BALANCE_ACCOUNT}`);
    expect(response.statusCode).toBe(200);
    const account = response.json() as { valuation: { value: { amount: string | null }; basis: string }; freshness: { state: string } };
    expect(account.valuation.value.amount).toBeNull();
    expect(account.valuation.basis).toBe('unknown');
    // No balance snapshot has ever been recorded for this account, which is more specific than an
    // unknown-dated one that has some history (see packages/contracts' Freshness state enum).
    expect(account.freshness.state).toBe('never');
  });

  it('returns insufficient_data for safe-to-spend when no eligible balance is known', async () => {
    await harness.db.delete(balanceSnapshots);
    const response = await client.get('/api/safe-to-spend');
    expect(response.statusCode).toBe(200);
    const result = response.json() as { status: string; amount: unknown; eligibleCash: unknown; explanation: { missing: string[] } };
    expect(result.status).toBe('insufficient_data');
    expect(result.amount).toBeNull();
    expect(result.eligibleCash).toBeNull();
    expect(result.explanation.missing.length).toBeGreaterThan(0);
  });

  it('scopes business entity cash summaries to the entities asked for', async () => {
    const response = await client.get(`/api/business/entities?entityId=${BUSINESS_ENTITY}&from=2025-02-01&to=2025-02-28`);
    expect(response.statusCode).toBe(200);
    const items = (response.json() as { items: Array<{ entityId: string; name: string; basis: string; disclaimer: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.entityId).toBe(BUSINESS_ENTITY);
    expect(items[0]?.basis).toBe('cash');
    expect(items[0]?.disclaimer).toContain('not audited profit');
  });
});

describe('transaction search, paging and classification versions', () => {
  beforeEach(async () => {
    await signIn();
  });

  it('searches, filters and pages transactions', async () => {
    const all = await client.get('/api/transactions');
    expect((all.json() as { items: unknown[] }).items).toHaveLength(4);

    const search = await client.get('/api/transactions?q=Grocer');
    const found = (search.json() as { items: Array<{ description: string }> }).items;
    expect(found).toHaveLength(1);
    expect(found[0]?.description).toBe('Example Grocer');

    const byAccount = await client.get(`/api/transactions?accountId=${BUSINESS_ACCOUNT}`);
    expect((byAccount.json() as { items: unknown[] }).items).toHaveLength(1);

    const byNature = await client.get('/api/transactions?nature=salary');
    expect((byNature.json() as { items: unknown[] }).items).toHaveLength(1);

    const byDate = await client.get('/api/transactions?from=2025-02-13&to=2025-02-28');
    expect((byDate.json() as { items: unknown[] }).items).toHaveLength(2);

    const firstPage = await client.get('/api/transactions?limit=2');
    const page1 = firstPage.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const secondPage = await client.get(`/api/transactions?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`);
    const page2 = secondPage.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const ids = new Set([...page1.items, ...page2.items].map((t) => t.id));
    expect(ids.size).toBe(4);
  });

  it('appends a new classification version instead of overwriting the previous one', async () => {
    const list = await client.get('/api/transactions?q=Grocer');
    const transactionId = (list.json() as { items: Array<{ id: string }> }).items[0]?.id as string;

    const categories = await client.get('/api/categories');
    const categoryId = (categories.json() as { items: Array<{ id: string; kind: string }> }).items.find((c) => c.kind === 'expense')?.id as string;

    const classify = await client.post(`/api/transactions/${transactionId}/classify`, {
      categoryId,
      nature: 'consumption',
      economicOwnerEntityId: OWNER_ENTITY,
      splits: null,
      note: 'Weekly shop',
      createRule: null,
    });
    expect(classify.statusCode).toBe(200);
    expect((classify.json() as { classification: { version: number; method: string } }).classification).toMatchObject({ version: 2, method: 'user' });

    const detail = await client.get(`/api/transactions/${transactionId}`);
    const history = (detail.json() as { history: Array<{ version: number; current: boolean; method: string }> }).history;
    expect(history.map((h) => h.version)).toEqual([2, 1]);
    expect(history.filter((h) => h.current)).toHaveLength(1);
    expect(history.find((h) => h.version === 1)?.method).toBe('rule');

    // A second, different decision appends version 3; an identical one does not.
    const again = await client.post(`/api/transactions/${transactionId}/classify`, {
      categoryId,
      nature: 'fee',
      economicOwnerEntityId: OWNER_ENTITY,
      splits: null,
      note: null,
      createRule: null,
    });
    expect((again.json() as { classification: { version: number } }).classification.version).toBe(3);
    const unchanged = await client.post(`/api/transactions/${transactionId}/classify`, {
      categoryId,
      nature: 'fee',
      economicOwnerEntityId: OWNER_ENTITY,
      splits: null,
      note: null,
      createRule: null,
    });
    expect((unchanged.json() as { classification: { version: number } }).classification.version).toBe(3);

    const rows = await harness.db.select().from(classifications).where(eq(classifications.sourceRecordId, transactionId));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
  });

  it('records an audit entry for a classification', async () => {
    const list = await client.get('/api/transactions?q=Grocer');
    const transactionId = (list.json() as { items: Array<{ id: string }> }).items[0]?.id as string;
    await client.post(`/api/transactions/${transactionId}/classify`, {
      categoryId: null,
      nature: 'consumption',
      economicOwnerEntityId: null,
      splits: null,
      note: null,
      createRule: null,
    });
    const audit = await client.get('/api/audit');
    const actions = (audit.json() as { items: Array<{ action: string }> }).items.map((a) => a.action);
    expect(actions).toContain('transaction.classified');
  });
});

describe('CSV export', () => {
  beforeEach(async () => {
    await signIn();
  });

  it('neutralises spreadsheet formulas and keeps amounts usable', async () => {
    const response = await client.get('/api/transactions/export.csv');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('transactions.csv');
    const body = response.body;
    const lines = body.trim().split('\r\n');
    expect(lines[0]).toBe('id,booked_on,value_on,account,description,counterparty,amount,currency,nature,category,status,classification_method,needs_review');
    const dangerous = lines.find((line: string) => line.includes('SUM(A1:A9)'));
    expect(dangerous).toBeTruthy();
    // The cell starts with a quote so a spreadsheet treats it as text, never as a formula.
    expect(dangerous).toContain(`,'=SUM(A1:A9)+cmd,`);
    expect(body).not.toMatch(/,=SUM/);
    // Amounts stay plain decimals even though a leading "-" is also a formula trigger.
    expect(body).toContain(',-1234.5,ZAR,');
  });

  it('audits the export', async () => {
    await client.get('/api/transactions/export.csv');
    const audit = await client.get('/api/audit');
    const entry = (audit.json() as { items: Array<{ action: string; summary: string }> }).items.find((a) => a.action === 'export.transactions_csv');
    expect(entry).toBeTruthy();
    expect(entry?.summary).toContain('CSV');
  });
});

describe('import flow', () => {
  beforeEach(async () => {
    await signIn();
  });

  const CSV = ['Date,Description,Amount', '2025-02-01,Example Grocer,-120.50', '2025-02-02,Salary,25000.00'].join('\n');

  function multipart(fileName: string, contentType: string, content: string, fields: Record<string, string> = {}): { payload: Buffer; headers: Record<string, string> } {
    const boundary = `----fos${randomUUID().replace(/-/g, '')}`;
    const parts: string[] = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    }
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n`);
    parts.push(`--${boundary}--\r\n`);
    return { payload: Buffer.from(parts.join(''), 'utf8'), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
  }

  const MAPPING = {
    hasHeader: true,
    skipRows: 0,
    delimiter: ',',
    sheetName: null,
    dateColumn: 'Date',
    valueDateColumn: null,
    dateFormat: 'YYYY-MM-DD',
    descriptionColumns: ['Description'],
    counterpartyColumn: null,
    referenceColumn: null,
    balanceColumn: null,
    currencyColumn: null,
    statusColumn: null,
    categoryColumn: null,
    amountMode: 'signed',
    amountColumn: 'Amount',
    debitColumn: null,
    creditColumn: null,
    directionColumn: null,
    debitMarkers: [],
    negativeIsDebit: true,
    decimalSeparator: '.',
    thousandsSeparator: '',
    defaultCurrency: 'ZAR',
    sourceTimezone: 'Africa/Johannesburg',
  };

  it('runs upload → configure → preview → commit and enqueues the jobs', async () => {
    const upload = multipart('statement.csv', 'text/csv', CSV);
    const created = await client.request('POST', '/api/imports', { payload: upload.payload, headers: upload.headers });
    expect(created.statusCode).toBe(201);
    const batch = created.json() as { id: string; status: string; fileKind: string; checks: Array<{ check: string; passed: boolean }>; detectedHeaders: string[]; sampleRows: string[][] };
    expect(batch.status).toBe('uploaded');
    expect(batch.fileKind).toBe('csv');
    expect(batch.checks.every((c) => c.passed)).toBe(true);
    expect(batch.checks.map((c) => c.check)).toEqual(expect.arrayContaining(['size', 'declared_type', 'content_sniff', 'no_macros', 'file_name']));
    expect(batch.detectedHeaders).toEqual(['Date', 'Description', 'Amount']);
    expect(batch.sampleRows).toHaveLength(2);

    const configure = await client.post(`/api/imports/${batch.id}/configure`, {
      accountId: PERSONAL_ACCOUNT,
      templateId: null,
      mapping: MAPPING,
      fileKind: 'csv',
      saveTemplateAs: 'Example Bank CSV',
      statementOpening: null,
      statementClosing: null,
    });
    expect(configure.statusCode).toBe(200);
    expect((configure.json() as { status: string; accountId: string }).status).toBe('parsing');
    expect((configure.json() as { accountId: string }).accountId).toBe(PERSONAL_ACCOUNT);
    expect(enqueued.filter((job) => job.queue === 'import.parse')).toHaveLength(1);

    // The worker would fill the preview; here the rows are inserted directly so the API can be exercised.
    await harness.db.execute(sql`
      insert into import_rows (batch_id, row_number, status, raw, booked_on, description, amount, currency, pending)
      values
        (${batch.id}::uuid, 1, 'new', '{}'::jsonb, '2025-02-01', 'Example Grocer', -120.50, 'ZAR', false),
        (${batch.id}::uuid, 2, 'new', '{}'::jsonb, '2025-02-02', 'Salary', 25000.00, 'ZAR', false),
        (${batch.id}::uuid, 3, 'possible_duplicate', '{}'::jsonb, '2025-02-02', 'Salary', 25000.00, 'ZAR', false)`);
    await harness.db.update(importBatches).set({ status: 'previewed' }).where(eq(importBatches.id, batch.id));

    const preview = await client.get(`/api/imports/${batch.id}/preview?limit=2`);
    const previewPage = preview.json() as { items: Array<{ rowNumber: number; amount: { amount: string } | null }>; nextCursor: string | null };
    expect(previewPage.items).toHaveLength(2);
    expect(previewPage.items[0]?.amount).toEqual({ amount: '-120.5', currency: 'ZAR' });
    expect(previewPage.nextCursor).toBe('2');
    const secondPage = await client.get(`/api/imports/${batch.id}/preview?cursor=2`);
    expect((secondPage.json() as { items: unknown[] }).items).toHaveLength(1);

    const filtered = await client.get(`/api/imports/${batch.id}/preview?status=possible_duplicate`);
    expect((filtered.json() as { items: unknown[] }).items).toHaveLength(1);

    const commit = await client.post(`/api/imports/${batch.id}/commit`, { includePossibleDuplicates: [3], idempotencyKey: 'commit-key-0123456789' });
    expect(commit.statusCode).toBe(200);
    const { jobId } = commit.json() as { jobId: string };
    expect(jobId).toBeTruthy();
    const commitJobs = enqueued.filter((job) => job.queue === 'import.commit');
    expect(commitJobs).toHaveLength(1);
    expect(commitJobs[0]?.options?.singletonKey).toBe(`import.commit:${batch.id}`);
    expect(commitJobs[0]?.data).toMatchObject({ importBatchId: batch.id, includePossibleDuplicates: [3] });

    const job = await client.get(`/api/jobs/${jobId}`);
    expect(job.statusCode).toBe(200);
    expect((job.json() as { queue: string; status: string }).queue).toBe('import.commit');

    // Committing twice with the same idempotency key does not enqueue a second job.
    await harness.db.update(importBatches).set({ status: 'previewed' }).where(eq(importBatches.id, batch.id));
    const again = await client.post(`/api/imports/${batch.id}/commit`, { includePossibleDuplicates: [3], idempotencyKey: 'commit-key-0123456789' });
    expect((again.json() as { jobId: string }).jobId).toBe(jobId);
    expect(enqueued.filter((job2) => job2.queue === 'import.commit')).toHaveLength(1);
  });

  it('refuses a file that fails the checks and stores nothing', async () => {
    const upload = multipart('book.xlsm', 'application/vnd.ms-excel', 'PKrubbish');
    const response = await client.request('POST', '/api/imports', { payload: upload.payload, headers: upload.headers });
    expect(response.statusCode).toBe(400);
    const details = (response.json() as { error: { details: { checks: Array<{ check: string; passed: boolean }> } } }).error.details;
    expect(details.checks.find((c) => c.check === 'no_macros')?.passed).toBe(false);
    const batches = await harness.db.select().from(importBatches);
    expect(batches).toHaveLength(0);
  });

  it('will not commit an import that has not been configured', async () => {
    const upload = multipart('statement.csv', 'text/csv', CSV);
    const created = await client.request('POST', '/api/imports', { payload: upload.payload, headers: upload.headers });
    const batch = created.json() as { id: string };
    const commit = await client.post(`/api/imports/${batch.id}/commit`, { includePossibleDuplicates: [], idempotencyKey: 'another-key-0123456789' });
    expect(commit.statusCode).toBe(409);
    expect(errorCodeOf(commit)).toBe('import_not_ready');
  });
});

describe('connection credentials are write-only', () => {
  beforeEach(async () => {
    await signIn();
  });

  const SECRET = 'synthetic-api-token-do-not-use-abcdef123456';

  it('never echoes a stored credential in any response', async () => {
    const created = await client.post('/api/connections', {
      providerKey: 'example_bank',
      method: 'api_token',
      name: 'Example Bank',
      entityId: BUSINESS_ENTITY,
      config: { region: 'za' },
    });
    expect(created.statusCode).toBe(201);
    const connection = created.json() as { id: string; hasCredential: boolean };
    expect(connection.hasCredential).toBe(false);

    const stored = await client.put(`/api/connections/${connection.id}/credentials`, { secrets: { api_token: SECRET } });
    expect(stored.statusCode).toBe(200);
    expect(stored.body).not.toContain(SECRET);
    expect((stored.json() as { hasCredential: boolean }).hasCredential).toBe(true);

    for (const url of ['/api/connections', `/api/connections/${connection.id}`, '/api/audit', '/api/search?q=Example', '/api/system']) {
      const response = await client.get(url);
      expect.soft(`${url}:${response.body.includes(SECRET)}`).toBe(`${url}:false`);
    }

    // What is stored is ciphertext, and it decrypts only with the connection's own associated data.
    const [secretRow] = await harness.db.select().from(connectionSecrets).where(eq(connectionSecrets.connectionId, connection.id));
    expect(secretRow?.ciphertext).toBeTruthy();
    expect(secretRow?.ciphertext).not.toContain(SECRET);
    expect(harness.keyring.decryptString(secretRow?.ciphertext as string, `connection-secret:${connection.id}`)).toBe(SECRET);
    expect(() => harness.keyring.decryptString(secretRow?.ciphertext as string, 'connection-secret:other')).toThrowError();

    const revoked = await client.del(`/api/connections/${connection.id}/credentials`);
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { hasCredential: boolean }).hasCredential).toBe(false);
    expect(await harness.db.select().from(connectionSecrets).where(eq(connectionSecrets.connectionId, connection.id))).toHaveLength(0);
  });

  it('enqueues jobs for provider work instead of calling out inline', async () => {
    const created = await client.post('/api/connections', { providerKey: 'example_bank', method: 'api_token', name: 'Example Bank', entityId: BUSINESS_ENTITY, config: {} });
    const id = (created.json() as { id: string }).id;
    for (const [path, queue] of [
      ['test', 'sync.connection'],
      ['discover-accounts', 'sync.connection'],
      ['sync', 'sync.connection'],
    ] as const) {
      const response = await client.post(`/api/connections/${id}/${path}`);
      expect.soft(`${path}:${response.statusCode}`).toBe(`${path}:200`);
      expect.soft(`${path}:${typeof (response.json() as { jobId: string }).jobId}`).toBe(`${path}:string`);
      expect(enqueued.some((job) => job.queue === queue)).toBe(true);
    }
    const backfill = await client.post(`/api/connections/${id}/backfill`, { from: '2024-01-01', to: null });
    expect(backfill.statusCode).toBe(200);
    expect(enqueued.some((job) => job.queue === 'sync.backfill')).toBe(true);

    const deleted = await client.del(`/api/connections/${id}`);
    expect(deleted.statusCode).toBe(200);
    const [row] = await harness.db.select().from(connectionsTable).where(eq(connectionsTable.id, id));
    expect(row?.status).toBe('revoked');
  });
});

describe('jobs', () => {
  beforeEach(async () => {
    await signIn();
  });

  it('cancels a cancellable job cooperatively', async () => {
    const created = await client.post('/api/connections', { providerKey: 'example_bank', method: 'api_token', name: 'Example Bank', entityId: BUSINESS_ENTITY, config: {} });
    const connectionId = (created.json() as { id: string }).id;
    const sync = await client.post(`/api/connections/${connectionId}/sync`);
    const { jobId } = sync.json() as { jobId: string };

    const listed = await client.get('/api/jobs?status=queued');
    expect((listed.json() as { items: Array<{ id: string }> }).items.map((j) => j.id)).toContain(jobId);

    const cancel = await client.post(`/api/jobs/${jobId}/cancel`);
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { status: string }).status).toBe('cancelling');
    const [row] = await harness.db.select().from(jobRecords).where(eq(jobRecords.id, jobId));
    expect(row?.cancelRequestedAt).toBeTruthy();

    const audit = await client.get('/api/audit');
    expect((audit.json() as { items: Array<{ action: string }> }).items.map((a) => a.action)).toContain('job.cancel_requested');
  });

  it('refuses to cancel a job that is not cancellable', async () => {
    const created = await client.post('/api/connections', { providerKey: 'example_bank', method: 'api_token', name: 'Example Bank', entityId: BUSINESS_ENTITY, config: {} });
    const connectionId = (created.json() as { id: string }).id;
    const test = await client.post(`/api/connections/${connectionId}/test`);
    const { jobId } = test.json() as { jobId: string };
    const cancel = await client.post(`/api/jobs/${jobId}/cancel`);
    expect(cancel.statusCode).toBe(409);
    expect(errorCodeOf(cancel)).toBe('job_not_cancellable');
  });
});

describe('system status', () => {
  beforeEach(async () => {
    await signIn();
  });

  it('reports unknown rather than ok when the ops status files are absent', async () => {
    const response = await client.get('/api/system');
    expect(response.statusCode).toBe(200);
    const status = response.json() as {
      route: { status: string; detail: string; kind: string };
      tls: { verified: boolean; terminatedBy: string };
      disk: { freeBytes: number | null; totalBytes: number | null; warning: boolean };
      backups: { last: unknown; encryption: string };
      worker: { status: string; lastHeartbeatAt: string | null };
      database: { status: string };
    };
    expect(status.route.status).toBe('unverified');
    expect(status.route.detail).toContain('route-status.json');
    expect(status.route.kind).toBe('loopback_only');
    expect(status.tls.verified).toBe(false);
    expect(status.tls.terminatedBy).toBe('unknown');
    expect(status.disk.freeBytes).toBeNull();
    expect(status.disk.totalBytes).toBeNull();
    expect(status.disk.warning).toBe(false);
    expect(status.backups.last).toBeNull();
    expect(status.backups.encryption).toContain('restore-verify-status.json');
    expect(status.worker.status).toBe('down');
    expect(status.worker.lastHeartbeatAt).toBeNull();
    expect(status.database.status).toBe('ok');
  });

  it('enqueues a backup instead of running one inline', async () => {
    const response = await client.post('/api/backups');
    expect(response.statusCode).toBe(200);
    expect(enqueued.filter((job) => job.queue === 'backup.run')).toHaveLength(1);
  });

  it('plans a domain migration without pretending it is harmless', async () => {
    const response = await client.post('/api/system/domain-migration/plan', { proposedOrigin: 'https://finance.example.test' });
    expect(response.statusCode).toBe(200);
    const plan = response.json() as DomainPlan;
    expect(plan.proposedOrigin).toBe('https://finance.example.test');
    expect(plan.checks.find((c) => c.id === 'passkeys')?.status).toBe('warning');
    expect(plan.consequences.join(' ')).toContain('signed out');
  });
});

interface DomainPlan {
  proposedOrigin: string;
  checks: Array<{ id: string; status: string }>;
  consequences: string[];
}

describe('coach and investing', () => {
  beforeEach(async () => {
    await signIn();
  });

  it('answers from the records and labels the answer deterministic when no provider is configured', async () => {
    const response = await client.post('/api/coach/ask', { threadId: null, message: 'How much is safe to spend?', mode: 'auto' });
    expect(response.statusCode).toBe(201);
    const answer = response.json() as { threadId: string; messageId: string; generatedBy: string; jobId: string | null };
    expect(answer.generatedBy).toBe('deterministic');
    expect(answer.jobId).toBeNull();
    expect(enqueued.filter((job) => job.queue === 'ai.task')).toHaveLength(0);

    const messages = await client.get(`/api/coach/threads/${answer.threadId}`);
    const items = (messages.json() as { items: Array<{ role: string; generatedBy: string; content: string }> }).items;
    expect(items).toHaveLength(2);
    expect(items[1]?.role).toBe('coach');
    expect(items[1]?.generatedBy).toBe('deterministic');
    expect(items[1]?.content.length).toBeGreaterThan(0);
  });

  it('always reports live execution as disabled with its requirements', async () => {
    const response = await client.get('/api/execution-status');
    const status = response.json() as { liveExecutionEnabled: boolean; requirements: string[]; reason: string };
    expect(status.liveExecutionEnabled).toBe(false);
    expect(status.requirements.length).toBeGreaterThan(3);
    expect(status.reason).toContain('disabled');
  });
});
