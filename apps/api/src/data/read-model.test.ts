/**
 * Unit tests for the read-model mapping. Everything here is pure: rows in, contract shapes out.
 * Nothing touches a database.
 */
import { describe, expect, it } from 'vitest';
import { BalanceSnapshot, Obligation, RecurringItem, Transaction } from '@financialos/contracts';
import { FxTable } from '@financialos/domain';
import { decodeCursor, encodeCursor, iso, maybeMoneyOf, moneyOf, normalizeDecimal, resolvePeriod, shiftDays, uniqueIds } from './common';
import { snapshotView, holdingsView, planningAccount, wealthAccount, type AccountBundle, type SnapshotRow } from './accounts';
import { transactionView, toBudgetTransactions, toRunwayFlows, type TransactionRow } from './transactions';
import { obligationView, recurringView, receivableView, type ObligationRow, type RecurringRow, type ReceivableRow } from './planning';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const RECORD_ID = '22222222-2222-4222-8222-222222222222';
const ENTITY_ID = '33333333-3333-4333-8333-333333333333';

function transactionRow(overrides: Partial<TransactionRow['record']> = {}, classification: Partial<NonNullable<TransactionRow['classification']>> | null = {}): TransactionRow {
  const record = {
    id: RECORD_ID,
    accountId: ACCOUNT_ID,
    origin: 'import' as const,
    recordKind: 'transaction' as const,
    connectionId: null,
    importBatchId: null,
    documentId: null,
    providerId: 'ext-1',
    dedupeKey: 'k',
    contentHash: 'h',
    upstreamVersion: 1,
    raw: {},
    bookedOn: '2026-02-10',
    valueOn: '2026-02-11',
    sourceTimezone: 'Africa/Johannesburg',
    amount: '-1234.500000000000000000',
    currency: 'ZAR',
    description: 'Example Grocer',
    counterpartyName: 'Example Grocer',
    reference: null,
    balanceAfter: null,
    pending: false,
    firstSeenAt: new Date('2026-02-11T08:00:00Z'),
    lastSeenAt: new Date('2026-02-11T08:00:00Z'),
    supersededBy: null,
    deletedUpstreamAt: null,
    createdAt: new Date('2026-02-11T08:00:00Z'),
    ...overrides,
  };
  return {
    record,
    classification:
      classification === null
        ? null
        : {
            id: 'c1',
            sourceRecordId: RECORD_ID,
            version: 2,
            isCurrent: true,
            nature: 'consumption' as const,
            categoryId: '44444444-4444-4444-8444-444444444444',
            economicOwnerEntityId: ENTITY_ID,
            counterpartyId: null,
            splits: null,
            confidence: 'high' as const,
            method: 'user' as const,
            ruleId: null,
            transferMatchId: null,
            needsReview: false,
            note: null,
            createdBy: 'session:x',
            createdAt: new Date('2026-02-12T08:00:00Z'),
            ...classification,
          },
    accountName: 'Everyday account',
    accountEntityId: ENTITY_ID,
    accountCurrency: 'ZAR',
    categoryName: 'Groceries',
  };
}

const ctx = { reportingCurrency: 'ZAR', fx: new FxTable() };

describe('decimal and money mapping', () => {
  it('shortens numeric(38,18) values without floating point', () => {
    expect(normalizeDecimal('12.500000000000000000')).toBe('12.5');
    expect(normalizeDecimal('-0.000000000000000001')).toBe('-0.000000000000000001');
    expect(normalizeDecimal('0.000000000000000000')).toBe('0');
    expect(normalizeDecimal('-0.000')).toBe('0');
    expect(normalizeDecimal(null)).toBeNull();
  });

  it('keeps half-known money unknown instead of inventing a currency', () => {
    expect(moneyOf('10', 'ZAR')).toEqual({ amount: '10', currency: 'ZAR' });
    expect(moneyOf('10', null)).toBeNull();
    expect(moneyOf(null, 'ZAR')).toBeNull();
    expect(maybeMoneyOf(null, 'ZAR')).toEqual({ amount: null, currency: 'ZAR' });
  });

  it('round-trips paging cursors and rejects rubbish', () => {
    const cursor = encodeCursor('2026-02-10', RECORD_ID);
    expect(decodeCursor(cursor)).toEqual({ key: '2026-02-10', id: RECORD_ID });
    expect(decodeCursor(undefined)).toBeNull();
    expect(() => decodeCursor('not-a-cursor')).toThrowError();
  });

  it('shifts dates as calendar dates', () => {
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(resolvePeriod({}, '2026-03-31', 30)).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(() => resolvePeriod({ from: '2026-04-01', to: '2026-03-01' }, '2026-03-31')).toThrowError();
  });

  it('collects unique ids and drops nulls', () => {
    expect(uniqueIds([ENTITY_ID, null, ENTITY_ID, undefined, ACCOUNT_ID])).toEqual([ACCOUNT_ID, ENTITY_ID].sort());
  });

  it('maps dates to ISO strings and keeps null null', () => {
    expect(iso(new Date('2026-02-11T08:00:00Z'))).toBe('2026-02-11T08:00:00.000Z');
    expect(iso(null)).toBeNull();
  });
});

