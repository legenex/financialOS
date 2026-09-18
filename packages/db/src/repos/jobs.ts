import { and, count, desc, eq, gt, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import type { JobRecord } from '@financialos/contracts';
import { jobRecords, workerHeartbeats, type JobStatus } from '../schema/jobs';
import { addSeconds, clampLimit, InvalidError, iso, type DbOrTx } from './_util';

export type JobRecordRow = typeof jobRecords.$inferSelect;
export type WorkerHeartbeatRow = typeof workerHeartbeats.$inferSelect;

const TERMINAL: JobStatus[] = ['succeeded', 'failed', 'cancelled', 'dead_letter'];

export interface CreateJobInput {
  queue: string;
  label: string;
  idempotencyKey: string;
  cancellable?: boolean;
  subjectType?: string | null;
  subjectId?: string | null;
  entityId?: string | null;
  requestedBy?: string;
  /** Non-secret parameters only. */
  payload?: Record<string, unknown>;
}

/**
 * Creates a job record, or returns the existing one for the same idempotency key.
 * `created` tells the caller whether to enqueue the pg-boss job.
 */
export async function createJobRecord(db: DbOrTx, input: CreateJobInput): Promise<{ job: JobRecordRow; created: boolean }> {
  const inserted = await db
    .insert(jobRecords)
    .values({
      queue: input.queue,
      label: input.label,
      idempotencyKey: input.idempotencyKey,
      cancellable: input.cancellable ?? false,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      entityId: input.entityId ?? null,
      requestedBy: input.requestedBy ?? 'system',
      payload: input.payload ?? {},
    })
    .onConflictDoNothing({ target: jobRecords.idempotencyKey })
    .returning();
  if (inserted[0]) return { job: inserted[0], created: true };
  const [existing] = await db.select().from(jobRecords).where(eq(jobRecords.idempotencyKey, input.idempotencyKey)).limit(1);
  if (!existing) throw new Error('job record vanished after conflict');
  return { job: existing, created: false };
}

export async function getJobRecord(db: DbOrTx, id: string): Promise<JobRecordRow | null> {
  const [row] = await db.select().from(jobRecords).where(eq(jobRecords.id, id)).limit(1);
  return row ?? null;
}

export async function getJobRecordByIdempotencyKey(db: DbOrTx, key: string): Promise<JobRecordRow | null> {
  const [row] = await db.select().from(jobRecords).where(eq(jobRecords.idempotencyKey, key)).limit(1);
  return row ?? null;
}

export async function listJobRecords(
  db: DbOrTx,
  query: { status?: JobStatus | JobStatus[]; queue?: string; subjectType?: string; subjectId?: string; limit?: number } = {},
): Promise<JobRecordRow[]> {
  const conditions: SQL[] = [];
  if (query.status) conditions.push(inArray(jobRecords.status, Array.isArray(query.status) ? query.status : [query.status]));
  if (query.queue) conditions.push(eq(jobRecords.queue, query.queue));
  if (query.subjectType) conditions.push(eq(jobRecords.subjectType, query.subjectType));
  if (query.subjectId) conditions.push(eq(jobRecords.subjectId, query.subjectId));
  return db
    .select()
    .from(jobRecords)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(jobRecords.createdAt))
    .limit(clampLimit(query.limit, 50, 200));
}

export async function setPgBossJobId(db: DbOrTx, id: string, pgbossJobId: string): Promise<void> {
  await db.update(jobRecords).set({ pgbossJobId }).where(eq(jobRecords.id, id));
}

/** Marks a job running (attempt + 1). Returns null if it was cancelled meanwhile. */
export async function markJobRunning(db: DbOrTx, id: string, now = new Date()): Promise<JobRecordRow | null> {
  const [row] = await db
    .update(jobRecords)
    .set({
      status: 'running',
      attempts: sql`${jobRecords.attempts} + 1`,
      startedAt: sql`coalesce(${jobRecords.startedAt}, ${now.toISOString()}::timestamptz)`,
      heartbeatAt: now,
      error: null,
    })
    .where(and(eq(jobRecords.id, id), inArray(jobRecords.status, ['queued', 'retrying', 'running'])))
    .returning();
  return row ?? null;
}

/** Progress is a decimal string between 0 and 1 (for example "0.25"). */
export async function updateJobProgress(
  db: DbOrTx,
  id: string,
  progress: string | null,
  label: string | null,
  now = new Date(),
): Promise<void> {
  if (progress !== null && !/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/.test(progress)) {
    throw new InvalidError('progress must be a decimal string between 0 and 1 with at most 4 places');
  }
  await db
    .update(jobRecords)
    .set({ progress, progressLabel: label, heartbeatAt: now })
    .where(and(eq(jobRecords.id, id), inArray(jobRecords.status, ['running', 'cancelling'])));
}

