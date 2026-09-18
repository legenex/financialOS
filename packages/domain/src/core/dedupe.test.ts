import { describe, expect, it } from 'vitest';
import { money } from '../money';
import {
  computeRowIdentities,
  DedupeError,
  descriptionTokens,
  planImport,
  providerDedupeKey,
  sourceContentHash,
  stableHash,
  tokenSimilarity,
  tupleDedupeKey,
  type ExistingSourceRecord,
  type IncomingSourceRow,
} from './dedupe';
import { randomInt, seededRandom, unitsToDecimal } from './test-support';

const ACC = 'acc-personal-card';

function row(rowNumber: number, bookedOn: string, amount: string, description: string, over: Partial<IncomingSourceRow> = {}): IncomingSourceRow {
  return { rowNumber, accountId: ACC, bookedOn, amount: money(amount, 'USD'), description, ...over };
}

/**
 * Persists rows as existing records, the way a committed import would. Keys come from the whole file
 * (`identities`), never from a recomputation over a subset of rows.
 */
function commit(rows: readonly IncomingSourceRow[], prefix: string, identities = computeRowIdentities(rows)): ExistingSourceRecord[] {
  const ids = identities;
  return rows.map((r, i) => ({
    id: `${prefix}-${r.rowNumber}`,
    accountId: r.accountId,
    bookedOn: r.bookedOn,
    amount: r.amount,
    description: r.description,
    providerTransactionId: r.providerTransactionId ?? null,
    pending: Boolean(r.pending),
    dedupeKey: ids[i]!.dedupeKey,
    contentHash: ids[i]!.contentHash,
  }));
}

const statuses = (plan: ReturnType<typeof planImport>) => plan.rows.map((r) => r.status);

describe('identity keys', () => {
  it('hashes deterministically', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'));
    expect(stableHash('abc')).not.toBe(stableHash('abd'));
    expect(stableHash('')).toMatch(/^[0-9a-f]{32}$/);
    expect(stableHash('ü')).not.toBe(stableHash('u'));
  });

  it('normalises amount text and description before hashing', () => {
    const a = row(1, '2026-06-01', '5.00', '  Example   CAFE ');
    const b = row(2, '2026-06-01', '5', 'example cafe');
    expect(tupleDedupeKey(a, 0)).toBe(tupleDedupeKey(b, 0));
    expect(tupleDedupeKey(a, 0)).not.toBe(tupleDedupeKey(a, 1));
    expect(tupleDedupeKey(a, 0)).not.toBe(tupleDedupeKey({ ...a, accountId: 'acc-other' }, 0));
    expect(tupleDedupeKey(a, 0)).not.toBe(tupleDedupeKey({ ...a, amount: money('5', 'EUR') }, 0));
    expect(sourceContentHash(a)).toBe(sourceContentHash(b));
    expect(sourceContentHash(a)).not.toBe(sourceContentHash({ ...a, pending: true }));
    expect(() => tupleDedupeKey(a, -1)).toThrow(DedupeError);
  });

  it('uses the provider id when present, scoped to the account', () => {
    const ids = computeRowIdentities([row(1, '2026-06-01', '-5', 'Cafe', { providerTransactionId: ' tx-001 ' })]);
    expect(ids[0]!.dedupeKey).toBe(providerDedupeKey(ACC, 'tx-001'));
    expect(ids[0]!.dedupeKey.startsWith('p1:')).toBe(true);
    expect(ids[0]!.tupleKey.startsWith('t1:')).toBe(true);
    expect(providerDedupeKey(ACC, 'tx-001')).not.toBe(providerDedupeKey('acc-other', 'tx-001'));
  });

  it('assigns occurrence indexes to identical tuples in one file', () => {
    const ids = computeRowIdentities([
      row(1, '2026-06-01', '-3.80', 'Example Cafe'),
      row(2, '2026-06-01', '-3.80', 'Example Cafe'),
      row(3, '2026-06-02', '-3.80', 'Example Cafe'),
      row(4, '2026-06-01', '-3.80', 'EXAMPLE CAFE'),
    ]);
    expect(ids.map((i) => i.occurrence)).toEqual([0, 1, 0, 2]);
    expect(new Set(ids.map((i) => i.dedupeKey)).size).toBe(4);
  });

  it('refuses malformed rows', () => {
    expect(() => computeRowIdentities([row(1, '2026-13-01', '-1', 'x')])).toThrow(/invalid booked date/);
    expect(() => computeRowIdentities([{ ...row(1, '2026-01-01', '-1', 'x'), accountId: '' }])).toThrow(/account/);
    expect(() => computeRowIdentities([row(1, '2026-01-01', '-1,00', 'x')])).toThrow();
  });

  it('measures description similarity on word tokens, ignoring reference numbers', () => {
    expect([...descriptionTokens('POS 123456 Example-Cafe  #77 a')]).toEqual(['pos', 'example', 'cafe']);
    expect(tokenSimilarity('Example Cafe 1234', 'EXAMPLE CAFE 9999')).toBe('1');
    expect(tokenSimilarity('Example Cafe Downtown', 'Example Cafe')).toBe('0.6667');
    expect(tokenSimilarity('Example Cafe', 'Sample Books')).toBe('0');
    expect(tokenSimilarity('123', '123')).toBe('1');
    expect(tokenSimilarity('123', '456')).toBe('0');
  });
});

