/**
 * Arrangements where we hold money that belongs to someone else.
 *
 * Two policies are possible and they are not interchangeable: a fee may be deducted from
 * each receipt, or charged on top. Until the owner selects one and records the evidence,
 * `fee_mode` stays `unconfirmed`: no fee income is recognised, and an exception asks for the
 * decision. Changing the policy is an audited event, because it changes what the owner is
 * owed and what is income.
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { thirdPartyArrangements, type ThirdPartyFeeModeValue } from '../schema/sources';
import { appendAudit } from './audit';
import { assertDecimal, ConflictError, InvalidError, mapErrors, pickDefined, required, tx, type DbOrTx } from './_util';

export type ThirdPartyArrangementRow = typeof thirdPartyArrangements.$inferSelect;
export type FeeMode = ThirdPartyFeeModeValue;

export interface CreateArrangementInput {
  thirdPartyEntityId: string;
  currency?: string | null;
  /** Fraction in [0, 1). NULL when no rate was stated. */
  feeRate?: string | null;
  feeMode?: FeeMode;
  feeRecipientEntityId?: string | null;
  openingBalance?: string | null;
  openingBalanceAsOf?: string | null;
  /** Our entities that hold the third party's money. */
  holdingEntityIds?: string[];
  /** Accounts used as clearing accounts for this arrangement. */
  clearingAccountIds?: string[];
  /** Accounts whose whole balance is economically the third party's. */
  economicallyOwnedAccountIds?: string[];
  evidenceNote?: string | null;
  notes?: string | null;
  provenance?: Record<string, unknown>;
  bootstrapKey?: string | null;
}

export async function create(db: DbOrTx, input: CreateArrangementInput): Promise<ThirdPartyArrangementRow> {
  if (input.feeRate != null) assertDecimal(input.feeRate, 'feeRate');
  if (input.openingBalance != null) assertDecimal(input.openingBalance, 'openingBalance');
  return mapErrors('create third-party arrangement', async () => {
    const [row] = await db
      .insert(thirdPartyArrangements)
      .values({
        thirdPartyEntityId: input.thirdPartyEntityId,
        currency: input.currency ?? null,
        feeRate: input.feeRate ?? null,
        feeMode: input.feeMode ?? 'unconfirmed',
        feeModeConfirmed: false,
        feeRecipientEntityId: input.feeRecipientEntityId ?? null,
        openingBalance: input.openingBalance ?? null,
        openingBalanceAsOf: input.openingBalanceAsOf ?? null,
        holdingEntityIds: input.holdingEntityIds ?? [],
        clearingAccountIds: input.clearingAccountIds ?? [],
        economicallyOwnedAccountIds: input.economicallyOwnedAccountIds ?? [],
        evidenceNote: input.evidenceNote ?? null,
        notes: input.notes ?? null,
        provenance: input.provenance ?? {},
        bootstrapKey: input.bootstrapKey ?? null,
      })
      .returning();
    return required(row, 'third-party arrangement');
  });
}

export async function update(
  db: DbOrTx,
  id: string,
  patch: Partial<Omit<CreateArrangementInput, 'bootstrapKey' | 'feeMode' | 'feeRate' | 'feeRecipientEntityId'>>,
): Promise<ThirdPartyArrangementRow> {
  return mapErrors('update third-party arrangement', async () => {
    const [row] = await db.update(thirdPartyArrangements).set(pickDefined(patch)).where(eq(thirdPartyArrangements.id, id)).returning();
    return required(row, 'third-party arrangement');
  });
}

export interface FeePolicyInput {
  /** `unconfirmed` may only be set while the policy is still open. */
  feeMode: FeeMode;
  feeRate?: string | null;
  feeRecipientEntityId?: string | null;
  /** What proves the policy: an agreement, a message, a signed note. */
  evidenceNote: string;
  decidedBy?: string;
}

/**
 * Selects the fee policy and writes an audit event in the same transaction. Confirming a
 * policy is what makes fee income recognisable, so it is never a silent update.
 */
