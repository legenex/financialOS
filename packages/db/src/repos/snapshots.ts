/**
 * Balance and holdings snapshots.
 *
 * A snapshot is evidence that an account stood at some value at some moment. It is never
 * income and never a journal entry. Two moments are kept apart on purpose:
 *   `reported_at`   when we were told (always known)
 *   `source_as_of`  the moment the source says the figure applied (NULL when unknown)
 *
 * Superseding is explicit: a newer snapshot of the same kind does not silently replace an
 * older one. `supersede` links them, and valuation ranks sources itself
 * (`selectValuation` in `@financialos/domain`) rather than summing them.
 */
import { and, asc, desc, eq, inArray, isNull, lte, type SQL } from 'drizzle-orm';
import {
  balanceSnapshots,
  holdingLines,
  holdingsSnapshots,
  type CompletenessValue,
  type SnapshotKind,
} from '../schema/accounts';
import { assertDecimal, InvalidError, mapErrors, required, tx, type DbOrTx } from './_util';

export type BalanceSnapshotRow = typeof balanceSnapshots.$inferSelect;
export type HoldingsSnapshotRow = typeof holdingsSnapshots.$inferSelect;
export type HoldingLineRow = typeof holdingLines.$inferSelect;

export interface RecordBalanceInput {
  accountId: string;
  kind: SnapshotKind;
  amount: string;
  currency: string;
  reportedAt: Date;
  /** NULL when the source does not say what moment the figure applied to. */
  sourceAsOf?: Date | null;
  approximate?: boolean;
  completeness?: CompletenessValue;
  /** What the total is made of, when the source said. Free-form, kept verbatim. */
  composition?: Array<Record<string, unknown>> | null;
  /** Human-readable provenance, for example "Owner-reported, unverified". */
  source: string;
  provenance?: Record<string, unknown>;
  documentId?: string | null;
  importBatchId?: string | null;
  connectionId?: string | null;
  bootstrapKey?: string | null;
  /** Marks this snapshot as the replacement for an older one. */
  supersedes?: string | null;
}

export async function recordBalance(db: DbOrTx, input: RecordBalanceInput): Promise<BalanceSnapshotRow> {
  assertDecimal(input.amount, 'snapshot amount');
  return mapErrors('record balance snapshot', () =>
    tx(db, async (t) => {
      const [row] = await t
        .insert(balanceSnapshots)
        .values({
          accountId: input.accountId,
          kind: input.kind,
          amount: input.amount,
          currency: input.currency,
          reportedAt: input.reportedAt,
          sourceAsOf: input.sourceAsOf ?? null,
          approximate: input.approximate ?? false,
          completeness: input.completeness ?? 'unknown',
          composition: input.composition ?? null,
          source: input.source,
          provenance: input.provenance ?? {},
          documentId: input.documentId ?? null,
          importBatchId: input.importBatchId ?? null,
          connectionId: input.connectionId ?? null,
          bootstrapKey: input.bootstrapKey ?? null,
        })
        .returning();
      const snapshot = required(row, 'balance snapshot');
      if (input.supersedes) await supersedeBalance(t, input.supersedes, snapshot.id);
      return snapshot;
    }),
  );
}

/** Links an older snapshot to the one that replaces it. The old row is kept for history. */
export async function supersedeBalance(db: DbOrTx, oldId: string, newId: string): Promise<BalanceSnapshotRow> {
  if (oldId === newId) throw new InvalidError('A snapshot cannot supersede itself');
  return mapErrors('supersede balance snapshot', async () => {
    const [row] = await db
      .update(balanceSnapshots)
      .set({ supersededBy: newId })
      .where(and(eq(balanceSnapshots.id, oldId), isNull(balanceSnapshots.supersededBy)))
      .returning();
    return required(row, 'balance snapshot (already superseded?)');
  });
}

/**
 * Records a snapshot and supersedes the newest live snapshot of the same kind on the same
 * account. Use for provider balances, where only the latest reading is meaningful.
 */
export async function replaceLatestBalance(db: DbOrTx, input: RecordBalanceInput): Promise<BalanceSnapshotRow> {
  return tx(db, async (t) => {
    const previous = await latestBalance(t, input.accountId, { kind: input.kind });
    return recordBalance(t, { ...input, supersedes: previous?.id ?? null });
  });
}

export interface BalanceQuery {
  kind?: SnapshotKind | SnapshotKind[];
  /** Exclude snapshots that were superseded (default true). */
  liveOnly?: boolean;
  asOf?: Date;
  limit?: number;
}

export async function listBalances(db: DbOrTx, accountId: string, query: BalanceQuery = {}): Promise<BalanceSnapshotRow[]> {
  const conditions: SQL[] = [eq(balanceSnapshots.accountId, accountId)];
  if (query.kind) conditions.push(inArray(balanceSnapshots.kind, Array.isArray(query.kind) ? query.kind : [query.kind]));
  if (query.liveOnly !== false) conditions.push(isNull(balanceSnapshots.supersededBy));
  if (query.asOf) conditions.push(lte(balanceSnapshots.reportedAt, query.asOf));
  return db
    .select()
    .from(balanceSnapshots)
    .where(and(...conditions))
    .orderBy(desc(balanceSnapshots.reportedAt))
    .limit(query.limit ?? 200);
}

export async function latestBalance(db: DbOrTx, accountId: string, query: BalanceQuery = {}): Promise<BalanceSnapshotRow | undefined> {
  const [row] = await listBalances(db, accountId, { ...query, limit: 1 });
  return row;
}

export async function getBalanceByBootstrapKey(db: DbOrTx, key: string): Promise<BalanceSnapshotRow | undefined> {
  const [row] = await db.select().from(balanceSnapshots).where(eq(balanceSnapshots.bootstrapKey, key)).limit(1);
  return row;
}