describe('transaction read model', () => {
  it('produces a contract-shaped transaction from a record plus its current classification', () => {
    const view = transactionView(transactionRow(), ctx, { tags: ['food'] });
    expect(Transaction.safeParse(view).success).toBe(true);
    expect(view.amount).toEqual({ amount: '-1234.5', currency: 'ZAR' });
    expect(view.status).toBe('posted');
    expect(view.nature).toBe('consumption');
    expect(view.classification).toEqual({ version: 2, method: 'user', confidence: 'high', needsReview: false });
    expect(view.category).toEqual({ id: '44444444-4444-4444-8444-444444444444', name: 'Groceries' });
    expect(view.source).toEqual({ kind: 'import', batchId: null, externalId: 'ext-1' });
    expect(view.tags).toEqual(['food']);
  });

  it('treats an unclassified record as unknown and needing review, never as consumption', () => {
    const view = transactionView(transactionRow({}, null), ctx);
    expect(view.nature).toBe('unknown');
    expect(view.classification).toEqual({ version: 0, method: 'none', confidence: 'none', needsReview: true });
    expect(view.category).toBeNull();
    expect(view.splits).toBeNull();
  });

  it('reports pending, superseded and reversed states from the record itself', () => {
    expect(transactionView(transactionRow({ pending: true }), ctx).status).toBe('pending');
    expect(transactionView(transactionRow({ supersededBy: 'x' }), ctx).status).toBe('superseded');
    expect(transactionView(transactionRow({ deletedUpstreamAt: new Date() }), ctx).status).toBe('reversed');
  });

  it('leaves the reporting amount unconverted when no rate exists', () => {
    const view = transactionView(transactionRow({ currency: 'USD' }), ctx);
    expect(view.reporting?.converted).toBeNull();
    expect(view.reporting?.unconvertedReason).toBeTruthy();
  });

  it('expands split lines into separate runway flows', () => {
    const rows = [
      transactionRow({}, {
        splits: [
          { amount: '-1000', categoryId: null, nature: 'consumption', economicOwnerEntityId: null, memo: null },
          { amount: '-234.5', categoryId: null, nature: 'fee', economicOwnerEntityId: null, memo: null },
        ],
      }),
    ];
    const flows = toRunwayFlows(rows);
    expect(flows).toHaveLength(2);
    expect(flows.map((f) => f.amount.amount)).toEqual(['-1000', '-234.5']);
    expect(flows.map((f) => f.nature)).toEqual(['consumption', 'fee']);
  });

  it('drops records with an unknown amount from the engine inputs rather than guessing zero', () => {
    const rows = [transactionRow({ amount: null })];
    expect(toRunwayFlows(rows)).toEqual([]);
    expect(toBudgetTransactions(rows)).toEqual([]);
  });
});

describe('snapshot and holdings mapping', () => {
  const snapshot: SnapshotRow = {
    id: '55555555-5555-4555-8555-555555555555',
    accountId: ACCOUNT_ID,
    kind: 'statement_closing',
    amount: '5000.000000000000000000',
    currency: 'ZAR',
    reportedAt: new Date('2026-02-01T00:00:00Z'),
    sourceAsOf: new Date('2026-01-31T00:00:00Z'),
    approximate: false,
    completeness: 'complete',
    composition: null,
    source: 'Statement',
    supersededBy: null,
    provenance: { sourceKind: 'import', verified: true },
    documentId: null,
    importBatchId: null,
    connectionId: null,
    bootstrapKey: null,
    createdAt: new Date('2026-02-01T00:00:00Z'),
    updatedAt: new Date('2026-02-01T00:00:00Z'),
  };

  it('maps a balance snapshot onto the contract with its provenance', () => {
    const view = snapshotView(snapshot);
    expect(BalanceSnapshot.safeParse(view).success).toBe(true);
    expect(view.balance).toEqual({ amount: '5000', currency: 'ZAR' });
    expect(view.provenance.sourceKind).toBe('import');
    expect(view.provenance.verified).toBe(true);
  });

  it('reports unknown holdings honestly when nothing was ever recorded', () => {
    const holdings = holdingsView(ACCOUNT_ID, undefined);
    expect(holdings).toEqual({ accountId: ACCOUNT_ID, asOf: null, completeness: 'unknown', source: 'none recorded', lines: [] });
  });
});

