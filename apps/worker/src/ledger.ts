/**
 * Ledger writes for the worker. `packages/db` has no `repos/journal.ts` helper (its own
 * `ledger.ts` schema comment refers to one, but it was never added), so this module implements
 * the same "insert draft, insert lines, then post in one transaction" pattern directly against
 * the schema, using `@financialos/domain`'s pure ledger builders to compute balanced lines.
 *
 * Ledger writes are idempotent: `journal_entries.idempotency_key` is unique, so retried or
 * resumed jobs never duplicate ledger effects (ARCHITECTURE.md "Jobs").
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  ledgerAccounts,
  journalEntries,
  journalLines,
  type DbOrTx,
  type LedgerAccountSubtype,
  type LedgerAccountType,
} from '@financialos/db';
import {
  buildIncomeExpenseEntry,
  chartOf,
  type IncomeExpenseInput,
  type JournalEntry,
  type JournalEntryKind,
  type LedgerAccount as DomainLedgerAccount,
} from '@financialos/domain';

/** Maps the domain engine's fine-grained kind onto the DB schema's coarser `journal_entries.kind` enum. */
function dbJournalKind(kind: JournalEntryKind): 'transaction' | 'opening_balance' | 'adjustment' | 'reversal' | 'transfer' | 'fx_conversion' | 'intercompany' | 'clearing' | 'investment' {
  switch (kind) {
    case 'transfer':
      return 'transfer';
    case 'fx_conversion':
      return 'fx_conversion';
    case 'opening_balance':
      return 'opening_balance';
    case 'reversal':
      return 'reversal';
    case 'investment_trade':
      return 'investment';
    case 'adjustment':
      return 'adjustment';
    default:
      return 'transaction';
  }
}

export type LedgerAccountRow = typeof ledgerAccounts.$inferSelect;

function toDomainAccount(row: LedgerAccountRow): DomainLedgerAccount {
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    type: row.type,
    subtype: row.subtype,
    currency: row.currency,
    // The DB schema tracks "system" as a boolean plus a free-form subtype rather than domain's
    // LedgerSystemRole; only account existence/currency/type are checked by the builders we use,
    // so systemRole is not needed for validation here.
    systemRole: null,
    accountId: row.accountId,
  };
}

/** Idempotently ensures a ledger account with the given `code` exists for the entity, returning it. */
async function ensureLedgerAccount(
  tx: DbOrTx,
  input: { entityId: string; code: string; name: string; type: LedgerAccountType; subtype: LedgerAccountSubtype; currency: string | null; accountId?: string | null; system?: boolean },
): Promise<LedgerAccountRow> {
  await tx
    .insert(ledgerAccounts)
    .values({
      entityId: input.entityId,
      code: input.code,
      name: input.name,
      type: input.type,
      subtype: input.subtype,
      currency: input.currency,
      accountId: input.accountId ?? null,
      system: input.system ?? false,
    })
    .onConflictDoNothing({ target: [ledgerAccounts.entityId, ledgerAccounts.code] });
  const [row] = await tx
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.entityId, input.entityId), eq(ledgerAccounts.code, input.code)))
    .limit(1);
  if (!row) throw new Error(`ledger account ${input.code} for entity ${input.entityId} could not be created`);
  return row;
}

/** The ledger account mirroring a real bank/card/investment account (one per `accounts` row). */
export async function ensureCashLedgerAccount(
  tx: DbOrTx,
  input: { entityId: string; accountId: string; accountName: string; currency: string | null; liability: boolean },
): Promise<LedgerAccountRow> {
  return ensureLedgerAccount(tx, {
    entityId: input.entityId,
    code: `acct:${input.accountId}`,
    name: input.accountName,
    type: input.liability ? 'liability' : 'asset',
    subtype: 'bank',
    currency: input.currency,
    accountId: input.accountId,
  });
}

/**
 * A per-entity suspense account for a direction (income or expense). Used as the offsetting leg
 * for source records the worker has not classified yet — never a guess at a real category.
 */
export async function ensureSuspenseLedgerAccount(tx: DbOrTx, entityId: string, direction: 'income' | 'expense'): Promise<LedgerAccountRow> {
  return ensureLedgerAccount(tx, {
    entityId,
    code: `system:suspense_${direction}`,
    name: direction === 'income' ? 'Unclassified income (suspense)' : 'Unclassified expense (suspense)',
    type: direction,
    subtype: 'suspense',
    currency: null,
    system: true,
  });
}

export interface PostIncomeExpenseInput extends IncomeExpenseInput {
  /** Ledger accounts referenced by the entry, for domain-side validation (currency/type). */
  chartAccounts: readonly LedgerAccountRow[];
  idempotencyKey: string;
  sourceRecordId: string | null;
  importBatchId: string | null;
  createdBy?: string;
}

export interface PostedEntry {
  entryId: string;
  created: boolean;
}

/**
 * Builds a balanced income/expense entry with the domain engine, then writes it as
 * draft → lines → posted in one transaction. If an entry with the same idempotency key already
 * exists, nothing is written again (`created: false`).
 */
export async function postIncomeExpenseEntry(tx: DbOrTx, input: PostIncomeExpenseInput): Promise<PostedEntry> {
  const chart = chartOf(input.chartAccounts.map(toDomainAccount));
  const entry: JournalEntry = buildIncomeExpenseEntry(
    { ...input, id: input.id || randomUUID() },
    { chart },
  );
  return writeEntry(tx, entry, {
    idempotencyKey: input.idempotencyKey,
    sourceRecordId: input.sourceRecordId,
    importBatchId: input.importBatchId,
    createdBy: input.createdBy ?? 'worker',
  });
}

/** Inserts a fully-built domain `JournalEntry` as draft → lines → posted, idempotently. */
export async function writeEntry(
  tx: DbOrTx,
  entry: JournalEntry,
  meta: { idempotencyKey: string; sourceRecordId: string | null; importBatchId: string | null; createdBy: string; reversesEntryId?: string | null },
): Promise<PostedEntry> {
  if (entry.lines.length === 0) throw new Error('a journal entry needs at least one line');
  const entityId = entry.lines[0]!.entityId;
  const inserted = await tx
    .insert(journalEntries)
    .values({
      id: entry.id,
      entityId,
      entryDate: entry.effectiveDate,
      description: entry.description,
      status: 'draft',
      kind: dbJournalKind(entry.kind),
      sourceRecordId: meta.sourceRecordId,
      importBatchId: meta.importBatchId,
      idempotencyKey: meta.idempotencyKey,
      reversesEntryId: meta.reversesEntryId ?? null,
      createdBy: meta.createdBy,
      metadata: { ...entry.metadata },
    })
    .onConflictDoNothing({ target: journalEntries.idempotencyKey })
    .returning({ id: journalEntries.id });
  if (inserted.length === 0) {
    // Already posted by an earlier attempt.
    return { entryId: entry.id, created: false };
  }
  const entryId = inserted[0]!.id;
  await tx.insert(journalLines).values(
    entry.lines.map((line, index) => ({
      entryId,
      lineNo: index + 1,
      ledgerAccountId: line.ledgerAccountId,
      amount: line.amount,
      currency: line.currency,
      categoryId: line.categoryId,
      economicOwnerEntityId: line.economicOwnerEntityId,
      sourceRecordId: meta.sourceRecordId,
    })),
  );
  const now = new Date();
  await tx
    .update(journalEntries)
    .set({ status: 'posted', postedAt: now })
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.status, 'draft')));
  return { entryId, created: true };
}
