/**
 * Restrictions on an asset: volume caps, lock-ups, vesting, transfer restrictions.
 *
 * A restriction starts as `reported_unverified`. Only a `verified` restriction (with the
 * agreement behind it) may drive a sale schedule; until then the domain treats sale plans
 * as impossible to produce, not as unrestricted.
 */
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { restrictions, RESTRICTION_KINDS, RESTRICTION_STATUSES } from '../schema/accounts';
import { InvalidError, mapErrors, pickDefined, required, type DbOrTx } from './_util';

export type RestrictionRow = typeof restrictions.$inferSelect;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];
export type RestrictionStatus = (typeof RESTRICTION_STATUSES)[number];

export interface CreateInput {
  accountId: string;
  kind: RestrictionKind;
  instrumentId?: string | null;
  status?: RestrictionStatus;
  /** Free-form terms, for example `{ maxFractionOfDailyVolume: "0.02" }`. */
  terms?: Record<string, unknown>;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  documentId?: string | null;
  notes?: string | null;
  provenance?: Record<string, unknown>;
  bootstrapKey?: string | null;
  verifiedAt?: Date | null;
}

export async function create(db: DbOrTx, input: CreateInput): Promise<RestrictionRow> {
  const status = input.status ?? 'reported_unverified';
  if (status === 'verified' && !input.verifiedAt) throw new InvalidError('A verified restriction needs the moment it was verified');
  return mapErrors('create restriction', async () => {
    const [row] = await db
      .insert(restrictions)
      .values({
        accountId: input.accountId,
        instrumentId: input.instrumentId ?? null,
        kind: input.kind,
        status,
        terms: input.terms ?? {},
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        documentId: input.documentId ?? null,
        notes: input.notes ?? null,
        verifiedAt: input.verifiedAt ?? null,
        provenance: input.provenance ?? {},
        bootstrapKey: input.bootstrapKey ?? null,
      })
      .returning();
    return required(row, 'restriction');
  });
}

export async function update(db: DbOrTx, id: string, patch: Partial<Omit<CreateInput, 'bootstrapKey'>>): Promise<RestrictionRow> {
  return mapErrors('update restriction', async () => {
    const [row] = await db.update(restrictions).set(pickDefined(patch)).where(eq(restrictions.id, id)).returning();
    return required(row, 'restriction');
  });
}

/** Marks a restriction verified. Requires the evidence document that proves the terms. */
export async function verify(
  db: DbOrTx,
  id: string,
  input: { documentId?: string | null; terms?: Record<string, unknown>; notes?: string | null },
  now = new Date(),
): Promise<RestrictionRow> {
  const patch: Partial<CreateInput> = { status: 'verified', verifiedAt: now };
  if (input.documentId !== undefined) patch.documentId = input.documentId;
  if (input.terms !== undefined) patch.terms = input.terms;
  if (input.notes !== undefined) patch.notes = input.notes;
  return update(db, id, patch);
}

export async function expire(db: DbOrTx, id: string): Promise<RestrictionRow> {
  return update(db, id, { status: 'expired' });
}

export async function reject(db: DbOrTx, id: string, notes: string | null = null): Promise<RestrictionRow> {
  return update(db, id, { status: 'rejected', notes });
}

export async function getById(db: DbOrTx, id: string): Promise<RestrictionRow | undefined> {
  const [row] = await db.select().from(restrictions).where(eq(restrictions.id, id)).limit(1);
  return row;
}

export async function getByBootstrapKey(db: DbOrTx, key: string): Promise<RestrictionRow | undefined> {
  const [row] = await db.select().from(restrictions).where(eq(restrictions.bootstrapKey, key)).limit(1);
  return row;
}

export async function list(
  db: DbOrTx,
  query: { accountId?: string; instrumentId?: string; status?: RestrictionStatus | RestrictionStatus[] } = {},
): Promise<RestrictionRow[]> {
  const conditions: SQL[] = [];
  if (query.accountId) conditions.push(eq(restrictions.accountId, query.accountId));
  if (query.instrumentId) conditions.push(eq(restrictions.instrumentId, query.instrumentId));
  if (query.status) conditions.push(inArray(restrictions.status, Array.isArray(query.status) ? query.status : [query.status]));
  return db
    .select()
    .from(restrictions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(restrictions.createdAt));
}
