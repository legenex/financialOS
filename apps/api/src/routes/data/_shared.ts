/**
 * Helpers shared by the owner data routes.
 *
 * Every route module registers through `ownerRoutes`, which applies the core session guard
 * (`requireOwner`): session cookie only, CSRF on unsafe methods, `Cache-Control: no-store` from the
 * security-headers plugin. Long work is enqueued with `enqueueJob`, never run inline.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { jobRecords, type DbOrTx } from '@financialos/db';
import type { JobRecord } from '@financialos/contracts';
import { ApiError, errors } from '../../errors';
import { audit } from '../../auth/audit';
import { ownerSessionOf, registerOwnerRoutes, type RouteRegistrar } from '../../auth/guards';
import { loadFinanceBase, type FinanceBase } from '../../data/finance';
import { iso, requireUuid } from '../../data/common';

export { audit, ownerSessionOf, requireUuid };

/** Registers a group of owner routes with the core guard applied to all of them. */
export function ownerRoutes(app: FastifyInstance, register: RouteRegistrar): void {
  registerOwnerRoutes(app, register);
}

export const IsoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** Query parameters shared by the finance views (see docs/API.md). */
export const ScopeQuery = z.object({
  entityId: z.uuid().optional(),
  scope: z.enum(['personal', 'consolidated', 'entity']).optional(),
  from: IsoDateString.optional(),
  to: IsoDateString.optional(),
  currency: z.string().regex(/^[A-Z0-9]{2,10}$/).optional(),
  scenarioId: z.uuid().optional(),
});
export type ScopeQuery = z.infer<typeof ScopeQuery>;

export function financeBase(req: FastifyRequest): Promise<FinanceBase> {
  return loadFinanceBase(req.server.fos);
}

export interface EnqueueOptions {
  queue: string;
  label: string;
  data?: Record<string, unknown>;
  /** Stops a second identical job from queueing while one is pending. */
  singletonKey?: string;
  /** Makes repeated requests idempotent; defaults to a fresh uuid. */
  idempotencyKey?: string;
  cancellable?: boolean;
  subjectType?: string;
  subjectId?: string | null;
  entityId?: string | null;
}

/**
 * Creates the user-visible job record and enqueues the durable job. The job outlives this session:
 * the response only carries the job id so the client can follow progress.
 */
export async function enqueueJob(req: FastifyRequest, options: EnqueueOptions): Promise<{ jobId: string }> {
  const { db, jobs } = req.server.fos;
  const session = ownerSessionOf(req);
  const idempotencyKey = options.idempotencyKey ?? `${options.queue}:${randomUUID()}`;
  const existing = await db.select().from(jobRecords).where(eq(jobRecords.idempotencyKey, idempotencyKey)).limit(1);
  let record = existing[0];
  if (!record) {
    const inserted = await db
      .insert(jobRecords)
      .values({
        queue: options.queue,
        label: options.label,
        idempotencyKey,
        cancellable: options.cancellable ?? true,
        subjectType: options.subjectType ?? null,
        subjectId: options.subjectId ?? null,
        entityId: options.entityId ?? null,
        requestedBy: `session:${session.id}`,
        payload: options.data ?? {},
      })
      .onConflictDoNothing({ target: jobRecords.idempotencyKey })
      .returning();
    record = inserted[0];
    if (!record) {
      const [again] = await db.select().from(jobRecords).where(eq(jobRecords.idempotencyKey, idempotencyKey)).limit(1);
      if (!again) throw new Error('job record vanished after conflict');
      record = again;
    } else {
      let result: { jobId: string | null };
      try {
        result = await jobs.enqueue(options.queue, { ...(options.data ?? {}), jobRecordId: record.id }, options.singletonKey ? { singletonKey: options.singletonKey } : {});
      } catch {
        await db.delete(jobRecords).where(eq(jobRecords.id, record.id));
        throw new ApiError(503, 'jobs_unavailable', 'Background work cannot be scheduled right now. Try again shortly.');
      }
      if (result.jobId) await db.update(jobRecords).set({ pgbossJobId: result.jobId }).where(eq(jobRecords.id, record.id));
    }
  }
  return { jobId: record.id };
}

export function jobRecordView(row: typeof jobRecords.$inferSelect): JobRecord {
  return {
    id: row.id,
    queue: row.queue,
    label: row.label,
    status: row.status,
    // Progress is a 0–1 UI indicator, never an amount.
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

/** Loads one row by id or raises a typed 404. */
export async function loadOne<T>(promise: Promise<T[]>, code: string, message: string): Promise<T> {
  const rows = await promise;
  const row = rows[0];
  if (!row) throw errors.notFound(code, message);
  return row;
}

export type { DbOrTx };
