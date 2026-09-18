/**
 * `job_records` (user-visible mirror of pg-boss state) and `worker_heartbeats` writes.
 *
 * Like `./exceptions.ts`, this is a small, self-contained implementation against the exported
 * schema tables rather than `packages/db`'s `repos/jobs.ts`, which is not wired into that
 * package's public export yet (see the worker's final report for details).
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { jobRecords, workerHeartbeats, type DbOrTx, type JobStatus } from '@financialos/db';

export interface CreateJobRecordInput {
  queue: string;
  label: string;
  idempotencyKey: string;
  subjectType?: string | null;
  subjectId?: string | null;
  entityId?: string | null;
  requestedBy?: string;
  payload?: Record<string, unknown>;
}

/** Creates a job record, or returns the existing one for the same idempotency key. */
export async function createJobRecord(db: DbOrTx, input: CreateJobRecordInput): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insert(jobRecords)
    .values({
      queue: input.queue,
      label: input.label,
      idempotencyKey: input.idempotencyKey,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      entityId: input.entityId ?? null,
      requestedBy: input.requestedBy ?? 'system',
      payload: input.payload ?? {},
    })
    .onConflictDoNothing({ target: jobRecords.idempotencyKey })
    .returning({ id: jobRecords.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const [existing] = await db.select({ id: jobRecords.id }).from(jobRecords).where(eq(jobRecords.idempotencyKey, input.idempotencyKey)).limit(1);
  if (!existing) throw new Error('job record vanished after conflict');
  return { id: existing.id, created: false };
}

export async function markJobRunning(db: DbOrTx, id: string, now = new Date()): Promise<void> {
  await db
    .update(jobRecords)
    .set({ status: 'running', attempts: sql`${jobRecords.attempts} + 1`, startedAt: sql`coalesce(${jobRecords.startedAt}, ${now.toISOString()}::timestamptz)`, heartbeatAt: now, error: null })
    .where(and(eq(jobRecords.id, id), inArray(jobRecords.status, ['queued', 'retrying', 'running'])));
}

export async function updateJobProgress(db: DbOrTx, id: string, progress: string | null, label: string | null, now = new Date()): Promise<void> {
  await db.update(jobRecords).set({ progress, progressLabel: label, heartbeatAt: now }).where(eq(jobRecords.id, id));
}

export async function completeJobRecord(db: DbOrTx, id: string, result: Record<string, unknown>, now = new Date()): Promise<void> {
  await db.update(jobRecords).set({ status: 'succeeded', progress: '1', result, finishedAt: now, error: null }).where(eq(jobRecords.id, id));
}

/** `error` must already be redacted — never the raw error message from user data. */
export async function failJobRecord(db: DbOrTx, id: string, input: { error: string; willRetry: boolean; deadLetter?: boolean }, now = new Date()): Promise<void> {
  const status: JobStatus = input.willRetry ? 'retrying' : input.deadLetter ? 'dead_letter' : 'failed';
  await db.update(jobRecords).set({ status, error: input.error.slice(0, 2000), finishedAt: input.willRetry ? null : now }).where(eq(jobRecords.id, id));
}

export async function recordWorkerHeartbeat(
  db: DbOrTx,
  input: { workerId: string; version: string; status?: string; queues?: string[]; details?: Record<string, unknown> },
  now = new Date(),
): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ workerId: input.workerId, version: input.version, status: input.status ?? 'running', queues: input.queues ?? [], details: input.details ?? {}, startedAt: now, lastBeatAt: now })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: { version: input.version, status: input.status ?? 'running', queues: input.queues ?? [], details: input.details ?? {}, lastBeatAt: now },
    });
}

export async function deleteFinishedJobRecords(db: DbOrTx, olderThanDays: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000);
  const rows = await db
    .delete(jobRecords)
    .where(and(inArray(jobRecords.status, ['succeeded', 'failed', 'cancelled', 'dead_letter']), lt(jobRecords.finishedAt, cutoff)))
    .returning({ id: jobRecords.id });
  return rows.length;
}
