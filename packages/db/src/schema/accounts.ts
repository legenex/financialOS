import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, isoDate, jsonObject, money, pk, provenance, rate, tstz, updatedAt } from './_columns';
import { connections } from './connections';
import { documents, importBatches } from './documents';
import { counterparties, entities, institutions, instruments } from './org';
import { currencies } from './reference';
import { sourceRecords } from './sources';

export const ACCOUNT_KINDS = [
  'current',
  'savings',
  'card',
  'credit_card',
  'brokerage',
  'crypto_wallet',
  'crypto_custodial',
  'private_investment',
  'restricted_equity',
  'pension',
  'property',
  'mortgage',
  'loan',
  'receivable',
  'clearing',
  'other',
] as const;
export type AccountKindValue = (typeof ACCOUNT_KINDS)[number];

export const LIQUIDITY_CLASSES = [
  'cash',
  'near_cash',
  'marketable',
  'restricted',
  'illiquid',
  'property',
  'liability',
  'receivable',
  'contingent',
] as const;
export type LiquidityClassValue = (typeof LIQUIDITY_CLASSES)[number];

export const ACCOUNT_CREATED_FROM = ['bootstrap', 'user', 'provider'] as const;
export type AccountCreatedFrom = (typeof ACCOUNT_CREATED_FROM)[number];

export const COMPLETENESS = ['complete', 'partial', 'unknown'] as const;
export type CompletenessValue = (typeof COMPLETENESS)[number];

/**
 * Financial accounts. Legal entity (who holds the account) and economic owner (whose money
 * it is) are separate and both nullable: NULL means unconfirmed, never "the owner".
 */
export const accounts = pgTable(
  'accounts',
  {
    id: pk(),
    name: text('name').notNull(),
    kind: text('kind').$type<AccountKindValue>().notNull(),
    currency: text('currency').references(() => currencies.code),
    institutionId: uuid('institution_id').references(() => institutions.id),
    legalEntityId: uuid('legal_entity_id').references(() => entities.id),
    economicOwnerEntityId: uuid('economic_owner_entity_id').references(() => entities.id),
    ownershipConfirmed: boolean('ownership_confirmed').notNull().default(false),
    liquidityClass: text('liquidity_class').$type<LiquidityClassValue>().notNull(),
    includeInSafeToSpend: boolean('include_in_safe_to_spend').notNull().default(false),
    status: text('status').$type<'active' | 'closed'>().notNull().default('active'),
    maskedIdentifier: text('masked_identifier'),
    notes: text('notes'),
    provenance: provenance(),
    createdFrom: text('created_from').$type<AccountCreatedFrom>().notNull(),
    connectionId: uuid('connection_id').references((): AnyPgColumn => connections.id, { onDelete: 'set null' }),
    openedOn: isoDate('opened_on'),
    closedOn: isoDate('closed_on'),
    bootstrapKey: text('bootstrap_key').unique('accounts_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('accounts_kind_check', inList('kind', ACCOUNT_KINDS)),
    check('accounts_liquidity_class_check', inList('liquidity_class', LIQUIDITY_CLASSES)),
    check('accounts_status_check', inList('status', ['active', 'closed'])),
    check('accounts_created_from_check', inList('created_from', ACCOUNT_CREATED_FROM)),
    check(
      'accounts_masked_identifier_check',
      sql`masked_identifier IS NULL OR (length(masked_identifier) <= 32 AND length(regexp_replace(masked_identifier, '[^0-9]', '', 'g')) <= 4)`,
    ),
    index('accounts_legal_entity_idx').on(t.legalEntityId),
    index('accounts_economic_owner_idx').on(t.economicOwnerEntityId),
    index('accounts_connection_idx').on(t.connectionId),
  ],
);

export const OWNERSHIP_RULE_MATCH_KINDS = ['card_last4', 'card_id', 'description_pattern', 'counterparty'] as const;

/** Card-level or pattern rules assigning the economic owner of individual transactions. */
export const accountOwnershipRules = pgTable(
  'account_ownership_rules',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    matchKind: text('match_kind').$type<(typeof OWNERSHIP_RULE_MATCH_KINDS)[number]>().notNull(),
    pattern: text('pattern').notNull(),
    economicOwnerEntityId: uuid('economic_owner_entity_id')
      .notNull()
      .references(() => entities.id),
    priority: integer('priority').notNull().default(100),
    active: boolean('active').notNull().default(true),
    notes: text('notes'),
    createdBy: text('created_by').notNull().default('owner'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('account_ownership_rules_match_kind_check', inList('match_kind', OWNERSHIP_RULE_MATCH_KINDS)),
    check('account_ownership_rules_last4_check', sql`match_kind <> 'card_last4' OR pattern ~ '^[0-9]{4}$'`),
    check(
      'account_ownership_rules_card_id_digits_check',
      sql`match_kind <> 'card_id' OR length(regexp_replace(pattern, '[^0-9]', '', 'g')) <= 4`,
    ),
    index('account_ownership_rules_account_idx').on(t.accountId),
  ],
);

export const SNAPSHOT_KINDS = [
  'owner_reported_total',
  'statement_opening',
  'statement_closing',
  'provider_current',
  'provider_available',
  'opening',
  'manual',
] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

/**
 * A reported balance at a point in time. `reported_at` (when we were told) and
 * `source_as_of` (the moment the source says the balance applied) are separate;
 * `source_as_of` stays NULL when unknown. A snapshot is never income.
 */
export const balanceSnapshots = pgTable(
  'balance_snapshots',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    kind: text('kind').$type<SnapshotKind>().notNull(),
    amount: money('amount').notNull(),
    currency: text('currency')
      .notNull()
      .references(() => currencies.code),
    reportedAt: tstz('reported_at').notNull(),
    sourceAsOf: tstz('source_as_of'),
    approximate: boolean('approximate').notNull().default(false),
    completeness: text('completeness').$type<CompletenessValue>().notNull().default('unknown'),
    composition: jsonb('composition').$type<Array<Record<string, unknown>>>(),
    source: text('source').notNull(),
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => balanceSnapshots.id),
    provenance: provenance(),
    documentId: uuid('document_id').references(() => documents.id),
    importBatchId: uuid('import_batch_id').references((): AnyPgColumn => importBatches.id),
    connectionId: uuid('connection_id').references((): AnyPgColumn => connections.id),
    bootstrapKey: text('bootstrap_key').unique('balance_snapshots_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('balance_snapshots_kind_check', inList('kind', SNAPSHOT_KINDS)),
    check('balance_snapshots_completeness_check', inList('completeness', COMPLETENESS)),
    check('balance_snapshots_not_self_superseded_check', sql`superseded_by IS NULL OR superseded_by <> id`),
    index('balance_snapshots_account_idx').on(t.accountId, t.reportedAt),
  ],
);

