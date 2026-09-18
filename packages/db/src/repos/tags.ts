/**
 * Free-form tags, kept outside the immutable source record so tagging never touches
 * `source_records`.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { sourceRecordTags, tags } from '../schema/sources';
import { mapErrors, required, tx, type DbOrTx } from './_util';

export type TagRow = typeof tags.$inferSelect;
export type SourceRecordTagRow = typeof sourceRecordTags.$inferSelect;

export async function getOrCreate(db: DbOrTx, name: string, color: string | null = null): Promise<{ row: TagRow; created: boolean }> {
  return mapErrors('get or create tag', async () => {
    const inserted = await db.insert(tags).values({ name, color }).onConflictDoNothing({ target: tags.name }).returning();
    if (inserted[0]) return { row: inserted[0], created: true };
    const [existing] = await db.select().from(tags).where(eq(tags.name, name)).limit(1);
    return { row: required(existing, 'tag'), created: false };
  });
}

export async function rename(db: DbOrTx, id: string, name: string): Promise<TagRow> {
  return mapErrors('rename tag', async () => {
    const [row] = await db.update(tags).set({ name }).where(eq(tags.id, id)).returning();
    return required(row, 'tag');
  });
}

export async function setColor(db: DbOrTx, id: string, color: string | null): Promise<TagRow> {
  const [row] = await db.update(tags).set({ color }).where(eq(tags.id, id)).returning();
  return required(row, 'tag');
}

export async function list(db: DbOrTx): Promise<TagRow[]> {
  return db.select().from(tags).orderBy(asc(tags.name));
}

export async function getById(db: DbOrTx, id: string): Promise<TagRow | undefined> {
  const [row] = await db.select().from(tags).where(eq(tags.id, id)).limit(1);
  return row;
}

/** Deleting a tag removes its links (the join table cascades) but touches nothing else. */
export async function remove(db: DbOrTx, id: string): Promise<boolean> {
  return mapErrors('delete tag', async () => {
    const rows = await db.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id });
    return rows.length > 0;
  });
}

/** Attaches tags (creating any that are new) to one source record. Idempotent. */
export async function setForSourceRecord(db: DbOrTx, sourceRecordId: string, names: readonly string[]): Promise<TagRow[]> {
  return mapErrors('set source record tags', () =>
    tx(db, async (t) => {
      const wanted: TagRow[] = [];
      for (const name of [...new Set(names)]) wanted.push((await getOrCreate(t, name)).row);
      const wantedIds = new Set(wanted.map((tag) => tag.id));
      const current = await t.select().from(sourceRecordTags).where(eq(sourceRecordTags.sourceRecordId, sourceRecordId));
      const currentIds = new Set(current.map((link) => link.tagId));

      const toAdd = wanted.filter((tag) => !currentIds.has(tag.id));
      if (toAdd.length > 0) {
        await t
          .insert(sourceRecordTags)
          .values(toAdd.map((tag) => ({ sourceRecordId, tagId: tag.id })))
          .onConflictDoNothing();
      }
      const toRemove = [...currentIds].filter((id) => !wantedIds.has(id));
      if (toRemove.length > 0) {
        await t
          .delete(sourceRecordTags)
          .where(and(eq(sourceRecordTags.sourceRecordId, sourceRecordId), inArray(sourceRecordTags.tagId, toRemove)));
      }
      return wanted;
    }),
  );
}

export async function addToSourceRecord(db: DbOrTx, sourceRecordId: string, name: string): Promise<TagRow> {
  return tx(db, async (t) => {
    const { row } = await getOrCreate(t, name);
    await t.insert(sourceRecordTags).values({ sourceRecordId, tagId: row.id }).onConflictDoNothing();
    return row;
  });
}

export async function removeFromSourceRecord(db: DbOrTx, sourceRecordId: string, tagId: string): Promise<boolean> {
  const rows = await db
    .delete(sourceRecordTags)
    .where(and(eq(sourceRecordTags.sourceRecordId, sourceRecordId), eq(sourceRecordTags.tagId, tagId)))
    .returning({ tagId: sourceRecordTags.tagId });
  return rows.length > 0;
}

export async function forSourceRecord(db: DbOrTx, sourceRecordId: string): Promise<TagRow[]> {
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color, createdAt: tags.createdAt })
    .from(sourceRecordTags)
    .innerJoin(tags, eq(tags.id, sourceRecordTags.tagId))
    .where(eq(sourceRecordTags.sourceRecordId, sourceRecordId))
    .orderBy(asc(tags.name));
}

/** Tags for many records at once, keyed by source record id. */
export async function forSourceRecords(db: DbOrTx, sourceRecordIds: readonly string[]): Promise<Map<string, TagRow[]>> {
  if (sourceRecordIds.length === 0) return new Map();
  const rows = await db
    .select({
      sourceRecordId: sourceRecordTags.sourceRecordId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
      createdAt: tags.createdAt,
    })
    .from(sourceRecordTags)
    .innerJoin(tags, eq(tags.id, sourceRecordTags.tagId))
    .where(inArray(sourceRecordTags.sourceRecordId, [...sourceRecordIds]))
    .orderBy(asc(tags.name));
  const grouped = new Map<string, TagRow[]>();
  for (const { sourceRecordId, ...tag } of rows) {
    const list = grouped.get(sourceRecordId) ?? [];
    list.push(tag);
    grouped.set(sourceRecordId, list);
  }
  return grouped;
}
