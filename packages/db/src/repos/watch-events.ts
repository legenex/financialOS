/**
 * Things to verify, not facts: a possible listing, an expected release, a rumoured change.
 * A watch event never affects valuation or spending capacity. It only reminds the owner to
 * check something.
 */
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { watchEvents, WATCH_EVENT_STATUSES } from '../schema/accounts';
import { mapErrors, pickDefined, required, type DbOrTx } from './_util';

export type WatchEventRow = typeof watchEvents.$inferSelect;
export type WatchEventStatus = (typeof WATCH_EVENT_STATUSES)[number];

export interface CreateInput {
  kind: string;
  title: string;
  instrumentId?: string | null;
  accountId?: string | null;
  status?: WatchEventStatus;
  expectedDate?: string | null;
  notes?: string | null;
  sourceUrl?: string | null;
  provenance?: Record<string, unknown>;
  bootstrapKey?: string | null;
}

export async function create(db: DbOrTx, input: CreateInput): Promise<WatchEventRow> {
  return mapErrors('create watch event', async () => {
    const [row] = await db
      .insert(watchEvents)
      .values({
        kind: input.kind,
        title: input.title,
        instrumentId: input.instrumentId ?? null,
        accountId: input.accountId ?? null,
        status: input.status ?? 'unverified',
        expectedDate: input.expectedDate ?? null,
        notes: input.notes ?? null,
        sourceUrl: input.sourceUrl ?? null,
        provenance: input.provenance ?? {},
        bootstrapKey: input.bootstrapKey ?? null,
      })
      .returning();
    return required(row, 'watch event');
  });
}

export async function update(db: DbOrTx, id: string, patch: Partial<Omit<CreateInput, 'bootstrapKey'>>): Promise<WatchEventRow> {
  return mapErrors('update watch event', async () => {
    const [row] = await db.update(watchEvents).set(pickDefined(patch)).where(eq(watchEvents.id, id)).returning();
    return required(row, 'watch event');
  });
}

export async function setStatus(db: DbOrTx, id: string, status: WatchEventStatus): Promise<WatchEventRow> {
  return update(db, id, { status });
}

export async function getById(db: DbOrTx, id: string): Promise<WatchEventRow | undefined> {
  const [row] = await db.select().from(watchEvents).where(eq(watchEvents.id, id)).limit(1);
  return row;
}

export async function getByBootstrapKey(db: DbOrTx, key: string): Promise<WatchEventRow | undefined> {
  const [row] = await db.select().from(watchEvents).where(eq(watchEvents.bootstrapKey, key)).limit(1);
  return row;
}

export async function list(
  db: DbOrTx,
  query: { instrumentId?: string; accountId?: string; status?: WatchEventStatus | WatchEventStatus[] } = {},
): Promise<WatchEventRow[]> {
  const conditions: SQL[] = [];
  if (query.instrumentId) conditions.push(eq(watchEvents.instrumentId, query.instrumentId));
  if (query.accountId) conditions.push(eq(watchEvents.accountId, query.accountId));
  if (query.status) conditions.push(inArray(watchEvents.status, Array.isArray(query.status) ? query.status : [query.status]));
  return db
    .select()
    .from(watchEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(watchEvents.expectedDate), asc(watchEvents.createdAt));
}