export const holdingsSnapshots = pgTable(
  'holdings_snapshots',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    reportedAt: tstz('reported_at').notNull(),
    sourceAsOf: tstz('source_as_of'),
    completeness: text('completeness').$type<CompletenessValue>().notNull().default('unknown'),
    source: text('source').notNull(),
    verified: boolean('verified').notNull().default(false),
    supersededBy: uuid('superseded_by').references((): AnyPgColumn => holdingsSnapshots.id),
    provenance: provenance(),
    documentId: uuid('document_id').references(() => documents.id),
    importBatchId: uuid('import_batch_id').references((): AnyPgColumn => importBatches.id),
    connectionId: uuid('connection_id').references((): AnyPgColumn => connections.id),
    bootstrapKey: text('bootstrap_key').unique('holdings_snapshots_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('holdings_snapshots_completeness_check', inList('completeness', COMPLETENESS)),
    index('holdings_snapshots_account_idx').on(t.accountId, t.reportedAt),
  ],
);

export const holdingLines = pgTable(
  'holding_lines',
  {
    id: pk(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => holdingsSnapshots.id, { onDelete: 'cascade' }),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    quantity: money('quantity'),
    price: money('price'),
    priceCurrency: text('price_currency'),
    priceAsOf: tstz('price_as_of'),
    priceSource: text('price_source'),
    priceKind: text('price_kind'),
    value: money('value'),
    valueCurrency: text('value_currency'),
    costBasis: money('cost_basis'),
    costBasisCurrency: text('cost_basis_currency'),
    costBasisComplete: boolean('cost_basis_complete').notNull().default(false),
    restricted: boolean('restricted').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('holding_lines_snapshot_idx').on(t.snapshotId),
    check('holding_lines_value_currency_check', sql`value IS NULL OR value_currency IS NOT NULL`),
  ],
);