describe('account projections', () => {
  const bundle = {
    row: {
      id: ACCOUNT_ID,
      name: 'Everyday account',
      kind: 'current',
      currency: 'ZAR',
      liquidityClass: 'cash',
      includeInSafeToSpend: true,
      legalEntityId: ENTITY_ID,
      economicOwnerEntityId: ENTITY_ID,
      ownershipConfirmed: true,
      status: 'active',
    },
    account: {
      valuation: {
        value: { amount: '5000', currency: 'ZAR' },
        asOf: '2026-02-01T00:00:00.000Z',
        reportedAt: '2026-02-01T00:00:00.000Z',
        approximate: false,
        completeness: 'complete',
      },
    },
  } as unknown as AccountBundle;

  it('turns the chosen valuation into the planning balance', () => {
    expect(planningAccount(bundle).balance).toEqual({ amount: '5000', currency: 'ZAR' });
    expect(planningAccount(bundle).balanceAsOf).toBe('2026-02-01T00:00:00.000Z');
  });

  it('keeps an unknown valuation null in the wealth projection', () => {
    const unknown = { ...bundle, account: { valuation: { ...bundle.account.valuation, value: { amount: null, currency: null } } } } as unknown as AccountBundle;
    expect(planningAccount(unknown).balance).toBeNull();
    expect(wealthAccount(unknown).valuation.value).toEqual({ amount: null, currency: null });
  });
});

describe('planning record mapping', () => {
  it('keeps an unknown recurring amount unknown', () => {
    const row = {
      id: '66666666-6666-4666-8666-666666666666',
      name: 'Water',
      entityId: ENTITY_ID,
      accountId: null,
      counterpartyId: null,
      counterpartyName: null,
      kind: 'bill',
      direction: 'out',
      amount: null,
      currency: null,
      amountIsEstimate: true,
      cadence: 'monthly',
      dayOfMonth: 3,
      nextDueOn: '2026-03-03',
      status: 'active',
      detected: true,
      confirmed: false,
      internalCounterpartyEntityId: null,
      lastSeenOn: null,
      detection: null,
      provenance: {},
      bootstrapKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as RecurringRow;
    const view = recurringView(row);
    expect(RecurringItem.safeParse(view).success).toBe(true);
    expect(view.amount).toEqual({ amount: null, currency: null });
  });

  it('maps an obligation with an unknown amount', () => {
    const row = {
      id: '77777777-7777-4777-8777-777777777777',
      entityId: ENTITY_ID,
      dueOn: '2026-03-25',
      amount: null,
      currency: null,
      label: 'Annual licence',
      kind: 'bill',
      status: 'upcoming',
      recurringItemId: null,
      accountId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ObligationRow;
    const view = obligationView(row);
    expect(Obligation.safeParse(view).success).toBe(true);
    expect(view.amount.amount).toBeNull();
  });

  it('normalises receivable probability and outstanding amounts', () => {
    const row = {
      id: '88888888-8888-4888-8888-888888888888',
      entityId: ENTITY_ID,
      kind: 'receivable',
      counterpartyName: 'Sample Consulting LLC',
      counterpartyId: null,
      intercompanyEntityId: null,
      reference: 'INV-1',
      amount: '1000.000000000000000000',
      currency: 'USD',
      outstanding: '250.500000000000000000',
      issuedOn: '2026-02-01',
      dueOn: '2026-03-01',
      expectedOn: null,
      probability: '0.800000000000000000',
      status: 'partial',
      source: 'manual',
      category: 'sales',
      documentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ReceivableRow;
    const view = receivableView(row);
    expect(view.outstanding).toEqual({ amount: '250.5', currency: 'USD' });
    expect(view.probability).toBe('0.8');
  });
});
