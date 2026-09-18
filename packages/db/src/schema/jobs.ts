import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, jsonObject, pk, tstz, updatedAt } from './_columns';
import { entities } from './org';

export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'cancelling',
  'dead_letter',
  'retrying',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** User-visible job state mirrored from pg-boss. Errors stored here must already be redacted. */
export const jobRecords = pgTable(
  'job_records',
  {
    id: pk(),
    queue: text('queue').notNull(),
    label: text('label').notNull(),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    progress: numeric('progress', { precision: 5, scale: 4, mode: 'string' }),
    progressLabel: text('progress_label'),
    attempts: integer('attempts').notNull().default(0),
    cancellable: boolean('cancellable').notNull().default(false),
    cancelRequestedAt: tstz('cancel_requested_at'),
    idempotencyKey: text('idempotency_key').notNull().unique('job_records_idempotency_key_key'),
    pgbossJobId: text('pgboss_job_id'),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    entityId: uuid('entity_id').references(() => entities.id),
    requestedBy: text('requested_by').notNull().default('system'),
    payload: jsonObject('payload'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    heartbeatAt: tstz('heartbeat_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('job_records_status_check', inList('status', JOB_STATUSES)),
    check('job_records_progress_check', sql`progress IS NULL OR (progress >= 0 AND progress <= 1)`),
    index('job_records_status_idx').on(t.status, t.createdAt),
    index('job_records_subject_idx').on(t.subjectType, t.subjectId),
    index('job_records_pgboss_idx').on(t.pgbossJobId),
  ],
);

export const workerHeartbeats = pgTable('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  version: text('version').notNull(),
  status: text('status').notNull().default('running'),
  queues: text('queues').array().notNull().default(sql`'{}'::text[]`),
  details: jsonObject('details'),
  startedAt: tstz('started_at').notNull().defaultNow(),
  lastBeatAt: tstz('last_beat_at').notNull().defaultNow(),
});