export async function completeJob(db: DbOrTx, id: string, result: Record<string, unknown>, now = new Date()): Promise<void> {
  await db
    .update(jobRecords)
    .set({ status: 'succeeded', progress: '1', result, finishedAt: now, error: null })
    .where(eq(jobRecords.id, id));
}

/** `error` must already be redacted. */
export async function failJob(
  db: DbOrTx,
  id: string,
  input: { error: string; willRetry: boolean; deadLetter?: boolean },
  now = new Date(),
): Promise<void> {
  const status: JobStatus = input.willRetry ? 'retrying' : input.deadLetter ? 'dead_letter' : 'failed';
  await db
    .update(jobRecords)
    .set({ status, error: input.error.slice(0, 2000), finishedAt: input.willRetry ? null : now })
    .where(eq(jobRecords.id, id));
}

/** Requests cooperative cancellation. Queued jobs are cancelled immediately. */
export async function requestJobCancel(db: DbOrTx, id: string, now = new Date()): Promise<JobRecordRow | null> {
  const [row] = await db
    .update(jobRecords)
    .set({
      cancelRequestedAt: now,
      status: sql`CASE WHEN ${jobRecords.status} IN ('queued', 'retrying') THEN 'cancelled' ELSE 'cancelling' END`,
      finishedAt: sql`CASE WHEN ${jobRecords.status} IN ('queued', 'retrying') THEN ${now.toISOString()}::timestamptz ELSE ${jobRecords.finishedAt} END`,
    })
    .where(and(eq(jobRecords.id, id), eq(jobRecords.cancellable, true), inArray(jobRecords.status, ['queued', 'retrying', 'running'])))
    .returning();
  return row ?? null;
}

export async function isJobCancelRequested(db: DbOrTx, id: string): Promise<boolean> {
  const [row] = await db
    .select({ at: jobRecords.cancelRequestedAt })
    .from(jobRecords)
    .where(eq(jobRecords.id, id))
    .limit(1);
  return Boolean(row?.at);
}

export async function markJobCancelled(db: DbOrTx, id: string, now = new Date()): Promise<void> {
  await db
    .update(jobRecords)
    .set({ status: 'cancelled', finishedAt: now })
    .where(and(eq(jobRecords.id, id), isNotNull(jobRecords.cancelRequestedAt)));
}

export async function countJobsByStatus(db: DbOrTx, since?: Date): Promise<Record<JobStatus, number>> {
  const rows = await db
    .select({ status: jobRecords.status, n: count() })
    .from(jobRecords)
    .where(since ? gt(jobRecords.createdAt, since) : undefined)
    .groupBy(jobRecords.status);
  const out = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, cancelling: 0, dead_letter: 0, retrying: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export async function deleteFinishedJobs(db: DbOrTx, olderThanDays: number, now = new Date()): Promise<number> {
  const rows = await db
    .delete(jobRecords)
    .where(and(inArray(jobRecords.status, TERMINAL), lt(jobRecords.finishedAt, addSeconds(now, -olderThanDays * 86_400))))
    .returning({ id: jobRecords.id });
  return rows.length;
}

export function toJobRecord(row: JobRecordRow): JobRecord {
  return {
    id: row.id,
    queue: row.queue,
    label: row.label,
    status: row.status,
    // Progress is a UI indicator (0–1), not a financial amount.
    progress: row.progress === null ? null : Number(row.progress),
    progressLabel: row.progressLabel,
    attempts: row.attempts,
    cancellable: row.cancellable,
    createdAt: iso(row.createdAt),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    error: row.error,
    result: row.result ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// Worker heartbeats
// ---------------------------------------------------------------------------------------

export async function recordWorkerHeartbeat(
  db: DbOrTx,
  input: { workerId: string; version: string; status?: string; queues?: string[]; details?: Record<string, unknown> },
  now = new Date(),
): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({
      workerId: input.workerId,
      version: input.version,
      status: input.status ?? 'running',
      queues: input.queues ?? [],
      details: input.details ?? {},
      startedAt: now,
      lastBeatAt: now,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        version: input.version,
        status: input.status ?? 'running',
        queues: input.queues ?? [],
        details: input.details ?? {},
        lastBeatAt: now,
      },
    });
}

export async function latestWorkerHeartbeat(db: DbOrTx): Promise<WorkerHeartbeatRow | null> {
  const [row] = await db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastBeatAt)).limit(1);
  return row ?? null;
}

export async function deleteStaleHeartbeats(db: DbOrTx, olderThanSeconds: number, now = new Date()): Promise<number> {
  const rows = await db
    .delete(workerHeartbeats)
    .where(lt(workerHeartbeats.lastBeatAt, addSeconds(now, -olderThanSeconds)))
    .returning({ id: workerHeartbeats.workerId });
  return rows.length;
}
