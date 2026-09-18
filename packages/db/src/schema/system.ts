import { sql } from 'drizzle-orm';
import { bigint, check, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, pk, tstz } from './_columns';

/** Key/value application settings. Values are JSON; defaults are inserted by migration. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedBy: text('updated_by').default('system'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const BACKUP_STATUSES = ['running', 'succeeded', 'failed'] as const;

export const backups = pgTable(
  'backups',
  {
    id: pk(),
    status: text('status').$type<(typeof BACKUP_STATUSES)[number]>().notNull().default('running'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    sha256: text('sha256'),
    keyVersion: text('key_version'),
    destination: text('destination').$type<'local' | 'offhost'>().notNull().default('local'),
    includes: text('includes').array().notNull().default(sql`'{}'::text[]`),
    /** Artifact name relative to the backup directory. Never an absolute host path. */
    artifactName: text('artifact_name'),
    restoreVerifiedAt: tstz('restore_verified_at'),
    restoreVerification: text('restore_verification'),
    error: text('error'),
    jobId: uuid('job_id'),
    createdAt: createdAt(),
  },
  () => [
    check('backups_status_check', inList('status', BACKUP_STATUSES)),
    check('backups_destination_check', inList('destination', ['local', 'offhost'])),
    check('backups_artifact_name_check', sql`artifact_name IS NULL OR artifact_name !~ '(^/|\\.\\.)'`),
  ],
);

/** One row per applied private bootstrap file. Presence makes re-application a no-op. */
export const bootstrapRuns = pgTable('bootstrap_runs', {
  id: pk(),
  bootstrapId: text('bootstrap_id').notNull().unique('bootstrap_runs_bootstrap_id_key'),
  formatVersion: integer('format_version').notNull(),
  fileSha256: text('file_sha256').notNull(),
  counts: jsonb('counts').$type<Record<string, number>>().notNull(),
  appliedBy: text('applied_by').notNull().default('bootstrap-cli'),
  appliedAt: tstz('applied_at').notNull().defaultNow(),
});
