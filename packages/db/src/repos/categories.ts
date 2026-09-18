/**
 * The category tree. Seed categories (migration 0003) carry a `seedKey` and `system = true`;
 * the owner's own categories do not. Categories are archived rather than deleted so past
 * classifications keep their meaning.
 */
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { categories, CATEGORY_KINDS } from '../schema/sources';
import { ConflictError, mapErrors, pickDefined, required, type DbOrTx } from './_util';

export type CategoryRow = typeof categories.$inferSelect;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export interface CreateCategoryInput {
  name: string;
  kind: CategoryKind;
  parentId?: string | null;
  /** Essential spending is protected first in a squeeze. */
  essential?: boolean;
  seedKey?: string | null;
  system?: boolean;
}

export async function create(db: DbOrTx, input: CreateCategoryInput): Promise<CategoryRow> {
  return mapErrors('create category', async () => {
    const [row] = await db
      .insert(categories)
      .values({
        name: input.name,
        kind: input.kind,
        parentId: input.parentId ?? null,
        essential: input.essential ?? false,
        seedKey: input.seedKey ?? null,
        system: input.system ?? false,
      })
      .returning();
    return required(row, 'category');
  });
}

export async function update(
  db: DbOrTx,
  id: string,
  patch: Partial<Pick<CreateCategoryInput, 'name' | 'parentId' | 'essential'>>,
): Promise<CategoryRow> {
  if (patch.parentId === id) throw new ConflictError('A category cannot be its own parent');
  return mapErrors('update category', async () => {
    const [row] = await db.update(categories).set(pickDefined(patch)).where(eq(categories.id, id)).returning();
    return required(row, 'category');
  });
}

export async function archive(db: DbOrTx, id: string, now = new Date()): Promise<CategoryRow> {
  const [row] = await db.update(categories).set({ archivedAt: now }).where(eq(categories.id, id)).returning();
  return required(row, 'category');
}

export async function unarchive(db: DbOrTx, id: string): Promise<CategoryRow> {
  const [row] = await db.update(categories).set({ archivedAt: null }).where(eq(categories.id, id)).returning();
  return required(row, 'category');
}

export async function getById(db: DbOrTx, id: string): Promise<CategoryRow | undefined> {
  const [row] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  return row;
}

export async function getBySeedKey(db: DbOrTx, seedKey: string): Promise<CategoryRow | undefined> {
  const [row] = await db.select().from(categories).where(eq(categories.seedKey, seedKey)).limit(1);
  return row;
}

export async function list(db: DbOrTx, query: { kind?: CategoryKind; parentId?: string | null; includeArchived?: boolean } = {}): Promise<CategoryRow[]> {
  const conditions: SQL[] = [];
  if (query.kind) conditions.push(eq(categories.kind, query.kind));
  if (query.parentId === null) conditions.push(isNull(categories.parentId));
  else if (query.parentId) conditions.push(eq(categories.parentId, query.parentId));
  if (!query.includeArchived) conditions.push(isNull(categories.archivedAt));
  return db
    .select()
    .from(categories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(categories.name));
}

/** Finds a category by seed key, creating it when it is missing. Idempotent. */
export async function getOrCreate(db: DbOrTx, input: CreateCategoryInput & { seedKey: string }): Promise<{ row: CategoryRow; created: boolean }> {
  const existing = await getBySeedKey(db, input.seedKey);
  if (existing) return { row: existing, created: false };
  return mapErrors('get or create category', async () => {
    const inserted = await db
      .insert(categories)
      .values({
        name: input.name,
        kind: input.kind,
        parentId: input.parentId ?? null,
        essential: input.essential ?? false,
        seedKey: input.seedKey,
        system: input.system ?? false,
      })
      .onConflictDoNothing({ target: categories.seedKey })
      .returning();
    if (inserted[0]) return { row: inserted[0], created: true };
    return { row: required(await getBySeedKey(db, input.seedKey), 'category'), created: false };
  });
}

/** Ids of a category and everything beneath it, for a report that rolls sub-categories up. */
export async function descendantIds(db: DbOrTx, rootId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE tree AS (
      SELECT id FROM categories WHERE id = ${rootId}
      UNION ALL
      SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id
    )
    SELECT id FROM tree`);
  return [...rows].map((row) => row.id);
}
