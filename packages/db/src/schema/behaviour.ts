import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, inList, isoDate, jsonObject, pk, tstz, updatedAt } from './_columns';

type Json = Array<Record<string, unknown>>;

export const REVIEW_STATUSES = ['draft', 'in_progress', 'completed'] as const;

export const reviews = pgTable(
  'reviews',
  {
    id: pk(),
    kind: text('kind').$type<'weekly' | 'monthly'>().notNull(),
    periodStart: isoDate('period_start').notNull(),
    periodEnd: isoDate('period_end').notNull(),
    status: text('status').$type<(typeof REVIEW_STATUSES)[number]>().notNull().default('draft'),
    generatedBy: text('generated_by').notNull().default('deterministic'),
    whatChanged: jsonb('what_changed').$type<Json>().notNull().default(sql`'[]'::jsonb`),
    whyItMatters: jsonb('why_it_matters').$type<Json>().notNull().default(sql`'[]'::jsonb`),
    nextAction: jsonb('next_action').$type<Record<string, unknown>>(),
    checklist: jsonb('checklist').$type<Json>().notNull().default(sql`'[]'::jsonb`),
    notes: text('notes'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    completedAt: tstz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('reviews_kind_period_key').on(t.kind, t.periodStart),
    check('reviews_kind_check', inList('kind', ['weekly', 'monthly'])),
    check('reviews_status_check', inList('status', REVIEW_STATUSES)),
    check('reviews_completed_check', sql`status <> 'completed' OR completed_at IS NOT NULL`),
  ],
);

export const ACHIEVEMENT_KINDS = [
  'review_completed',
  'reconciled_account',
  'goal_contribution_verified',
  'verified_saving',
  'exceptions_cleared',
  'streak',
] as const;

/** Earned only from verified evidence. `dedupe_key` prevents awarding the same thing twice. */
export const achievements = pgTable(
  'achievements',
  {
    id: pk(),
    kind: text('kind').$type<(typeof ACHIEVEMENT_KINDS)[number]>().notNull(),
    title: text('title').notNull(),
    earnedAt: tstz('earned_at').notNull().defaultNow(),
    evidence: jsonb('evidence').$type<Json>().notNull().default(sql`'[]'::jsonb`),
    dedupeKey: text('dedupe_key').notNull().unique('achievements_dedupe_key_key'),
    createdAt: createdAt(),
  },
  () => [
    check('achievements_kind_check', inList('kind', ACHIEVEMENT_KINDS)),
    check('achievements_evidence_check', sql`jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) > 0`),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    kind: text('kind').notNull(),
    severity: text('severity').$type<'info' | 'warning' | 'critical'>().notNull().default('info'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    why: text('why').notNull(),
    href: text('href'),
    dedupeKey: text('dedupe_key').notNull().unique('notifications_dedupe_key_key'),
    deliveredChannels: text('delivered_channels').array().notNull().default(sql`'{}'::text[]`),
    readAt: tstz('read_at'),
    dismissedAt: tstz('dismissed_at'),
    expiresAt: tstz('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [
    check('notifications_severity_check', inList('severity', ['info', 'warning', 'critical'])),
    check('notifications_href_check', sql`href IS NULL OR href ~ '^/[^/]'`),
    index('notifications_unread_idx').on(t.readAt, t.createdAt),
  ],
);

export const schedules = pgTable('schedules', {
  id: pk(),
  key: text('key').notNull().unique('schedules_key_key'),
  label: text('label').notNull(),
  description: text('description').notNull().default(''),
  queue: text('queue').notNull(),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  enabled: boolean('enabled').notNull().default(true),
  payload: jsonObject('payload'),
  lastRunAt: tstz('last_run_at'),
  lastStatus: text('last_status'),
  nextRunAt: tstz('next_run_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
