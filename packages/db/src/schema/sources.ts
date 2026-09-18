import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, isoDate, jsonObject, money, pk, provenance, rate, tstz, updatedAt } from './_columns';
import { accounts } from './accounts';
import { connections } from './connections';
import { documents, importBatches } from './documents';
import { counterparties, entities } from './org';
import { currencies } from './reference';

export const SOURCE_RECORD_KINDS = ['transaction', 'balance', 'holding', 'investment_transaction', 'other'] as const;
export const SOURCE_ORIGINS = ['import', 'provider_api', 'manual'] as const;
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

/**
 * Immutable raw rows from imports and provider APIs. Only `last_seen_at`,
 * `superseded_by`, and `deleted_upstream_at` may change after insert (trigger).
 */
export const sourceRecords = pgTable(
  'source_records',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .references((): AnyPgColumn => accounts.id),
    origin: text('origin').$type<SourceOrigin>().notNull(),
    recordKind: text('record_kind').$type<(typeof SOURCE_RECORD_KINDS)[number]>().notNull().default('transaction'),
    connectionId: uuid('connection_id').references((): AnyPgColumn => connections.id),
    importBatchId: uuid('import_batch_id').references((): AnyPgColumn => importBatches.id),
    documentId: uuid('document_id').references((): AnyPgColumn => documents.id),
    /** Stable upstream identifier (provider transaction id, FITID) when one exists. */
    providerId: text('provider_id'),
    dedupeKey: text('dedupe_key').notNull(),
    contentHash: text('content_hash').notNull(),
    upstreamVersion: integer('upstream_version').notNull().default(1),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
    bookedOn: isoDate('booked_on'),
    valueOn: isoDate('value_on'),
    sourceTimezone: text('source_timezone'),
    amount: money('amount'),
    currency: text('currency').references(() => currencies.code),
    description: text('description'),
    counterpartyName: text('counterparty_name'),
    reference: text('reference'),
    balanceAfter: money('balance_after'),
    pending: boolean('pending').notNull().default(false),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => sourceRecords.id),
    deletedUpstreamAt: tstz('deleted_upstream_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('source_records_account_dedupe_key').on(t.accountId, t.dedupeKey),
    check('source_records_origin_check', inList('origin', SOURCE_ORIGINS)),
    check('source_records_kind_check', inList('record_kind', SOURCE_RECORD_KINDS)),
    check('source_records_amount_currency_check', sql`amount IS NULL OR currency IS NOT NULL`),
    check('source_records_not_self_superseded_check', sql`superseded_by IS NULL OR superseded_by <> id`),
    index('source_records_account_booked_idx').on(t.accountId, t.bookedOn),
    index('source_records_provider_idx').on(t.accountId, t.providerId),
    index('source_records_batch_idx').on(t.importBatchId),
    index('source_records_content_hash_idx').on(t.accountId, t.contentHash),
  ],
);

export const TRANSACTION_NATURES = [
  'consumption',
  'income',
  'salary',
  'transfer_internal',
  'transfer_external',
  'intercompany',
  'owner_contribution',
  'owner_drawing',
  'business_support',
  'third_party',
  'investment_contribution',
  'investment_withdrawal',
  'investment_trade',
  'property_purchase',
  'loan_repayment',
  'fee',
  'interest',
  'dividend',
  'refund',
  'tax',
  'payroll',
  'fx_conversion',
  'unknown',
] as const;
export type TransactionNatureValue = (typeof TRANSACTION_NATURES)[number];

export const CONFIDENCE = ['high', 'medium', 'low', 'none'] as const;
export type ConfidenceValue = (typeof CONFIDENCE)[number];

export const CLASSIFICATION_METHODS = ['rule', 'user', 'model', 'provider', 'transfer_match', 'bootstrap', 'none'] as const;
export type ClassificationMethod = (typeof CLASSIFICATION_METHODS)[number];

export const CATEGORY_KINDS = ['expense', 'income', 'transfer', 'other'] as const;

export const categories = pgTable(
  'categories',
  {
    id: pk(),
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id),
    name: text('name').notNull(),
    kind: text('kind').$type<(typeof CATEGORY_KINDS)[number]>().notNull(),
    essential: boolean('essential').notNull().default(false),
    system: boolean('system').notNull().default(false),
    seedKey: text('seed_key').unique('categories_seed_key_key'),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('categories_kind_check', inList('kind', CATEGORY_KINDS)),
    unique('categories_parent_name_key').on(t.parentId, t.name).nullsNotDistinct(),
  ],
);

