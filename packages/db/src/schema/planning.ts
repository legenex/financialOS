import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, isoDate, money, pk, provenance, rate, tstz, updatedAt } from './_columns';
import { accounts } from './accounts';
import { documents } from './documents';
import { counterparties, entities } from './org';
import { categories, sourceRecords } from './sources';

export const BUDGET_LINE_KINDS = ['spending', 'envelope', 'sinking_fund', 'fixed'] as const;

export const budgets = pgTable(
  'budgets',
  {
    id: pk(),
    name: text('name').notNull(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    currency: text('currency').notNull(),
    periodKind: text('period_kind').$type<'monthly' | 'weekly' | 'custom'>().notNull().default('monthly'),
    /** NULL period bounds mean the budget repeats every period from `starts_on`. */
    periodStart: isoDate('period_start'),
    periodEnd: isoDate('period_end'),
    startsOn: isoDate('starts_on'),
    status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('budgets_period_kind_check', inList('period_kind', ['monthly', 'weekly', 'custom'])),
    check('budgets_status_check', inList('status', ['active', 'archived'])),
    check('budgets_period_check', sql`period_end IS NULL OR period_start IS NULL OR period_end >= period_start`),
    index('budgets_entity_idx').on(t.entityId),
  ],
);

export const budgetLines = pgTable(
  'budget_lines',
  {
    id: pk(),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    kind: text('kind').$type<(typeof BUDGET_LINE_KINDS)[number]>().notNull(),
    planned: money('planned').notNull(),
    rollover: boolean('rollover').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('budget_lines_budget_category_key').on(t.budgetId, t.categoryId),
    check('budget_lines_kind_check', inList('kind', BUDGET_LINE_KINDS)),
    check('budget_lines_planned_check', sql`planned >= 0`),
  ],
);

export const GOAL_KINDS = [
  'emergency_reserve',
  'reserve',
  'travel',
  'sinking_fund',
  'purchase',
  'annual_bill',
  'debt_payoff',
  'other',
] as const;
export const GOAL_HELD_IN = ['eligible_cash_accounts', 'separate_accounts', 'not_yet_funded'] as const;
export const GOAL_STATUSES = ['active', 'paused', 'achieved', 'archived'] as const;

export const goals = pgTable(
  'goals',
  {
    id: pk(),
    name: text('name').notNull(),
    kind: text('kind').$type<(typeof GOAL_KINDS)[number]>().notNull(),
    entityId: uuid('entity_id').references(() => entities.id),
    targetAmount: money('target_amount').notNull(),
    targetCurrency: text('target_currency').notNull(),
    targetDate: isoDate('target_date'),
    protected: boolean('protected').notNull().default(false),
    heldIn: text('held_in').$type<(typeof GOAL_HELD_IN)[number]>().notNull().default('not_yet_funded'),
    linkedAccountIds: uuid('linked_account_ids').array().notNull().default(sql`'{}'::uuid[]`),
    status: text('status').$type<(typeof GOAL_STATUSES)[number]>().notNull().default('active'),
    priority: integer('priority').notNull().default(50),
    travel: jsonb('travel').$type<{ destination: string | null; routePreference: string | null; departOn: string | null }>(),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check('goals_kind_check', inList('kind', GOAL_KINDS)),
    check('goals_held_in_check', inList('held_in', GOAL_HELD_IN)),
    check('goals_status_check', inList('status', GOAL_STATUSES)),
    check('goals_target_check', sql`target_amount > 0`),
    check('goals_priority_check', sql`priority BETWEEN 0 AND 100`),
  ],
);

export const goalContributions = pgTable(
  'goal_contributions',
  {
    id: pk(),
    goalId: uuid('goal_id')
      .notNull()
      .references(() => goals.id),
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    contributedOn: isoDate('contributed_on').notNull(),
    status: text('status').$type<'planned' | 'verified'>().notNull(),
    sourceRecordId: uuid('source_record_id').references((): AnyPgColumn => sourceRecords.id),
    note: text('note'),
    verifiedAt: tstz('verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('goal_contributions_status_check', inList('status', ['planned', 'verified'])),
    check(
      'goal_contributions_verified_evidence_check',
      sql`status <> 'verified' OR (source_record_id IS NOT NULL AND verified_at IS NOT NULL)`,
    ),
    index('goal_contributions_goal_idx').on(t.goalId),
  ],
);

export const RECURRING_KINDS = [
  'bill',
  'subscription',
  'salary',
  'income',
  'transfer',
  'loan_payment',
  'payroll',
  'overhead',
  'software',
  'insurance',
  'annual_bill',
  'intercompany_income',
  'intercompany_expense',
  'other',
] as const;
export type RecurringKind = (typeof RECURRING_KINDS)[number];
export const CADENCES = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'irregular', 'unknown'] as const;
export type CadenceValue = (typeof CADENCES)[number];
export const RECURRING_STATUSES = ['active', 'paused', 'cancelled', 'suggested'] as const;

export const recurringItems = pgTable(
  'recurring_items',
  {
    id: pk(),
    name: text('name').notNull(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id),
    counterpartyId: uuid('counterparty_id').references(() => counterparties.id),
    counterpartyName: text('counterparty_name'),
    kind: text('kind').$type<RecurringKind>().notNull(),
    direction: text('direction').$type<'in' | 'out'>().notNull(),
    /** Unknown amounts stay NULL. */
    amount: money('amount'),
    currency: text('currency'),
    amountIsEstimate: boolean('amount_is_estimate').notNull().default(false),
    cadence: text('cadence').$type<CadenceValue>().notNull().default('unknown'),
    dayOfMonth: integer('day_of_month'),
    nextDueOn: isoDate('next_due_on'),
    status: text('status').$type<(typeof RECURRING_STATUSES)[number]>().notNull().default('active'),
    detected: boolean('detected').notNull().default(false),
    confirmed: boolean('confirmed').notNull().default(false),
    internalCounterpartyEntityId: uuid('internal_counterparty_entity_id').references(() => entities.id),
    lastSeenOn: isoDate('last_seen_on'),
    detection: jsonb('detection').$type<Record<string, unknown>>(),
    provenance: provenance(),
    bootstrapKey: text('bootstrap_key').unique('recurring_items_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('recurring_items_kind_check', inList('kind', RECURRING_KINDS)),
    check('recurring_items_direction_check', inList('direction', ['in', 'out'])),
    check('recurring_items_cadence_check', inList('cadence', CADENCES)),
    check('recurring_items_status_check', inList('status', RECURRING_STATUSES)),
    check('recurring_items_day_check', sql`day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31`),
    check('recurring_items_amount_currency_check', sql`amount IS NULL OR currency IS NOT NULL`),
    index('recurring_items_entity_idx').on(t.entityId, t.status),
  ],
);

export const OBLIGATION_KINDS = ['bill', 'tax', 'purchase', 'loan', 'transfer', 'other'] as const;
export const OBLIGATION_STATUSES = ['upcoming', 'paid', 'cancelled'] as const;

export const obligations = pgTable(
  'obligations',
  {
    id: pk(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    dueOn: isoDate('due_on').notNull(),
    amount: money('amount'),
    currency: text('currency'),
    label: text('label').notNull(),
    kind: text('kind').$type<(typeof OBLIGATION_KINDS)[number]>().notNull(),
    status: text('status').$type<(typeof OBLIGATION_STATUSES)[number]>().notNull().default('upcoming'),
    recurringItemId: uuid('recurring_item_id').references(() => recurringItems.id),
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('obligations_kind_check', inList('kind', OBLIGATION_KINDS)),
    check('obligations_status_check', inList('status', OBLIGATION_STATUSES)),
    check('obligations_amount_currency_check', sql`amount IS NULL OR currency IS NOT NULL`),
    index('obligations_entity_due_idx').on(t.entityId, t.dueOn),
  ],
);

export const RP_STATUSES = ['open', 'partial', 'paid', 'written_off', 'cancelled'] as const;
export const RP_CATEGORIES = [
  'sales',
  'payroll',
  'software',
  'overhead',
  'refund',
  'tax',
  'intercompany',
  'owner',
  'other',
] as const;

export const receivablesPayables = pgTable(
  'receivables_payables',
  {
    id: pk(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    kind: text('kind').$type<'receivable' | 'payable'>().notNull(),
    counterpartyName: text('counterparty_name').notNull(),
    counterpartyId: uuid('counterparty_id').references(() => counterparties.id),
    intercompanyEntityId: uuid('intercompany_entity_id').references(() => entities.id),
    reference: text('reference'),
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    outstanding: money('outstanding').notNull(),
    issuedOn: isoDate('issued_on'),
    dueOn: isoDate('due_on'),
    expectedOn: isoDate('expected_on'),
    probability: rate('probability').notNull().default('1'),
    status: text('status').$type<(typeof RP_STATUSES)[number]>().notNull().default('open'),
    source: text('source').$type<'manual' | 'import'>().notNull().default('manual'),
    category: text('category').$type<(typeof RP_CATEGORIES)[number]>().notNull().default('other'),
    documentId: uuid('document_id').references(() => documents.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('receivables_payables_kind_check', inList('kind', ['receivable', 'payable'])),
    check('receivables_payables_status_check', inList('status', RP_STATUSES)),
    check('receivables_payables_source_check', inList('source', ['manual', 'import'])),
    check('receivables_payables_category_check', inList('category', RP_CATEGORIES)),
    check('receivables_payables_probability_check', sql`probability >= 0 AND probability <= 1`),
    check('receivables_payables_intercompany_check', sql`intercompany_entity_id IS NULL OR intercompany_entity_id <> entity_id`),
    index('receivables_payables_entity_idx').on(t.entityId, t.status),
  ],
);

/** Scenario identity. Content lives in versioned rows; updates insert a new version. */
export const scenarios = pgTable('scenarios', {
  id: pk(),
  currentVersion: integer('current_version').notNull().default(1),
  archived: boolean('archived').notNull().default(false),
  archivedAt: tstz('archived_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const scenarioVersions = pgTable(
  'scenario_versions',
  {
    id: pk(),
    scenarioId: uuid('scenario_id')
      .notNull()
      .references(() => scenarios.id),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    adjustments: jsonb('adjustments').$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
    createdBy: text('created_by').notNull().default('owner'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('scenario_versions_scenario_version_key').on(t.scenarioId, t.version),
    check('scenario_versions_version_check', sql`version >= 1`),
  ],
);

export const rewardProducts = pgTable(
  'reward_products',
  {
    id: pk(),
    name: text('name').notNull(),
    issuer: text('issuer').notNull(),
    termsAsOf: isoDate('terms_as_of').notNull(),
    sourceUrl: text('source_url'),
    eligibility: text('eligibility'),
    annualFee: money('annual_fee'),
    annualFeeCurrency: text('annual_fee_currency'),
    earnRate: rate('earn_rate'),
    earnUnit: text('earn_unit').$type<'cashback_percent' | 'points_per_currency_unit'>().notNull(),
    pointValue: money('point_value'),
    pointValueCurrency: text('point_value_currency'),
    fxFeePercent: rate('fx_fee_percent'),
    paymentFeePercent: rate('payment_fee_percent'),
    notes: text('notes'),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [check('reward_products_earn_unit_check', inList('earn_unit', ['cashback_percent', 'points_per_currency_unit']))],
);

export const travelPreferences = pgTable('travel_preferences', {
  id: pk(),
  label: text('label').notNull().default('default'),
  homeAirports: text('home_airports').array().notNull().default(sql`'{}'::text[]`),
  preferredAirlines: text('preferred_airlines').array().notNull().default(sql`'{}'::text[]`),
  cabinClass: text('cabin_class'),
  /** Programme names only; membership numbers are never stored. */
  loyaltyPrograms: text('loyalty_programs').array().notNull().default(sql`'{}'::text[]`),
  routePreferences: text('route_preferences'),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const TAX_TOPICS = [
  'residency',
  'filing_status',
  'deadline',
  'registration',
  'third_party_funds',
  'document',
  'other',
] as const;
export const TAX_FACT_STATUSES = ['unconfirmed', 'confirmed', 'needs_accountant'] as const;

export const taxFacts = pgTable(
  'tax_facts',
  {
    id: pk(),
    jurisdiction: text('jurisdiction').notNull(),
    topic: text('topic').$type<(typeof TAX_TOPICS)[number]>().notNull(),
    status: text('status').$type<(typeof TAX_FACT_STATUSES)[number]>().notNull().default('unconfirmed'),
    value: text('value'),
    deadline: text('deadline'),
    accountantQuestion: text('accountant_question'),
    documentIds: uuid('document_ids').array().notNull().default(sql`'{}'::uuid[]`),
    bootstrapKey: text('bootstrap_key').unique('tax_facts_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check('tax_facts_topic_check', inList('topic', TAX_TOPICS)),
    check('tax_facts_status_check', inList('status', TAX_FACT_STATUSES)),
  ],
);