describe('planImport', () => {
  const statementA = [
    row(1, '2026-06-01', '-3.80', 'Example Cafe'),
    row(2, '2026-06-01', '-3.80', 'Example Cafe'),
    row(3, '2026-06-02', '-25.00', 'Sample Books'),
  ];

  it('keeps two legitimate identical purchases as two new records', () => {
    const plan = planImport([], statementA);
    expect(statuses(plan)).toEqual(['new', 'new', 'new']);
    expect(plan.counts).toMatchObject({ total: 3, new: 3, duplicate: 0 });
    expect(plan.rows[1]!.explanation[0]).toMatch(/occurrence 2/);
  });

  it('matches a re-imported statement one-to-one', () => {
    const existing = commit(statementA, 'a');
    const plan = planImport(existing, statementA);
    expect(statuses(plan)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(plan.rows.map((r) => r.matchedRecordId)).toEqual(['a-1', 'a-2', 'a-3']);
    // Row order does not matter: identical rows are interchangeable but still matched one-to-one.
    const reversed = planImport(existing, [...statementA].reverse().map((r, i) => ({ ...r, rowNumber: i + 1 })));
    expect(statuses(reversed)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(new Set(reversed.rows.map((r) => r.matchedRecordId)).size).toBe(3);
  });

  it('handles an overlapping statement with an extra legitimate repeat', () => {
    const existing = commit(statementA, 'a');
    const statementB = [
      row(1, '2026-06-01', '-3.80', 'Example Cafe'),
      row(2, '2026-06-01', '-3.80', 'Example Cafe'),
      row(3, '2026-06-01', '-3.80', 'Example Cafe'),
      row(4, '2026-06-02', '-25.00', 'Sample Books'),
      row(5, '2026-06-03', '-3.80', 'Example Cafe'),
    ];
    const plan = planImport(existing, statementB);
    expect(statuses(plan)).toEqual(['duplicate', 'duplicate', 'new', 'duplicate', 'new']);
    expect(plan.counts).toMatchObject({ duplicate: 3, new: 2 });
    expect(plan.rows[2]!.occurrence).toBe(2);
    // Committing the new rows with the keys from the plan and re-importing B again yields no new records.
    const newRows = statementB.filter((_, i) => plan.rows[i]!.status === 'new');
    const newIdentities = plan.rows.filter((r) => r.status === 'new');
    const afterB = [...existing, ...commit(newRows, 'b', newIdentities)];
    const keysAfterB = afterB.map((e) => e.dedupeKey);
    expect(new Set(keysAfterB).size).toBe(keysAfterB.length);
    expect(statuses(planImport(afterB, statementB))).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(statuses(planImport(afterB, statementA))).toEqual(['duplicate', 'duplicate', 'duplicate']);
    // Recomputing keys over the new rows alone would restart the occurrence count and collide.
    expect(computeRowIdentities(newRows)[0]!.dedupeKey).toBe(existing[0]!.dedupeKey);
  });

  it('turns a pending record into a posted one', () => {
    const pending = commit([row(1, '2026-06-10', '-18.40', 'EXAMPLE GROCER 0042 AUTH', { pending: true, providerTransactionId: 'auth-77' })], 'p');
    const plan = planImport(pending, [row(1, '2026-06-12', '-18.40', 'Example Grocer 0042', { providerTransactionId: 'post-91' })]);
    expect(plan.rows[0]).toMatchObject({ status: 'pending_to_posted', matchedRecordId: 'p-1', dayGap: 2, similarity: '0.6667' });
    expect(plan.rows[0]!.explanation[0]).toMatch(/Pending record p-1/);
    // Different amount, dissimilar description, too late or earlier than the pending record: not the same purchase.
    expect(statuses(planImport(pending, [row(1, '2026-06-12', '-18.41', 'Example Grocer', { providerTransactionId: 'x' })]))).toEqual(['new']);
    expect(statuses(planImport(pending, [row(1, '2026-06-12', '-18.40', 'Sample Hardware', { providerTransactionId: 'x' })]))).toEqual(['new']);
    expect(statuses(planImport(pending, [row(1, '2026-06-20', '-18.40', 'Example Grocer', { providerTransactionId: 'x' })]))).toEqual(['new']);
    expect(statuses(planImport(pending, [row(1, '2026-06-09', '-18.40', 'Example Grocer', { providerTransactionId: 'x' })]))).toEqual(['new']);
    expect(statuses(planImport(pending, [row(1, '2026-06-20', '-18.40', 'Example Grocer', { providerTransactionId: 'x' })], { pendingWindowDays: 10 }))).toEqual(['pending_to_posted']);
  });

  it('posts a pending record with the same provider id or the same tuple', () => {
    const byId = commit([row(1, '2026-06-10', '-9.99', 'Example Streaming', { pending: true, providerTransactionId: 'tx-5' })], 'p');
    expect(planImport(byId, [row(1, '2026-06-11', '-9.99', 'Example Streaming Monthly', { providerTransactionId: 'tx-5' })]).rows[0]).toMatchObject({
      status: 'pending_to_posted',
      matchedRecordId: 'p-1',
    });
    const byTuple = commit([row(1, '2026-06-10', '-9.99', 'Example Streaming', { pending: true })], 't');
    expect(planImport(byTuple, [row(1, '2026-06-10', '-9.99', 'Example Streaming')]).rows[0]).toMatchObject({ status: 'pending_to_posted', matchedRecordId: 't-1' });
    expect(planImport(byTuple, [row(1, '2026-06-10', '-9.99', 'Example Streaming', { pending: true })]).rows[0]).toMatchObject({ status: 'duplicate' });
  });

  it('detects upstream changes to a record with the same provider id', () => {
    const existing = commit([row(1, '2026-06-10', '-40.00', 'Sample Fuel', { providerTransactionId: 'tx-9' })], 'e');
    expect(planImport(existing, [row(1, '2026-06-10', '-40', 'SAMPLE  FUEL', { providerTransactionId: 'tx-9' })]).rows[0]).toMatchObject({ status: 'duplicate', matchedRecordId: 'e-1' });
    const changed = planImport(existing, [row(1, '2026-06-11', '-42.00', 'Sample Fuel', { providerTransactionId: 'tx-9' })]).rows[0]!;
    expect(changed).toMatchObject({ status: 'changed_upstream', matchedRecordId: 'e-1' });
    expect(changed.explanation[1]).toBe('date 2026-06-10 → 2026-06-11, amount -40 USD → -42 USD');
    const repending = planImport(existing, [row(1, '2026-06-10', '-40.00', 'Sample Fuel', { providerTransactionId: 'tx-9', pending: true })]).rows[0]!;
    expect(repending.status).toBe('changed_upstream');
    expect(repending.explanation[1]).toBe('posted → pending');
  });

  it('matches API and file records that share no provider id', () => {
    const api = commit(
      [
        row(1, '2026-06-15', '-12.00', 'Example Bakery', { providerTransactionId: 'api-1' }),
        row(2, '2026-06-15', '-12.00', 'Example Bakery', { providerTransactionId: 'api-2' }),
        row(3, '2026-06-16', '-60.00', 'CARD 5521 SAMPLE OUTFITTERS', { providerTransactionId: 'api-3' }),
        row(4, '2026-06-20', '-7.00', 'Example Kiosk', { providerTransactionId: 'api-4' }),
      ],
      'api',
    );
    const csv = [
      row(1, '2026-06-15', '-12.00', 'EXAMPLE BAKERY'),
      row(2, '2026-06-15', '-12.00', 'EXAMPLE BAKERY'),
      row(3, '2026-06-17', '-60.00', 'Sample Outfitters Store'),
      row(4, '2026-06-24', '-7.00', 'Example Kiosk'),
      row(5, '2026-06-15', '-12.00', 'EXAMPLE BAKERY'),
    ];
    const plan = planImport(api, csv);
    expect(statuses(plan)).toEqual(['duplicate', 'duplicate', 'possible_duplicate', 'new', 'new']);
    expect(plan.rows.slice(0, 3).map((r) => r.matchedRecordId)).toEqual(['api-1', 'api-2', 'api-3']);
    expect(plan.rows[2]!.dayGap).toBe(1);
    expect(plan.rows[2]!.explanation[0]).toMatch(/existing record only/);
    expect(plan.counts).toMatchObject({ duplicate: 2, possibleDuplicate: 1, new: 2 });

    // The other direction: file first, API later.
    const file = commit([row(1, '2026-06-15', '-12.00', 'Example Bakery')], 'f');
    const fromApi = planImport(file, [row(1, '2026-06-14', '-12.00', 'Example Bakery Ltd', { providerTransactionId: 'api-9' })]);
    expect(fromApi.rows[0]).toMatchObject({ status: 'possible_duplicate', matchedRecordId: 'f-1', dayGap: -1 });
    expect(planImport(file, [row(1, '2026-06-15', '-12.00', 'example bakery', { providerTransactionId: 'api-9' })]).rows[0]!.status).toBe('duplicate');
  });

  it('marks repeated provider ids in one file as duplicates of the earlier row', () => {
    const plan = planImport([], [row(1, '2026-06-01', '-1', 'X Store', { providerTransactionId: 'dup' }), row(2, '2026-06-01', '-1', 'X Store', { providerTransactionId: 'dup' })]);
    expect(plan.rows.map((r) => [r.status, r.duplicateOfRow])).toEqual([
      ['new', null],
      ['duplicate', 1],
    ]);
  });

  it('ignores records from reversed imports', () => {
    const reversed = commit(statementA, 'old').map((r) => ({ ...r, state: 'reversed' as const }));
    expect(statuses(planImport(reversed, statementA))).toEqual(['new', 'new', 'new']);
  });

  it('never matches an existing record twice and never drops rows (seeded property loop)', () => {
    const rand = seededRandom(424242);
    for (let round = 0; round < 40; round += 1) {
      const rows: IncomingSourceRow[] = [];
      const count = randomInt(rand, 1, 60);
      for (let i = 0; i < count; i += 1) {
        rows.push(
          row(i + 1, `2026-07-${String(randomInt(rand, 1, 4)).padStart(2, '0')}`, unitsToDecimal(-BigInt(randomInt(rand, 1, 3) * 100), 2), ['Example Cafe', 'Sample Books'][randomInt(rand, 0, 1)]!),
        );
      }
      const first = planImport([], rows);
      expect(first.counts.new).toBe(count);
      const existing = commit(rows, `r${round}`);
      const again = planImport(existing, rows);
      expect(again.counts.duplicate).toBe(count);
      const matched = again.rows.map((r) => r.matchedRecordId);
      expect(new Set(matched).size).toBe(count);
      // A second copy of the file appended to itself adds exactly `count` new rows.
      const doubled = [...rows, ...rows.map((r) => ({ ...r, rowNumber: r.rowNumber + count }))];
      const plan = planImport(existing, doubled);
      expect(plan.counts).toMatchObject({ total: 2 * count, duplicate: count, new: count });
    }
  });
});