export const INVESTMENT_TRANSACTION_KINDS = [
  'buy',
  'sell',
  'dividend',
  'interest',
  'fee',
  'tax',
  'deposit',
  'withdrawal',
  'transfer_in',
  'transfer_out',
  'split',
  'corporate_action',
  'other',
] as const;

export const investmentTransactions = pgTable(
  'investment_transactions',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    instrumentId: uuid('instrument_id').references(() => instruments.id),
    sourceRecordId: uuid('source_record_id').references((): AnyPgColumn => sourceRecords.id),
    kind: text('kind').$type<(typeof INVESTMENT_TRANSACTION_KINDS)[number]>().notNull(),
    tradeDate: isoDate('trade_date').notNull(),
    settleDate: isoDate('settle_date'),
    quantity: money('quantity'),
    price: money('price'),
    amount: money('amount'),
    currency: text('currency'),
    fees: money('fees'),
    feeCurrency: text('fee_currency'),
    externalId: text('external_id'),
    journalEntryId: uuid('journal_entry_id'),
    details: jsonObject('details'),
    createdAt: createdAt(),
  },
  (t) => [
    check('investment_transactions_kind_check', inList('kind', INVESTMENT_TRANSACTION_KINDS)),
    uniqueIndex('investment_transactions_external_key')
      .on(t.accountId, t.externalId)
      .where(sql`external_id IS NOT NULL`),
    index('investment_transactions_account_idx').on(t.accountId, t.tradeDate),
  ],
);

export const CORPORATE_ACTION_KINDS = [
  'split',
  'reverse_split',
  'dividend',
  'spinoff',
  'merger',
  'symbol_change',
  'listing_change',
  'other',
] as const;