export async function setFeePolicy(db: DbOrTx, id: string, input: FeePolicyInput): Promise<ThirdPartyArrangementRow> {
  if (input.feeRate != null) assertDecimal(input.feeRate, 'feeRate');
  if (!input.evidenceNote.trim()) throw new InvalidError('Selecting a fee policy needs a note saying what evidence it rests on');
  return mapErrors('set third-party fee policy', () =>
    tx(db, async (t) => {
      const before = required(await getById(t, id), 'third-party arrangement');
      const confirmed = input.feeMode !== 'unconfirmed';
      if (confirmed && input.feeRate === undefined && before.feeRate === null) {
        throw new ConflictError('A confirmed fee policy needs a fee rate');
      }
      const [row] = await t
        .update(thirdPartyArrangements)
        .set({
          feeMode: input.feeMode,
          feeModeConfirmed: confirmed,
          ...(input.feeRate !== undefined ? { feeRate: input.feeRate } : {}),
          ...(input.feeRecipientEntityId !== undefined ? { feeRecipientEntityId: input.feeRecipientEntityId } : {}),
          evidenceNote: input.evidenceNote,
        })
        .where(eq(thirdPartyArrangements.id, id))
        .returning();
      const after = required(row, 'third-party arrangement');
      await appendAudit(t, {
        actorType: input.decidedBy === 'system' ? 'system' : 'owner',
        actorId: null,
        action: 'third_party.fee_policy.set',
        objectType: 'third_party_arrangement',
        objectId: id,
        entityId: after.thirdPartyEntityId,
        summary: `Third-party fee policy changed from ${before.feeMode} to ${after.feeMode}`,
        details: {
          from: { feeMode: before.feeMode, feeRate: before.feeRate, feeRecipientEntityId: before.feeRecipientEntityId },
          to: { feeMode: after.feeMode, feeRate: after.feeRate, feeRecipientEntityId: after.feeRecipientEntityId },
          evidenceNote: input.evidenceNote,
        },
      });
      return after;
    }),
  );
}

/** Ends an arrangement. The history and the clearing balance stay readable. */
export async function end(db: DbOrTx, id: string): Promise<ThirdPartyArrangementRow> {
  const [row] = await db.update(thirdPartyArrangements).set({ status: 'ended' }).where(eq(thirdPartyArrangements.id, id)).returning();
  return required(row, 'third-party arrangement');
}

export async function getById(db: DbOrTx, id: string): Promise<ThirdPartyArrangementRow | undefined> {
  const [row] = await db.select().from(thirdPartyArrangements).where(eq(thirdPartyArrangements.id, id)).limit(1);
  return row;
}

export async function getByBootstrapKey(db: DbOrTx, key: string): Promise<ThirdPartyArrangementRow | undefined> {
  const [row] = await db.select().from(thirdPartyArrangements).where(eq(thirdPartyArrangements.bootstrapKey, key)).limit(1);
  return row;
}

export async function list(
  db: DbOrTx,
  query: { thirdPartyEntityId?: string; status?: 'active' | 'ended'; feeMode?: FeeMode } = {},
): Promise<ThirdPartyArrangementRow[]> {
  const conditions: SQL[] = [];
  if (query.thirdPartyEntityId) conditions.push(eq(thirdPartyArrangements.thirdPartyEntityId, query.thirdPartyEntityId));
  if (query.status) conditions.push(eq(thirdPartyArrangements.status, query.status));
  if (query.feeMode) conditions.push(eq(thirdPartyArrangements.feeMode, query.feeMode));
  return db
    .select()
    .from(thirdPartyArrangements)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(thirdPartyArrangements.createdAt));
}

/** Arrangements that touch one of our accounts, either as clearing or as economic owner. */
export async function listForAccount(db: DbOrTx, accountId: string): Promise<ThirdPartyArrangementRow[]> {
  return db
    .select()
    .from(thirdPartyArrangements)
    .where(
      sql`${accountId}::uuid = ANY (${thirdPartyArrangements.clearingAccountIds})
        OR ${accountId}::uuid = ANY (${thirdPartyArrangements.economicallyOwnedAccountIds})`,
    )
    .orderBy(asc(thirdPartyArrangements.createdAt));
}

export async function addClearingAccount(db: DbOrTx, id: string, accountId: string): Promise<ThirdPartyArrangementRow> {
  const [row] = await db
    .update(thirdPartyArrangements)
    .set({
      clearingAccountIds: sql`(SELECT array_agg(DISTINCT a) FROM unnest(${thirdPartyArrangements.clearingAccountIds} || ARRAY[${accountId}::uuid]) AS a)`,
    })
    .where(eq(thirdPartyArrangements.id, id))
    .returning();
  return required(row, 'third-party arrangement');
}
