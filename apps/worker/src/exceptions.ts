/**
 * Exception inbox writes for the worker. `packages/db` has a `repos/exceptions.ts` with the same
 * `raiseException` idempotent-upsert logic, but it (like the rest of `src/repos/*`) is not wired
 * into the package's public export yet, and at the time of writing the file this worker would
 * otherwise depend on (`repos/_util.ts`) has an unrelated, in-progress type error from concurrent
 * work on that package. To keep apps/worker buildable independently of that, this is a small,
 * self-contained re-implementation against the exported `exceptions` schema table only.
 */
import { and, eq, sql } from 'drizzle-orm';
import { exceptions, type DbOrTx, type ExceptionKindValue, type ExceptionSeverity } from '@financialos/db';

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
  source?: string;
}

/**
 * Raises an exception idempotently by dedupe key: an open exception is refreshed (occurrences +
 * 1, latest text); a resolved or dismissed one is left alone (the owner's decision stands).
 */
export async function raiseException(db: DbOrTx, input: RaiseExceptionInput): Promise<{ id: string; created: boolean }> {
  const now = new Date();
  const closed = sql`${exceptions.status} IN ('resolved', 'dismissed')`;
  const [row] = await db
    .insert(exceptions)
    .values({
      dedupeKey: input.dedupeKey,
      kind: input.kind,
      severity: input.severity ?? 'warning',
      status: 'open',
      title: input.title,
      body: input.body ?? '',
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      subjectLabel: input.subjectLabel ?? null,
      entityId: input.entityId ?? null,
      detail: input.detail ?? {},
      source: input.source ?? 'worker',
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: exceptions.dedupeKey,
      set: {
        occurrences: sql`${exceptions.occurrences} + 1`,
        lastSeenAt: now,
        title: sql`CASE WHEN ${closed} THEN ${exceptions.title} ELSE excluded.title END`,
        body: sql`CASE WHEN ${closed} THEN ${exceptions.body} ELSE excluded.body END`,
        detail: sql`CASE WHEN ${closed} THEN ${exceptions.detail} ELSE excluded.detail END`,
      },
    })
    .returning({ id: exceptions.id, inserted: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error('exception upsert returned no row');
  return { id: row.id, created: row.inserted };
}

/** Resolves an open exception by dedupe key when its cause has gone away (e.g. a period reconciled). */
export async function autoResolveException(db: DbOrTx, dedupeKey: string, note: string, now = new Date()): Promise<void> {
  await db
    .update(exceptions)
    .set({ status: 'resolved', resolution: note, resolvedAt: now, resolvedBy: 'worker' })
    .where(and(eq(exceptions.dedupeKey, dedupeKey), sql`${exceptions.status} IN ('open', 'snoozed')`));
}