export const rules = pgTable(
  'rules',
  {
    id: pk(),
    name: text('name').notNull(),
    priority: integer('priority').notNull().default(100),
    active: boolean('active').notNull().default(true),
    /** Declarative conditions (description/counterparty patterns, account ids, amount range, currency). */
    match: jsonb('match').$type<Record<string, unknown>>().notNull(),
    /** Declarative outcome (category, nature, economic owner, tags). */
    action: jsonb('action').$type<Record<string, unknown>>().notNull(),
    entityId: uuid('entity_id').references(() => entities.id),
    accountId: uuid('account_id').references((): AnyPgColumn => accounts.id),
    createdFrom: text('created_from').notNull().default('user'),
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: tstz('last_hit_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('rules_active_priority_idx').on(t.active, t.priority)],
);

export const TRANSFER_MATCH_STATUSES = ['suggested', 'confirmed', 'rejected'] as const;

export const transferMatches = pgTable(
  'transfer_matches',
  {
    id: pk(),
    fromSourceRecordId: uuid('from_source_record_id')
      .notNull()
      .references(() => sourceRecords.id),
    toSourceRecordId: uuid('to_source_record_id')
      .notNull()
      .references(() => sourceRecords.id),
    confidence: text('confidence').$type<ConfidenceValue>().notNull(),
    score: rate('score'),
    explanation: jsonObject('explanation'),
    status: text('status').$type<(typeof TRANSFER_MATCH_STATUSES)[number]>().notNull().default('suggested'),
    fxRate: rate('fx_rate'),
    feeAmount: money('fee_amount'),
    feeCurrency: text('fee_currency'),
    decidedAt: tstz('decided_at'),
    decidedBy: text('decided_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('transfer_matches_pair_key').on(t.fromSourceRecordId, t.toSourceRecordId),
    check('transfer_matches_distinct_check', sql`from_source_record_id <> to_source_record_id`),
    check('transfer_matches_confidence_check', inList('confidence', CONFIDENCE)),
    check('transfer_matches_status_check', inList('status', TRANSFER_MATCH_STATUSES)),
    index('transfer_matches_to_idx').on(t.toSourceRecordId),
  ],
);

/**
 * Versioned classification of a source record. Exactly one current version per record.
 */
export const classifications = pgTable(
  'classifications',
  {
    id: pk(),
    sourceRecordId: uuid('source_record_id')
      .notNull()
      .references(() => sourceRecords.id),
    version: integer('version').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    nature: text('nature').$type<TransactionNatureValue>().notNull(),
    categoryId: uuid('category_id').references(() => categories.id),
    economicOwnerEntityId: uuid('economic_owner_entity_id').references(() => entities.id),
    counterpartyId: uuid('counterparty_id').references(() => counterparties.id),
    splits: jsonb('splits').$type<Array<Record<string, unknown>>>(),
    confidence: text('confidence').$type<ConfidenceValue>().notNull().default('none'),
    method: text('method').$type<ClassificationMethod>().notNull(),
    ruleId: uuid('rule_id').references(() => rules.id),
    transferMatchId: uuid('transfer_match_id').references(() => transferMatches.id),
    needsReview: boolean('needs_review').notNull().default(false),
    note: text('note'),
    createdBy: text('created_by').notNull().default('system'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('classifications_record_version_key').on(t.sourceRecordId, t.version),
    uniqueIndex('classifications_one_current').on(t.sourceRecordId).where(sql`is_current`),
    check('classifications_version_check', sql`version >= 1`),
    check('classifications_nature_check', inList('nature', TRANSACTION_NATURES)),
    check('classifications_confidence_check', inList('confidence', CONFIDENCE)),
    check('classifications_method_check', inList('method', CLASSIFICATION_METHODS)),
    index('classifications_category_idx').on(t.categoryId),
  ],
);

export const THIRD_PARTY_FEE_MODES = ['deducted_from_receipt', 'charged_on_top', 'unconfirmed'] as const;
export type ThirdPartyFeeModeValue = (typeof THIRD_PARTY_FEE_MODES)[number];

/**
 * Money held on behalf of a third party. Until the fee mode is confirmed, no fee income
 * is recognised.
 */
export const thirdPartyArrangements = pgTable(
  'third_party_arrangements',
  {
    id: pk(),
    thirdPartyEntityId: uuid('third_party_entity_id')
      .notNull()
      .references(() => entities.id),
    currency: text('currency').references(() => currencies.code),
    feeRate: rate('fee_rate'),
    feeMode: text('fee_mode').$type<ThirdPartyFeeModeValue>().notNull().default('unconfirmed'),
    feeModeConfirmed: boolean('fee_mode_confirmed').notNull().default(false),
    feeRecipientEntityId: uuid('fee_recipient_entity_id').references(() => entities.id),
    openingBalance: money('opening_balance'),
    openingBalanceAsOf: isoDate('opening_balance_as_of'),
    holdingEntityIds: uuid('holding_entity_ids').array().notNull().default(sql`'{}'::uuid[]`),
    clearingAccountIds: uuid('clearing_account_ids').array().notNull().default(sql`'{}'::uuid[]`),
    economicallyOwnedAccountIds: uuid('economically_owned_account_ids').array().notNull().default(sql`'{}'::uuid[]`),
    evidenceNote: text('evidence_note'),
    notes: text('notes'),
    status: text('status').$type<'active' | 'ended'>().notNull().default('active'),
    provenance: provenance(),
    bootstrapKey: text('bootstrap_key').unique('third_party_arrangements_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check('third_party_arrangements_fee_mode_check', inList('fee_mode', THIRD_PARTY_FEE_MODES)),
    check(
      'third_party_arrangements_confirmed_mode_check',
      sql`NOT fee_mode_confirmed OR fee_mode <> 'unconfirmed'`,
    ),
    check('third_party_arrangements_fee_rate_check', sql`fee_rate IS NULL OR (fee_rate >= 0 AND fee_rate < 1)`),
    check('third_party_arrangements_status_check', inList('status', ['active', 'ended'])),
  ],
);

export const tags = pgTable('tags', {
  id: pk(),
  name: text('name').notNull().unique('tags_name_key'),
  color: text('color'),
  createdAt: createdAt(),
});

/** Tags attached to source records (kept outside the immutable record). */
export const sourceRecordTags = pgTable(
  'source_record_tags',
  {
    sourceRecordId: uuid('source_record_id')
      .notNull()
      .references(() => sourceRecords.id),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ name: 'source_record_tags_pkey', columns: [t.sourceRecordId, t.tagId] })],
);
