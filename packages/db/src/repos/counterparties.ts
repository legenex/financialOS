/**
 * Counterparties (who the money went to or came from). A counterparty whose `entityId` is
 * set is one of our own entities: those movements are internal, not external income or spend.
 */
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { normaliseText } from '@financialos/domain';
import { counterparties, COUNTERPARTY_KINDS } from '../schema/org';
import { mapErrors, pickDefined, required, type DbOrTx } from './_util';

export type CounterpartyRow = typeof counterparties.$inferSelect;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

export interface CreateCounterpartyInput {
  name: string;
  kind?: CounterpartyKind;
  /** Set when this counterparty is one of our own entities. */
  entityId?: string | null;
  aliases?: string[];
  notes?: string | null;
  bootstrapKey?: string | null;
}

export async function createCounterparty(db: DbOrTx, input: CreateCounterpartyInput): Promise<CounterpartyRow> {
  return mapErrors('create counterparty', async () => {
    const [row] = await db
      .insert(counterparties)
      .values({
        name: input.name,
        kind: input.kind ?? 'unknown',
        entityId: input.entityId ?? null,
        normalizedName: normaliseText(input.name),
        aliases: input.aliases ?? [],
        notes: input.notes ?? null,
        bootstrapKey: input.bootstrapKey ?? null,
      })
      .returning();
    return required(row, 'counterparty');
  });
}

export async function updateCounterparty(
  db: DbOrTx,
  id: string,
  patch: Partial<Omit<CreateCounterpartyInput, 'bootstrapKey'>>,
): Promise<CounterpartyRow> {
  const values = pickDefined(patch);
  if (typeof patch.name === 'string') values.normalizedName = normaliseText(patch.name);
  return mapErrors('update counterparty', async () => {
    const [row] = await db.update(counterparties).set(values).where(eq(counterparties.id, id)).returning();
    return required(row, 'counterparty');
  });
}

export async function getCounterparty(db: DbOrTx, id: string): Promise<CounterpartyRow | undefined> {
  const [row] = await db.select().from(counterparties).where(eq(counterparties.id, id)).limit(1);
  return row;
}

export async function getCounterpartyByBootstrapKey(db: DbOrTx, key: string): Promise<CounterpartyRow | undefined> {
  const [row] = await db.select().from(counterparties).where(eq(counterparties.bootstrapKey, key)).limit(1);
  return row;
}

/** Exact match on the normalised name, or on one of the stored aliases. */
export async function findCounterpartyByName(db: DbOrTx, name: string): Promise<CounterpartyRow | undefined> {
  const normalized = normaliseText(name);
  const [row] = await db
    .select()
    .from(counterparties)
    .where(sql`${counterparties.normalizedName} = ${normalized} OR ${normalized} = ANY (${counterparties.aliases})`)
    .limit(1);
  return row;
}

export async function listCounterparties(db: DbOrTx, query: { kind?: CounterpartyKind; entityId?: string } = {}): Promise<CounterpartyRow[]> {
  const conditions: SQL[] = [];
  if (query.kind) conditions.push(eq(counterparties.kind, query.kind));
  if (query.entityId) conditions.push(eq(counterparties.entityId, query.entityId));
  return db
    .select()
    .from(counterparties)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(counterparties.name));
}

export async function getOrCreateCounterparty(db: DbOrTx, input: CreateCounterpartyInput): Promise<{ row: CounterpartyRow; created: boolean }> {
  if (input.bootstrapKey) {
    const existing = await getCounterpartyByBootstrapKey(db, input.bootstrapKey);
    if (existing) return { row: existing, created: false };
  }
  const existing = await findCounterpartyByName(db, input.name);
  if (existing) return { row: existing, created: false };
  return { row: await createCounterparty(db, input), created: true };
}

/**
 * The counterparty row that stands for one of our own entities, created on demand. Used to
 * attribute an intercompany journal line to the other side.
 */
export async function getOrCreateInternalCounterparty(db: DbOrTx, entityId: string, name: string): Promise<CounterpartyRow> {
  const [existing] = await db
    .select()
    .from(counterparties)
    .where(and(eq(counterparties.entityId, entityId), eq(counterparties.kind, 'internal')))
    .limit(1);
  if (existing) return existing;
  return createCounterparty(db, { name, kind: 'internal', entityId });
}

export async function addCounterpartyAlias(db: DbOrTx, id: string, alias: string): Promise<CounterpartyRow> {
  const normalized = normaliseText(alias);
  const [row] = await db
    .update(counterparties)
    .set({ aliases: sql`(SELECT array_agg(DISTINCT a) FROM unnest(${counterparties.aliases} || ARRAY[${normalized}]::text[]) AS a)` })
    .where(eq(counterparties.id, id))
    .returning();
  return required(row, 'counterparty');
}
