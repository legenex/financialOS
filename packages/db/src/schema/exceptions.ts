import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, jsonObject, pk, tstz, updatedAt } from './_columns';
import { entities } from './org';

export const EXCEPTION_KINDS = [
  'unclassified',
  'ownership_uncertain',
  'fee_policy_unconfirmed',
  'reconciliation_discrepancy',
  'reconciliation_question',
  'missing_period',
  'possible_duplicate',
  'transfer_match_review',
  'stale_connection',
  'sync_error',
  'valuation_unverified',
  'restriction_unverified',
  'interest_unverified',
  'missing_information',
  'tax_fact_unconfirmed',
  'fx_rate_missing',
  'import_error',
  'unusual_transaction',
  'agent_suggestion',
] as const;
export type ExceptionKindValue = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

export const EXCEPTION_STATUSES = ['open', 'resolved', 'dismissed', 'snoozed'] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

/**
 * The single exception inbox. `dedupe_key` makes raising the same exception idempotent.
 * `body` is the human-readable explanation; `detail` holds structured data.
 */
export const exceptions = pgTable(
  'exceptions',
  {
    id: pk(),
    dedupeKey: text('dedupe_key').notNull().unique('exceptions_dedupe_key_key'),
    kind: text('kind').$type<ExceptionKindValue>().notNull(),
    severity: text('severity').$type<ExceptionSeverity>().notNull().default('warning'),
    status: text('status').$type<ExceptionStatus>().notNull().default('open'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id'),
    subjectLabel: text('subject_label'),
    entityId: uuid('entity_id').references(() => entities.id),
    detail: jsonObject('detail'),
    suggestedActions: jsonb('suggested_actions')
      .$type<Array<{ id: string; label: string; href: string | null }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    source: text('source').notNull().default('system'),
    occurrences: integer('occurrences').notNull().default(1),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    snoozedUntil: tstz('snoozed_until'),
    resolution: text('resolution'),
    resolvedAt: tstz('resolved_at'),
    resolvedBy: text('resolved_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('exceptions_kind_check', inList('kind', EXCEPTION_KINDS)),
    check('exceptions_severity_check', inList('severity', EXCEPTION_SEVERITIES)),
    check('exceptions_status_check', inList('status', EXCEPTION_STATUSES)),
    check('exceptions_snooze_check', sql`status <> 'snoozed' OR snoozed_until IS NOT NULL`),
    index('exceptions_status_kind_idx').on(t.status, t.kind),
    index('exceptions_subject_idx').on(t.subjectType, t.subjectId),
  ],
);
