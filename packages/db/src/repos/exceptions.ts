import { and, count, desc, eq, getTableColumns, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { ExceptionItem } from '@financialos/contracts';
import {
  exceptions,
  type ExceptionKindValue,
  type ExceptionSeverity,
  type ExceptionStatus,
} from '../schema/exceptions';
import { addDaysTo, clampLimit, InvalidError, iso, type DbOrTx } from './_util';

export type ExceptionRow = typeof exceptions.$inferSelect;

export interface RaiseExceptionInput {
  dedupeKey: string;
  kind: ExceptionKindValue;
  severity?: ExceptionSeverity;
  title: string;
  body?: string;
  subjectType: string;
  subjectId?: string | null;
  subjectLabel?: string | null;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  suggestedActions?: Array<{ id: string; label: string; href: string | null }>;
  source?: string;
  /**
   * What to do when a resolved or dismissed exception with the same key is raised again.
   * `keep` (default) leaves the owner's decision alone; `reopen` opens it again.
   */
  onResolved?: 'keep' | 'reopen';
}

/**
 * Raises an exception idempotently by dedupe key. An open exception is refreshed
 * (occurrences + 1, latest text); a resolved one stays resolved unless `onResolved`
 * is `reopen`. Returns the row and whether it was newly created.
 */
export async function raiseException(db: DbOrTx, input: RaiseExceptionInput): Promise<{ row: ExceptionRow; created: boolean }> {
  const now = new Date();
  const values = {
    dedupeKey: input.dedupeKey,
    kind: input.kind,
    severity: input.severity ?? 'warning',
    status: 'open' as const,
    title: input.title,
    body: input.body ?? '',
    subjectType: input.subjectType,
    subjectId: input.subjectId ?? null,
    subjectLabel: input.subjectLabel ?? null,
    entityId: input.entityId ?? null,
    detail: input.detail ?? {},
    suggestedActions: input.suggestedActions ?? [],
    source: input.source ?? 'system',
    lastSeenAt: now,
  };
  const reopen = input.onResolved === 'reopen';
  const closed = sql`${exceptions.status} IN ('resolved', 'dismissed')`;
  const [row] = await db
    .insert(exceptions)
    .values(values)
    .onConflictDoUpdate({
      target: exceptions.dedupeKey,
      set: {
        occurrences: sql`${exceptions.occurrences} + 1`,
        lastSeenAt: now,
        title: sql`CASE WHEN ${closed} AND NOT ${reopen} THEN ${exceptions.title} ELSE excluded.title END`,
        body: sql`CASE WHEN ${closed} AND NOT ${reopen} THEN ${exceptions.body} ELSE excluded.body END`,
        severity: sql`CASE WHEN ${closed} AND NOT ${reopen} THEN ${exceptions.severity} ELSE excluded.severity END`,
        detail: sql`CASE WHEN ${closed} AND NOT ${reopen} THEN ${exceptions.detail} ELSE excluded.detail END`,
        suggestedActions: sql`CASE WHEN ${closed} AND NOT ${reopen} THEN ${exceptions.suggestedActions} ELSE excluded.suggested_actions END`,
        status: sql`CASE WHEN ${closed} AND ${reopen} THEN 'open' ELSE ${exceptions.status} END`,
        resolvedAt: sql`CASE WHEN ${closed} AND ${reopen} THEN NULL ELSE ${exceptions.resolvedAt} END`,
      },
    })
    .returning({ ...getTableColumns(exceptions), inserted: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error('exception upsert returned no row');
  const { inserted, ...rest } = row;
  return { row: rest, created: inserted };
}

export async function getException(db: DbOrTx, id: string): Promise<ExceptionRow | null> {
  const [row] = await db.select().from(exceptions).where(eq(exceptions.id, id)).limit(1);
  return row ?? null;
}

export async function getExceptionByDedupeKey(db: DbOrTx, dedupeKey: string): Promise<ExceptionRow | null> {
  const [row] = await db.select().from(exceptions).where(eq(exceptions.dedupeKey, dedupeKey)).limit(1);
  return row ?? null;
}

export interface ExceptionQuery {
  status?: ExceptionStatus | ExceptionStatus[];
  kind?: ExceptionKindValue | ExceptionKindValue[];
  entityId?: string;
  subjectType?: string;
  subjectId?: string;
  limit?: number;
}

export async function listExceptions(db: DbOrTx, query: ExceptionQuery = {}): Promise<ExceptionRow[]> {
  const conditions: SQL[] = [];
  if (query.status) conditions.push(inArray(exceptions.status, Array.isArray(query.status) ? query.status : [query.status]));
  if (query.kind) conditions.push(inArray(exceptions.kind, Array.isArray(query.kind) ? query.kind : [query.kind]));
  if (query.entityId) conditions.push(eq(exceptions.entityId, query.entityId));
  if (query.subjectType) conditions.push(eq(exceptions.subjectType, query.subjectType));
  if (query.subjectId) conditions.push(eq(exceptions.subjectId, query.subjectId));
  return db
    .select()
    .from(exceptions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      sql`CASE ${exceptions.severity} WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`,
      desc(exceptions.createdAt),
    )
    .limit(clampLimit(query.limit, 100, 500));
}

export async function countOpenExceptions(db: DbOrTx, options: { subjectType?: string; subjectId?: string } = {}): Promise<number> {
  const conditions: SQL[] = [eq(exceptions.status, 'open')];
  if (options.subjectType) conditions.push(eq(exceptions.subjectType, options.subjectType));
  if (options.subjectId) conditions.push(eq(exceptions.subjectId, options.subjectId));
  const [row] = await db.select({ n: count() }).from(exceptions).where(and(...conditions));
  return row?.n ?? 0;
}

export async function resolveException(
  db: DbOrTx,
  id: string,
  input: { note: string | null; by: string; dismiss?: boolean },
  now = new Date(),
): Promise<ExceptionRow | null> {
  const [row] = await db
    .update(exceptions)
    .set({
      status: input.dismiss ? 'dismissed' : 'resolved',
      resolution: input.note,
      resolvedAt: now,
      resolvedBy: input.by,
      snoozedUntil: null,
    })
    .where(eq(exceptions.id, id))
    .returning();
  return row ?? null;
}

export async function snoozeException(db: DbOrTx, id: string, days: number, now = new Date()): Promise<ExceptionRow | null> {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new InvalidError('Snooze must be between 1 and 90 days');
  const [row] = await db
    .update(exceptions)
    .set({ status: 'snoozed', snoozedUntil: addDaysTo(now, days) })
    .where(and(eq(exceptions.id, id), eq(exceptions.status, 'open')))
    .returning();
  return row ?? null;
}

export async function reopenException(db: DbOrTx, id: string, note: string | null = null): Promise<ExceptionRow | null> {
  const [row] = await db
    .update(exceptions)
    .set({ status: 'open', snoozedUntil: null, resolvedAt: null, resolvedBy: null, resolution: note })
    .where(eq(exceptions.id, id))
    .returning();
  return row ?? null;
}

/** Reopens snoozed exceptions whose snooze has ended. */
export async function wakeSnoozedExceptions(db: DbOrTx, now = new Date()): Promise<number> {
  const rows = await db
    .update(exceptions)
    .set({ status: 'open', snoozedUntil: null })
    .where(and(eq(exceptions.status, 'snoozed'), lte(exceptions.snoozedUntil, now)))
    .returning({ id: exceptions.id });
  return rows.length;
}

/** Resolves an open exception by key when its cause disappeared (for example a reconciled period). */
export async function autoResolveException(db: DbOrTx, dedupeKey: string, note: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(exceptions)
    .set({ status: 'resolved', resolution: note, resolvedAt: now, resolvedBy: 'system' })
    .where(and(eq(exceptions.dedupeKey, dedupeKey), inArray(exceptions.status, ['open', 'snoozed'])))
    .returning({ id: exceptions.id });
  return rows.length > 0;
}

export function toExceptionItem(row: ExceptionRow): ExceptionItem {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    title: row.title,
    detail: row.body,
    subject: { type: row.subjectType, id: row.subjectId, label: row.subjectLabel },
    entityId: row.entityId,
    suggestedActions: row.suggestedActions,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    snoozedUntil: iso(row.snoozedUntil),
    resolution: row.resolution,
  };
}
