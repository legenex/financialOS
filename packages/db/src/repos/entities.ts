/**
 * Legal and economic entities plus the ownership graph between them.
 *
 * `percent` on an ownership interest is optional and stays NULL when the owner has not
 * confirmed it. An unconfirmed percentage is never treated as 100 or 0.
 */
import { and, asc, eq, isNull, or, type SQL } from 'drizzle-orm';
import { entities, ownershipInterests, type EntityKindValue } from '../schema/org';
import { assertDecimal, InvalidError, mapErrors, pickDefined, required, type DbOrTx } from './_util';

export type EntityRow = typeof entities.$inferSelect;
export type OwnershipInterestRow = typeof ownershipInterests.$inferSelect;

export interface CreateEntityInput {
  name: string;
  kind: EntityKindValue;
  jurisdiction?: string | null;
  baseCurrency?: string | null;
  ownerControlled?: boolean;
  primaryOwner?: boolean;
  legalStatusConfirmed?: boolean;
  notes?: string | null;
  provenance?: Record<string, unknown>;
  bootstrapKey?: string | null;
}

export async function createEntity(db: DbOrTx, input: CreateEntityInput): Promise<EntityRow> {
  return mapErrors('create entity', async () => {
    const [row] = await db
      .insert(entities)
      .values({
        name: input.name,
        kind: input.kind,
        jurisdiction: input.jurisdiction ?? null,
        baseCurrency: input.baseCurrency ?? null,
        ownerControlled: input.ownerControlled ?? false,
        primaryOwner: input.primaryOwner ?? false,
        legalStatusConfirmed: input.legalStatusConfirmed ?? false,
        notes: input.notes ?? null,
        provenance: input.provenance ?? {},
        bootstrapKey: input.bootstrapKey ?? null,
      })
      .returning();
    return required(row, 'entity');
  });
}

export type UpdateEntityInput = Partial<Omit<CreateEntityInput, 'bootstrapKey'>>;

export async function updateEntity(db: DbOrTx, id: string, patch: UpdateEntityInput): Promise<EntityRow> {
  const values = pickDefined(patch);
  if (Object.keys(values).length === 0) return required(await getEntity(db, id), 'entity');
  return mapErrors('update entity', async () => {
    const [row] = await db.update(entities).set(values).where(eq(entities.id, id)).returning();
    return required(row, 'entity');
  });
}

export async function getEntity(db: DbOrTx, id: string): Promise<EntityRow | undefined> {
  const [row] = await db.select().from(entities).where(eq(entities.id, id)).limit(1);
  return row;
}

export async function getEntityByBootstrapKey(db: DbOrTx, key: string): Promise<EntityRow | undefined> {
  const [row] = await db.select().from(entities).where(eq(entities.bootstrapKey, key)).limit(1);
  return row;
}

export async function getPrimaryOwner(db: DbOrTx): Promise<EntityRow | undefined> {
  const [row] = await db.select().from(entities).where(eq(entities.primaryOwner, true)).limit(1);
  return row;
}

export interface EntityQuery {
  kind?: EntityKindValue;
  ownerControlled?: boolean;
  includeArchived?: boolean;
}

export async function listEntities(db: DbOrTx, query: EntityQuery = {}): Promise<EntityRow[]> {
  const conditions: SQL[] = [];
  if (query.kind) conditions.push(eq(entities.kind, query.kind));
  if (query.ownerControlled !== undefined) conditions.push(eq(entities.ownerControlled, query.ownerControlled));
  if (!query.includeArchived) conditions.push(isNull(entities.archivedAt));
  return db
    .select()
    .from(entities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(entities.name));
}

/** Entities are archived, never deleted: ledger history must stay readable. */
export async function archiveEntity(db: DbOrTx, id: string, now = new Date()): Promise<EntityRow> {
  const [row] = await db.update(entities).set({ archivedAt: now }).where(eq(entities.id, id)).returning();
  return required(row, 'entity');
}

export async function unarchiveEntity(db: DbOrTx, id: string): Promise<EntityRow> {
  const [row] = await db.update(entities).set({ archivedAt: null }).where(eq(entities.id, id)).returning();
  return required(row, 'entity');
}

// ---------------------------------------------------------------------------------------
// Ownership interests
// ---------------------------------------------------------------------------------------

export interface OwnershipInterestInput {
  holderEntityId: string;
  heldEntityId: string;
  /** 0–100. NULL means "not supplied"; it is never defaulted. */
  percent?: string | null;
  confirmed?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  notes?: string | null;
  provenance?: Record<string, unknown>;
  bootstrapKey?: string | null;
}

export async function createOwnershipInterest(db: DbOrTx, input: OwnershipInterestInput): Promise<OwnershipInterestRow> {
  if (input.holderEntityId === input.heldEntityId) throw new InvalidError('An entity cannot hold itself');
  if (input.percent != null) assertDecimal(input.percent, 'percent');
  return mapErrors('create ownership interest', async () => {
    const [row] = await db
      .insert(ownershipInterests)
      .values({
        holderEntityId: input.holderEntityId,
        heldEntityId: input.heldEntityId,
        percent: input.percent ?? null,
        confirmed: input.confirmed ?? false,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        notes: input.notes ?? null,
        provenance: input.provenance ?? {},
        bootstrapKey: input.bootstrapKey ?? null,
      })
      .returning();
    return required(row, 'ownership interest');
  });
}

export async function updateOwnershipInterest(
  db: DbOrTx,
  id: string,
  patch: Partial<Omit<OwnershipInterestInput, 'holderEntityId' | 'heldEntityId' | 'bootstrapKey'>>,
): Promise<OwnershipInterestRow> {
  if (patch.percent != null) assertDecimal(patch.percent, 'percent');
  const values = pickDefined(patch);
  return mapErrors('update ownership interest', async () => {
    const [row] = await db.update(ownershipInterests).set(values).where(eq(ownershipInterests.id, id)).returning();
    return required(row, 'ownership interest');
  });
}

export async function getOwnershipInterestByBootstrapKey(db: DbOrTx, key: string): Promise<OwnershipInterestRow | undefined> {
  const [row] = await db.select().from(ownershipInterests).where(eq(ownershipInterests.bootstrapKey, key)).limit(1);
  return row;
}

export async function listOwnershipInterests(
  db: DbOrTx,
  query: { holderEntityId?: string; heldEntityId?: string } = {},
): Promise<OwnershipInterestRow[]> {
  const conditions: SQL[] = [];
  if (query.holderEntityId) conditions.push(eq(ownershipInterests.holderEntityId, query.holderEntityId));
  if (query.heldEntityId) conditions.push(eq(ownershipInterests.heldEntityId, query.heldEntityId));
  return db
    .select()
    .from(ownershipInterests)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(ownershipInterests.createdAt));
}

/** Interests involving `entityId` on either side. */
export async function listInterestsForEntity(db: DbOrTx, entityId: string): Promise<OwnershipInterestRow[]> {
  const clause = or(eq(ownershipInterests.holderEntityId, entityId), eq(ownershipInterests.heldEntityId, entityId));
  return db.select().from(ownershipInterests).where(clause).orderBy(asc(ownershipInterests.createdAt));
}