export const corporateActions = pgTable(
  'corporate_actions',
  {
    id: pk(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    kind: text('kind').$type<(typeof CORPORATE_ACTION_KINDS)[number]>().notNull(),
    effectiveDate: isoDate('effective_date'),
    ratioFrom: money('ratio_from'),
    ratioTo: money('ratio_to'),
    status: text('status').$type<'announced' | 'unverified' | 'verified' | 'applied'>().notNull().default('unverified'),
    details: jsonObject('details'),
    source: text('source'),
    documentId: uuid('document_id').references(() => documents.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check('corporate_actions_kind_check', inList('kind', CORPORATE_ACTION_KINDS)),
    check('corporate_actions_status_check', inList('status', ['announced', 'unverified', 'verified', 'applied'])),
  ],
);

export const RESTRICTION_KINDS = ['volume_cap', 'lockup', 'vesting', 'transfer_restriction', 'other'] as const;
export const RESTRICTION_STATUSES = ['reported_unverified', 'verified', 'expired', 'rejected'] as const;

export const restrictions = pgTable(
  'restrictions',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    instrumentId: uuid('instrument_id').references(() => instruments.id),
    kind: text('kind').$type<(typeof RESTRICTION_KINDS)[number]>().notNull(),
    status: text('status').$type<(typeof RESTRICTION_STATUSES)[number]>().notNull().default('reported_unverified'),
    terms: jsonObject('terms'),
    effectiveFrom: isoDate('effective_from'),
    effectiveTo: isoDate('effective_to'),
    documentId: uuid('document_id').references(() => documents.id),
    notes: text('notes'),
    verifiedAt: tstz('verified_at'),
    provenance: provenance(),
    bootstrapKey: text('bootstrap_key').unique('restrictions_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('restrictions_kind_check', inList('kind', RESTRICTION_KINDS)),
    check('restrictions_status_check', inList('status', RESTRICTION_STATUSES)),
    check('restrictions_verified_at_check', sql`status <> 'verified' OR verified_at IS NOT NULL`),
    index('restrictions_account_idx').on(t.accountId),
  ],
);

export const WATCH_EVENT_STATUSES = ['unverified', 'verified', 'occurred', 'dismissed'] as const;

/** Events to verify (possible listings, releases). Never treated as facts. */
export const watchEvents = pgTable(
  'watch_events',
  {
    id: pk(),
    instrumentId: uuid('instrument_id').references(() => instruments.id),
    accountId: uuid('account_id').references(() => accounts.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    status: text('status').$type<(typeof WATCH_EVENT_STATUSES)[number]>().notNull().default('unverified'),
    expectedDate: isoDate('expected_date'),
    notes: text('notes'),
    sourceUrl: text('source_url'),
    provenance: provenance(),
    bootstrapKey: text('bootstrap_key').unique('watch_events_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [check('watch_events_status_check', inList('status', WATCH_EVENT_STATUSES))],
);

export const RATE_BASES = ['nominal', 'effective', 'unverified'] as const;
export const COMPOUNDING = ['monthly', 'quarterly', 'annually', 'daily', 'simple', 'unknown'] as const;

export const fixedIncomeTerms = pgTable(
  'fixed_income_terms',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .unique('fixed_income_terms_account_key')
      .references(() => accounts.id),
    principal: money('principal'),
    currency: text('currency'),
    statedAnnualRate: rate('stated_annual_rate'),
    rateBasis: text('rate_basis').$type<(typeof RATE_BASES)[number]>().notNull().default('unverified'),
    compounding: text('compounding').$type<(typeof COMPOUNDING)[number]>().notNull().default('unknown'),
    fees: text('fees'),
    withdrawalTerms: text('withdrawal_terms'),
    counterpartyId: uuid('counterparty_id').references(() => counterparties.id),
    counterpartyName: text('counterparty_name'),
    startDate: isoDate('start_date'),
    maturityDate: isoDate('maturity_date'),
    verified: boolean('verified').notNull().default(false),
    notes: text('notes'),
    documentId: uuid('document_id').references(() => documents.id),
    provenance: provenance(),
    bootstrapKey: text('bootstrap_key').unique('fixed_income_terms_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check('fixed_income_terms_rate_basis_check', inList('rate_basis', RATE_BASES)),
    check('fixed_income_terms_compounding_check', inList('compounding', COMPOUNDING)),
    check('fixed_income_terms_verified_basis_check', sql`NOT verified OR rate_basis <> 'unverified'`),
  ],
);

export const liabilityTerms = pgTable(
  'liability_terms',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .unique('liability_terms_account_key')
      .references(() => accounts.id),
    principal: money('principal'),
    currency: text('currency'),
    interestRate: rate('interest_rate'),
    rateBasis: text('rate_basis').$type<(typeof RATE_BASES)[number]>().notNull().default('unverified'),
    rateType: text('rate_type').$type<'fixed' | 'variable' | 'unknown'>().notNull().default('unknown'),
    paymentAmount: money('payment_amount'),
    paymentCadence: text('payment_cadence'),
    termMonths: integer('term_months'),
    creditLimit: money('credit_limit'),
    startDate: isoDate('start_date'),
    maturityDate: isoDate('maturity_date'),
    lenderCounterpartyId: uuid('lender_counterparty_id').references(() => counterparties.id),
    securedByAccountId: uuid('secured_by_account_id').references((): AnyPgColumn => accounts.id),
    verified: boolean('verified').notNull().default(false),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check('liability_terms_rate_basis_check', inList('rate_basis', RATE_BASES)),
    check('liability_terms_rate_type_check', inList('rate_type', ['fixed', 'variable', 'unknown'])),
  ],
);

export const propertyDetails = pgTable(
  'property_details',
  {
    id: pk(),
    accountId: uuid('account_id')
      .notNull()
      .unique('property_details_account_key')
      .references(() => accounts.id),
    label: text('label'),
    country: text('country'),
    purchaseDate: isoDate('purchase_date'),
    purchasePrice: money('purchase_price'),
    purchaseCurrency: text('purchase_currency'),
    valuation: money('valuation'),
    valuationCurrency: text('valuation_currency'),
    valuationAsOf: isoDate('valuation_as_of'),
    valuationSource: text('valuation_source'),
    ownershipShare: rate('ownership_share'),
    mortgageAccountId: uuid('mortgage_account_id').references((): AnyPgColumn => accounts.id),
    verified: boolean('verified').notNull().default(false),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check('property_details_share_check', sql`ownership_share IS NULL OR (ownership_share > 0 AND ownership_share <= 1)`),
  ],
);