// ---------------------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------------------

export interface HoldingLineInput {
  instrumentId: string;
  /** Unknown quantities stay NULL; they are never zero. */
  quantity?: string | null;
  price?: string | null;
  priceCurrency?: string | null;
  priceAsOf?: Date | null;
  priceSource?: string | null;
  priceKind?: string | null;
  value?: string | null;
  valueCurrency?: string | null;
  costBasis?: string | null;
  costBasisCurrency?: string | null;
  costBasisComplete?: boolean;
  restricted?: boolean;
}

export interface RecordHoldingsInput {
  accountId: string;
  reportedAt: Date;
  sourceAsOf?: Date | null;
  completeness?: CompletenessValue;
  source: string;
  /** Only a verified, complete export may outrank a provider balance in valuation. */
  verified?: boolean;
  provenance?: Record<string, unknown>;
  documentId?: string | null;
  importBatchId?: string | null;
  connectionId?: string | null;
  bootstrapKey?: string | null;
  lines: readonly HoldingLineInput[];
  supersedes?: string | null;
}

export interface RecordedHoldings {
  snapshot: HoldingsSnapshotRow;
  lines: HoldingLineRow[];
}

/** Writes a holdings snapshot and its lines in one transaction. */
export async function recordHoldings(db: DbOrTx, input: RecordHoldingsInput): Promise<RecordedHoldings> {
  for (const line of input.lines) {
    if (line.quantity != null) assertDecimal(line.quantity, 'holding quantity');
    if (line.value != null && !line.valueCurrency) throw new InvalidError('A holding value needs a currency');
  }
  return mapErrors('record holdings snapshot', () =>
    tx(db, async (t) => {
      const [row] = await t
        .insert(holdingsSnapshots)
        .values({
          accountId: input.accountId,
          reportedAt: input.reportedAt,
          sourceAsOf: input.sourceAsOf ?? null,
          completeness: input.completeness ?? 'unknown',
          source: input.source,
          verified: input.verified ?? false,
          provenance: input.provenance ?? {},
          documentId: input.documentId ?? null,
          importBatchId: input.importBatchId ?? null,
          connectionId: input.connectionId ?? null,
          bootstrapKey: input.bootstrapKey ?? null,
        })
        .returning();
      const snapshot = required(row, 'holdings snapshot');
      const lines: HoldingLineRow[] = [];
      for (const line of input.lines) {
        const [inserted] = await t
          .insert(holdingLines)
          .values({
            snapshotId: snapshot.id,
            instrumentId: line.instrumentId,
            quantity: line.quantity ?? null,
            price: line.price ?? null,
            priceCurrency: line.priceCurrency ?? null,
            priceAsOf: line.priceAsOf ?? null,
            priceSource: line.priceSource ?? null,
            priceKind: line.priceKind ?? null,
            value: line.value ?? null,
            valueCurrency: line.valueCurrency ?? null,
            costBasis: line.costBasis ?? null,
            costBasisCurrency: line.costBasisCurrency ?? null,
            costBasisComplete: line.costBasisComplete ?? false,
            restricted: line.restricted ?? false,
          })
          .returning();
        lines.push(required(inserted, 'holding line'));
      }
      if (input.supersedes) await supersedeHoldings(t, input.supersedes, snapshot.id);
      return { snapshot, lines };
    }),
  );
}

export async function supersedeHoldings(db: DbOrTx, oldId: string, newId: string): Promise<HoldingsSnapshotRow> {
  if (oldId === newId) throw new InvalidError('A snapshot cannot supersede itself');
  return mapErrors('supersede holdings snapshot', async () => {
    const [row] = await db
      .update(holdingsSnapshots)
      .set({ supersededBy: newId })
      .where(and(eq(holdingsSnapshots.id, oldId), isNull(holdingsSnapshots.supersededBy)))
      .returning();
    return required(row, 'holdings snapshot (already superseded?)');
  });
}

export async function replaceLatestHoldings(db: DbOrTx, input: RecordHoldingsInput): Promise<RecordedHoldings> {
  return tx(db, async (t) => {
    const previous = await latestHoldings(t, input.accountId);
    return recordHoldings(t, { ...input, supersedes: previous?.id ?? null });
  });
}

export async function listHoldings(
  db: DbOrTx,
  accountId: string,
  query: { liveOnly?: boolean; asOf?: Date; limit?: number } = {},
): Promise<HoldingsSnapshotRow[]> {
  const conditions: SQL[] = [eq(holdingsSnapshots.accountId, accountId)];
  if (query.liveOnly !== false) conditions.push(isNull(holdingsSnapshots.supersededBy));
  if (query.asOf) conditions.push(lte(holdingsSnapshots.reportedAt, query.asOf));
  return db
    .select()
    .from(holdingsSnapshots)
    .where(and(...conditions))
    .orderBy(desc(holdingsSnapshots.reportedAt))
    .limit(query.limit ?? 100);
}

export async function latestHoldings(db: DbOrTx, accountId: string): Promise<HoldingsSnapshotRow | undefined> {
  const [row] = await listHoldings(db, accountId, { limit: 1 });
  return row;
}

export async function linesOf(db: DbOrTx, snapshotId: string): Promise<HoldingLineRow[]> {
  return db.select().from(holdingLines).where(eq(holdingLines.snapshotId, snapshotId)).orderBy(asc(holdingLines.createdAt));
}

export async function getHoldingsByBootstrapKey(db: DbOrTx, key: string): Promise<HoldingsSnapshotRow | undefined> {
  const [row] = await db.select().from(holdingsSnapshots).where(eq(holdingsSnapshots.bootstrapKey, key)).limit(1);
  return row;
}
