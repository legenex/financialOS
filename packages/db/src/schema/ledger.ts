import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, isoDate, jsonObject, money, pk, rate, tstz, updatedAt } from './_columns';
import { accounts } from './accounts';
import { importBatches } from './documents';
import { counterparties, entities } from './org';
import { currencies } from './reference';
import { categories, sourceRecords, thirdPartyArrangements } from './sources';

export const LEDGER_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

export const LEDGER_ACCOUNT_SUBTYPES = [
  'bank',
  'investment',
  'receivable',
  'payable',
  'opening_balance_equity',
  'fx_clearing',
  'third_party_clearing',
  'intercompany_due_to',
  'intercompany_due_from',
  'suspense',
  'owner_equity',
  'income',
  'expense',
  'fee_income',
  'other',
] as const;
export type LedgerAccountSubtype = (typeof LEDGER_ACCOUNT_SUBTYPES)[number];

/** Per-entity chart of accounts. */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: pk(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type').$type<LedgerAccountType>().notNull(),
    subtype: text('subtype').$type<LedgerAccountSubtype>().notNull(),
    /** NULL means the ledger account may carry several currencies (clearing, suspense). */
    currency: text('currency').references(() => currencies.code),
    accountId: uuid('account_id').references(() => accounts.id),
    counterpartyEntityId: uuid('counterparty_entity_id').references(() => entities.id),
    arrangementId: uuid('arrangement_id').references((): AnyPgColumn => thirdPartyArrangements.id),
    categoryId: uuid('category_id').references((): AnyPgColumn => categories.id),
    system: boolean('system').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('ledger_accounts_entity_code_key').on(t.entityId, t.code),
    check('ledger_accounts_type_check', inList('type', LEDGER_ACCOUNT_TYPES)),
    check('ledger_accounts_subtype_check', inList('subtype', LEDGER_ACCOUNT_SUBTYPES)),
    index('ledger_accounts_account_idx').on(t.accountId),
  ],
);

export const JOURNAL_STATUSES = ['draft', 'posted', 'reversed'] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

export const JOURNAL_KINDS = [
  'transaction',
  'opening_balance',
  'adjustment',
  'reversal',
  'transfer',
  'fx_conversion',
  'intercompany',
  'clearing',
  'investment',
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/**
 * Journal entries. Once posted, an entry is immutable except for the reversal link
 * columns and the status change posted → reversed (enforced by trigger).
 * To post: insert the entry as `draft`, insert its lines, then set status `posted`
 * in the same transaction (see repos/journal.ts `postEntry`).
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: pk(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id),
    entryDate: isoDate('entry_date').notNull(),
    description: text('description').notNull(),
    status: text('status').$type<JournalStatus>().notNull().default('draft'),
    kind: text('kind').$type<JournalKind>().notNull().default('transaction'),
    sourceRecordId: uuid('source_record_id').references((): AnyPgColumn => sourceRecords.id),
    importBatchId: uuid('import_batch_id').references((): AnyPgColumn => importBatches.id),
    idempotencyKey: text('idempotency_key').unique('journal_entries_idempotency_key_key'),
    reversesEntryId: uuid('reverses_entry_id').references((): AnyPgColumn => journalEntries.id),
    reversedByEntryId: uuid('reversed_by_entry_id').references((): AnyPgColumn => journalEntries.id),
    reversedAt: tstz('reversed_at'),
    reversalReason: text('reversal_reason'),
    postedAt: tstz('posted_at'),
    createdBy: text('created_by').notNull().default('system'),
    memo: text('memo'),
    metadata: jsonObject('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('journal_entries_status_check', inList('status', JOURNAL_STATUSES)),
    check('journal_entries_kind_check', inList('kind', JOURNAL_KINDS)),
    check('journal_entries_posted_at_check', sql`status = 'draft' OR posted_at IS NOT NULL`),
    check(
      'journal_entries_reversed_check',
      sql`(status = 'reversed') = (reversed_by_entry_id IS NOT NULL AND reversed_at IS NOT NULL)`,
    ),
    check('journal_entries_not_self_reversing_check', sql`reverses_entry_id IS NULL OR reverses_entry_id <> id`),
    uniqueIndex('journal_entries_reverses_key').on(t.reversesEntryId).where(sql`reverses_entry_id IS NOT NULL`),
    index('journal_entries_entity_date_idx').on(t.entityId, t.entryDate),
    index('journal_entries_source_record_idx').on(t.sourceRecordId),
    index('journal_entries_import_batch_idx').on(t.importBatchId),
  ],
);

/**
 * Journal lines. Signed amounts: debit positive, credit negative. Every entry balances per
 * currency; a deferred constraint trigger checks this at commit.
 */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: pk(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    ledgerAccountId: uuid('ledger_account_id')
      .notNull()
      .references(() => ledgerAccounts.id),
    amount: money('amount').notNull(),
    currency: text('currency')
      .notNull()
      .references(() => currencies.code),
    fxRate: rate('fx_rate'),
    reportingAmount: money('reporting_amount'),
    reportingCurrency: text('reporting_currency'),
    memo: text('memo'),
    categoryId: uuid('category_id').references((): AnyPgColumn => categories.id),
    counterpartyId: uuid('counterparty_id').references(() => counterparties.id),
    economicOwnerEntityId: uuid('economic_owner_entity_id').references(() => entities.id),
    sourceRecordId: uuid('source_record_id').references((): AnyPgColumn => sourceRecords.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('journal_lines_entry_line_key').on(t.entryId, t.lineNo),
    check('journal_lines_non_zero_check', sql`amount <> 0`),
    index('journal_lines_ledger_account_idx').on(t.ledgerAccountId),
    index('journal_lines_entry_idx').on(t.entryId),
  ],
);
