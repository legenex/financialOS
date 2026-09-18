import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, money, pk, tstz, updatedAt } from './_columns';

export const AI_TASKS = ['coach_chat', 'summaries', 'classification_suggestions', 'review_drafts'] as const;

export const aiProviders = pgTable(
  'ai_providers',
  {
    id: pk(),
    name: text('name').notNull(),
    kind: text('kind').$type<'openai_compatible' | 'anthropic'>().notNull(),
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    locality: text('locality').$type<'local' | 'cloud'>().notNull(),
    enabled: boolean('enabled').notNull().default(false),
    allowIdentifiableData: boolean('allow_identifiable_data').notNull().default(false),
    monthlyBudgetUsd: money('monthly_budget_usd'),
    taskRouting: text('task_routing').array().notNull().default(sql`'{}'::text[]`),
    isOrchestrator: boolean('is_orchestrator').notNull().default(false),
    lastTestAt: tstz('last_test_at'),
    lastTestOk: boolean('last_test_ok'),
    lastTestDetail: text('last_test_detail'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('ai_providers_kind_check', inList('kind', ['openai_compatible', 'anthropic'])),
    check('ai_providers_locality_check', inList('locality', ['local', 'cloud'])),
    uniqueIndex('ai_providers_one_orchestrator').on(t.isOrchestrator).where(sql`is_orchestrator`),
  ],
);

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: pk(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => aiProviders.id),
    task: text('task').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: money('cost_usd'),
    status: text('status').$type<'ok' | 'error' | 'cancelled'>().notNull().default('ok'),
    requestId: text('request_id'),
    jobId: uuid('job_id'),
    occurredAt: tstz('occurred_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    check('ai_usage_status_check', inList('status', ['ok', 'error', 'cancelled'])),
    index('ai_usage_provider_time_idx').on(t.providerId, t.occurredAt),
  ],
);

export const coachThreads = pgTable('coach_threads', {
  id: pk(),
  title: text('title').notNull(),
  archivedAt: tstz('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const COACH_MESSAGE_STATUSES = ['complete', 'streaming', 'cancelled', 'failed'] as const;

export const coachMessages = pgTable(
  'coach_messages',
  {
    id: pk(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => coachThreads.id),
    role: text('role').$type<'owner' | 'coach'>().notNull(),
    content: text('content').notNull().default(''),
    generatedBy: text('generated_by').notNull(),
    providerId: uuid('provider_id').references(() => aiProviders.id),
    links: jsonb('links').$type<Array<{ kind: string; id: string; label: string }>>().notNull().default(sql`'[]'::jsonb`),
    status: text('status').$type<(typeof COACH_MESSAGE_STATUSES)[number]>().notNull().default('complete'),
    cancelRequestedAt: tstz('cancel_requested_at'),
    error: text('error'),
    completedAt: tstz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('coach_messages_role_check', inList('role', ['owner', 'coach'])),
    check('coach_messages_status_check', inList('status', COACH_MESSAGE_STATUSES)),
    index('coach_messages_thread_idx').on(t.threadId, t.createdAt),
  ],
);
