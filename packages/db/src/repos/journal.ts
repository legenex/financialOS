/**
 * Journal entries and lines.
 *
 * Posting is deliberately a three-step dance inside one transaction, because the integrity
 * triggers in migration 0001 only allow lines to be written while the entry is a draft:
 *
 *   1. insert the entry as `draft`
 *   2. insert its lines
 *   3. update the entry to `posted`
 *
 * The balance and minimum-line-count checks are deferred constraint triggers, so they would
 * normally fire at COMMIT. `postEntry` forces them with `SET CONSTRAINTS ALL IMMEDIATE`
 * before returning, so FS003/FS005 surface as typed `IntegrityError`s at the call site
 * rather than as an opaque commit failure.
 *
 * Entries themselves are built by the pure builders in `@financialos/domain` (income,
 * expense, transfer, FX conversion, split, fee, refund, opening balance, trade, dividend,
 * interest). This repository validates what it is given with `validateEntry` and persists
 * it; it never invents lines. A posted entry is immutable: corrections are a reversal plus
 * a replacement.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  correctEntry as domainCorrectEntry,
  reverseEntry as domainReverseEntry,
  validateEntry,
  type JournalEntry as DomainJournalEntry,
  type LedgerChart,
  type LedgerIssue,
} from '@financialos/domain';
import { journalEntries, journalLines, ledgerAccounts, type JournalKind, type JournalStatus } from '../schema/ledger';
import { ConflictError, flushDeferredConstraints, InvalidError, mapErrors, normalizeDecimal, required, tx, type DbOrTx } from './_util';

export type JournalEntryRow = typeof journalEntries.$inferSelect;
export type JournalLineRow = typeof journalLines.$inferSelect;

/** A validation failure reported by the domain ledger rules before anything was written. */
export class LedgerValidationError extends InvalidError {
  override name = 'LedgerValidationError';
  constructor(readonly issues: readonly LedgerIssue[]) {
    super(`Journal entry is not valid: ${issues.map((i) => i.message).join('; ')}`);
  }
}

/** Database kind for a domain entry kind. The database vocabulary is coarser on purpose. */
export function dbKindFor(kind: DomainJournalEntry['kind']): JournalKind {
  switch (kind) {
    case 'transfer':
      return 'transfer';
    case 'fx_conversion':
      return 'fx_conversion';
    case 'reversal':
      return 'reversal';
    case 'opening_balance':
      return 'opening_balance';
    case 'investment_trade':
      return 'investment';
    case 'adjustment':
      return 'adjustment';
    default:
      return 'transaction';
  }
}

/** Per-line columns the database keeps but the pure domain entry does not carry. */
export interface LineExtras {
  counterpartyId?: string | null;
  sourceRecordId?: string | null;
  categoryId?: string | null;
  fxRate?: string | null;
  reportingAmount?: string | null;
  reportingCurrency?: string | null;
}

export interface PostEntryInput {
  /** Built with a `@financialos/domain` builder. Must be `posted` or `pending`. */
  entry: DomainJournalEntry;
  /** Header entity. Defaults to the entity of the first line. */
  entityId?: string;
  kind?: JournalKind;
  /** Makes reposting the same work a no-op. Strongly recommended for job handlers. */
  idempotencyKey?: string | null;
  sourceRecordId?: string | null;
  importBatchId?: string | null;
  createdBy?: string;
  memo?: string | null;
  /** Extra database-only columns, indexed by line position (0-based). */
  lineExtras?: readonly (LineExtras | undefined)[];
  /** When given, the entry is also validated against the chart (currency, entity, role). */
  chart?: LedgerChart;
}

export interface PostedEntry {
  entry: JournalEntryRow;
  lines: JournalLineRow[];
  /** False when an entry with the same idempotency key already existed. */
  created: boolean;
}

/** Validates, then writes the entry and its lines in one transaction. */
export async function postEntry(db: DbOrTx, input: PostEntryInput, now = new Date()): Promise<PostedEntry> {
  const { entry } = input;
  if (entry.status === 'reversed') throw new InvalidError('Post the original entry, then reverse it; a reversed entry is not posted directly');
  const validation = validateEntry(entry, input.chart ? { chart: input.chart } : {});
  if (!validation.ok) throw new LedgerValidationError(validation.issues);

  const headerEntity = input.entityId ?? entry.lines[0]?.entityId;
  if (!headerEntity) throw new InvalidError('A journal entry needs a header entity');

  return mapErrors('post journal entry', () =>
    tx(db, async (t) => {
      if (input.idempotencyKey) {
        const [existing] = await t.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, input.idempotencyKey)).limit(1);
        if (existing) return { entry: existing, lines: await linesOf(t, existing.id), created: false };
      }

      await assertLedgerAccountsExist(t, entry);

      const status: JournalStatus = entry.status === 'pending' ? 'draft' : 'posted';
      const [draft] = await t
        .insert(journalEntries)
        .values({
          entityId: headerEntity,
          entryDate: entry.effectiveDate,
          description: entry.description,
          status: 'draft',
          kind: input.kind ?? dbKindFor(entry.kind),
          sourceRecordId: input.sourceRecordId ?? entry.sourceRecordIds[0] ?? null,
          importBatchId: input.importBatchId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          reversesEntryId: entry.reversesEntryId,
          createdBy: input.createdBy ?? 'system',
          memo: input.memo ?? null,
          metadata: entryMetadata(entry),
        })
        .returning();
      const header = required(draft, 'journal entry');

      const lines: JournalLineRow[] = [];
      for (const [index, line] of entry.lines.entries()) {
        const extras = input.lineExtras?.[index] ?? {};
        const [row] = await t
          .insert(journalLines)
          .values({
            entryId: header.id,
            lineNo: index + 1,
            ledgerAccountId: line.ledgerAccountId,
            amount: line.amount,
            currency: line.currency,
            fxRate: extras.fxRate ?? null,
            reportingAmount: extras.reportingAmount ?? null,
            reportingCurrency: extras.reportingCurrency ?? null,
            memo: line.memo,
            categoryId: extras.categoryId ?? line.categoryId,
            counterpartyId: extras.counterpartyId ?? null,
            economicOwnerEntityId: line.economicOwnerEntityId,
            sourceRecordId: extras.sourceRecordId ?? entry.sourceRecordIds[0] ?? null,
          })
          .returning();
        lines.push(required(row, 'journal line'));
      }

      let final = header;
      if (status === 'posted') {
        const [posted] = await t
          .update(journalEntries)
          .set({ status: 'posted', postedAt: now })
          .where(eq(journalEntries.id, header.id))
          .returning();
        final = required(posted, 'journal entry');
      }
      // Surface FS003 / FS005 here instead of at commit.
      await flushDeferredConstraints(t);
      return { entry: final, lines, created: true };
    }),
  );
}

function entryMetadata(entry: DomainJournalEntry): Record<string, unknown> {
  const entities = [...new Set(entry.lines.map((l) => l.entityId))];
  return {
    ...entry.metadata,
    domainKind: entry.kind,
    lineNatures: entry.lines.map((l) => l.nature),
    ...(entities.length > 1 ? { entities } : {}),
    ...(entry.replacesEntryId ? { replacesEntryId: entry.replacesEntryId } : {}),
    ...(entry.refundOfEntryId ? { refundOfEntryId: entry.refundOfEntryId } : {}),
    ...(entry.sourceRecordIds.length > 1 ? { sourceRecordIds: [...entry.sourceRecordIds] } : {}),
  };
}

/** Refuses to post against an unknown ledger account, or one belonging to another entity. */
async function assertLedgerAccountsExist(db: DbOrTx, entry: DomainJournalEntry): Promise<void> {
  const ids = [...new Set(entry.lines.map((l) => l.ledgerAccountId))];
  const rows = await db
    .select({ id: ledgerAccounts.id, entityId: ledgerAccounts.entityId, currency: ledgerAccounts.currency })
    .from(ledgerAccounts)
    .where(inArray(ledgerAccounts.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [index, line] of entry.lines.entries()) {
    const account = byId.get(line.ledgerAccountId);
    if (!account) throw new InvalidError(`Line ${index + 1}: ledger account ${line.ledgerAccountId} does not exist`);
    if (account.entityId !== line.entityId) {
      throw new InvalidError(`Line ${index + 1}: ledger account ${account.id} belongs to another entity`);
    }
    if (account.currency !== null && account.currency !== line.currency) {
      throw new InvalidError(`Line ${index + 1}: ledger account ${account.id} is ${account.currency}, the line is ${line.currency}`);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Reversal and correction
// ---------------------------------------------------------------------------------------

export interface ReverseInput {
  entryId: string;
  reason: string;
  /** Defaults to the original entry date; never earlier than it. */
  effectiveDate?: string;
  description?: string;
  createdBy?: string;
  idempotencyKey?: string | null;
}

export interface ReversalResult {
  original: JournalEntryRow;
  reversal: JournalEntryRow;
  reversalLines: JournalLineRow[];
}

/**
 * Posts an exact negation of a posted entry and links both ways. The original is never
 * edited beyond the reversal link columns the trigger allows.
 */
export async function reverseEntry(db: DbOrTx, input: ReverseInput, now = new Date()): Promise<ReversalResult> {
  if (!input.reason.trim()) throw new InvalidError('A reversal needs a reason');
  return mapErrors('reverse journal entry', () =>
    tx(db, async (t) => {
      const original = await loadDomainEntry(t, input.entryId);
      if (original.row.status !== 'posted') throw new ConflictError(`Entry ${input.entryId} is ${original.row.status}; only posted entries are reversed`);
      if (original.row.reversedByEntryId) throw new ConflictError(`Entry ${input.entryId} is already reversed`);

      const reversalId = crypto.randomUUID();
      const built = domainReverseEntry(original.entry, {
        id: reversalId,
        effectiveDate: input.effectiveDate ?? original.row.entryDate,
        reason: input.reason,
        ...(input.description ? { description: input.description } : {}),
      });

      const posted = await postEntry(
        t,
        {
          entry: built.reversal,
          entityId: original.row.entityId,
          kind: 'reversal',
          idempotencyKey: input.idempotencyKey ?? null,
          sourceRecordId: original.row.sourceRecordId,
          importBatchId: original.row.importBatchId,
          createdBy: input.createdBy ?? 'system',
          memo: input.reason,
          lineExtras: original.lines.map((l) => ({ counterpartyId: l.counterpartyId, sourceRecordId: l.sourceRecordId, categoryId: l.categoryId })),
        },
        now,
      );

      const [updated] = await t
        .update(journalEntries)
        .set({ status: 'reversed', reversedByEntryId: posted.entry.id, reversedAt: now, reversalReason: input.reason })
        .where(and(eq(journalEntries.id, input.entryId), isNull(journalEntries.reversedByEntryId)))
        .returning();
      if (!updated) throw new ConflictError(`Entry ${input.entryId} was reversed by someone else`);
      return { original: updated, reversal: posted.entry, reversalLines: posted.lines };
    }),
  );
}

export interface CorrectInput extends ReverseInput {
  /** The corrected entry, built with a domain builder. */
  replacement: DomainJournalEntry;
  replacementEntityId?: string;
  replacementKind?: JournalKind;
  replacementIdempotencyKey?: string | null;
  replacementLineExtras?: readonly (LineExtras | undefined)[];
}

export interface CorrectionResult extends ReversalResult {
  replacement: JournalEntryRow;
  replacementLines: JournalLineRow[];
}

/**
 * A correction is a reversal plus a replacement, both posted in one transaction. The
 * replacement carries `metadata.replacesEntryId` so the chain stays explainable.
 */
export async function correctEntry(db: DbOrTx, input: CorrectInput, now = new Date()): Promise<CorrectionResult> {
  return mapErrors('correct journal entry', () =>
    tx(db, async (t) => {
      const original = await loadDomainEntry(t, input.entryId);
      if (original.row.status !== 'posted') throw new ConflictError(`Entry ${input.entryId} is ${original.row.status}; only posted entries are corrected`);
      // Validates the pair (no reversal as a replacement, distinct ids, valid replacement).
      domainCorrectEntry(original.entry, input.replacement, {
        id: crypto.randomUUID(),
        effectiveDate: input.effectiveDate ?? original.row.entryDate,
        reason: input.reason,
      });

      const reversal = await reverseEntry(t, input, now);
      const replacement = await postEntry(
        t,
        {
          entry: { ...input.replacement, replacesEntryId: input.entryId },
          ...(input.replacementEntityId ? { entityId: input.replacementEntityId } : { entityId: original.row.entityId }),
          ...(input.replacementKind ? { kind: input.replacementKind } : {}),
          idempotencyKey: input.replacementIdempotencyKey ?? null,
          sourceRecordId: original.row.sourceRecordId,
          importBatchId: original.row.importBatchId,
          createdBy: input.createdBy ?? 'system',
          memo: `Correction of ${input.entryId}: ${input.reason}`,
          ...(input.replacementLineExtras ? { lineExtras: input.replacementLineExtras } : {}),
        },
        now,
      );
      return { ...reversal, replacement: replacement.entry, replacementLines: replacement.lines };
    }),
  );
}

// ---------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------

export async function getEntry(db: DbOrTx, id: string): Promise<JournalEntryRow | undefined> {
  const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, id)).limit(1);
  return row;
}

export async function getEntryByIdempotencyKey(db: DbOrTx, key: string): Promise<JournalEntryRow | undefined> {
  const [row] = await db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, key)).limit(1);
  return row;
}

export async function linesOf(db: DbOrTx, entryId: string): Promise<JournalLineRow[]> {
  return db.select().from(journalLines).where(eq(journalLines.entryId, entryId)).orderBy(asc(journalLines.lineNo));
}

export interface EntryQuery {
  entityId?: string | string[];
  status?: JournalStatus | JournalStatus[];
  kind?: JournalKind | JournalKind[];
  from?: string;
  to?: string;
  sourceRecordId?: string;
  importBatchId?: string;
  limit?: number;
}

export async function listEntries(db: DbOrTx, query: EntryQuery = {}): Promise<JournalEntryRow[]> {
  const conditions: SQL[] = [];
  if (query.entityId) conditions.push(inArray(journalEntries.entityId, Array.isArray(query.entityId) ? query.entityId : [query.entityId]));
  if (query.status) conditions.push(inArray(journalEntries.status, Array.isArray(query.status) ? query.status : [query.status]));
  if (query.kind) conditions.push(inArray(journalEntries.kind, Array.isArray(query.kind) ? query.kind : [query.kind]));
  if (query.from) conditions.push(gte(journalEntries.entryDate, query.from));
  if (query.to) conditions.push(lte(journalEntries.entryDate, query.to));
  if (query.sourceRecordId) conditions.push(eq(journalEntries.sourceRecordId, query.sourceRecordId));
  if (query.importBatchId) conditions.push(eq(journalEntries.importBatchId, query.importBatchId));
  return db
    .select()
    .from(journalEntries)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.createdAt))
    .limit(query.limit ?? 1000);
}

export interface LedgerBalanceRow {
  ledgerAccountId: string;
  entityId: string;
  code: string;
  name: string;
  type: string;
  currency: string;
  /** Debit-positive net balance, as a decimal string. */
  balance: string;
  debits: string;
  credits: string;
}

export interface BalanceQuery {
  entityId?: string | string[];
  ledgerAccountId?: string | string[];
  /** Include entries effective on or before this date. */
  asOf?: string;
  /** Draft entries are excluded unless this is true. */
  includeDrafts?: boolean;
}

/**
 * Balances per ledger account per currency, summed in the database so the whole journal
 * never has to be loaded. Reversed entries stay in the sum: their reversal cancels them.
 */
export async function balances(db: DbOrTx, query: BalanceQuery = {}): Promise<LedgerBalanceRow[]> {
  const conditions: SQL[] = [];
  if (!query.includeDrafts) conditions.push(inArray(journalEntries.status, ['posted', 'reversed']));
  if (query.entityId) conditions.push(inArray(ledgerAccounts.entityId, Array.isArray(query.entityId) ? query.entityId : [query.entityId]));
  if (query.ledgerAccountId) {
    conditions.push(inArray(journalLines.ledgerAccountId, Array.isArray(query.ledgerAccountId) ? query.ledgerAccountId : [query.ledgerAccountId]));
  }
  if (query.asOf) conditions.push(lte(journalEntries.entryDate, query.asOf));

  const rows = await db
    .select({
      ledgerAccountId: journalLines.ledgerAccountId,
      entityId: ledgerAccounts.entityId,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      type: ledgerAccounts.type,
      currency: journalLines.currency,
      balance: sql<string>`sum(${journalLines.amount})`,
      debits: sql<string>`sum(GREATEST(${journalLines.amount}, 0))`,
      credits: sql<string>`sum(GREATEST(-${journalLines.amount}, 0))`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.ledgerAccountId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(journalLines.ledgerAccountId, ledgerAccounts.entityId, ledgerAccounts.code, ledgerAccounts.name, ledgerAccounts.type, journalLines.currency)
    .orderBy(asc(ledgerAccounts.entityId), asc(ledgerAccounts.code), asc(journalLines.currency));

  return rows.map((row) => ({
    ...row,
    balance: normalizeDecimal(row.balance),
    debits: normalizeDecimal(row.debits),
    credits: normalizeDecimal(row.credits),
  }));
}

export interface TrialBalanceTotal {
  currency: string;
  debits: string;
  credits: string;
  balanced: boolean;
}

export interface TrialBalanceResult {
  rows: Array<LedgerBalanceRow & { debit: string; credit: string }>;
  totals: TrialBalanceTotal[];
}

/** Trial balance per currency. `balanced` must be true for every currency of a sane ledger. */
export async function trialBalance(db: DbOrTx, query: BalanceQuery = {}): Promise<TrialBalanceResult> {
  const balanceRows = await balances(db, query);
  const totals = new Map<string, { debits: bigint; credits: bigint }>();
  const rows = balanceRows.map((row) => {
    const negative = row.balance.startsWith('-');
    const debit = negative ? '0' : row.balance;
    const credit = negative ? row.balance.slice(1) : '0';
    const total = totals.get(row.currency) ?? { debits: 0n, credits: 0n };
    total.debits += scaled(debit);
    total.credits += scaled(credit);
    totals.set(row.currency, total);
    return { ...row, debit, credit };
  });
  return {
    rows,
    totals: [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, t]) => ({
        currency,
        debits: unscaled(t.debits),
        credits: unscaled(t.credits),
        balanced: t.debits === t.credits,
      })),
  };
}

// Totals are summed as scaled integers (18 decimal places) so no float ever touches money.
const SCALE = 18;

function scaled(value: string): bigint {
  const negative = value.startsWith('-');
  const [intPart = '0', fracPart = ''] = (negative ? value.slice(1) : value).split('.');
  if (fracPart.length > SCALE) throw new InvalidError('Amount has more than 18 decimal places');
  const digits = `${intPart}${fracPart.padEnd(SCALE, '0')}`;
  const magnitude = BigInt(digits);
  return negative ? -magnitude : magnitude;
}

function unscaled(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(SCALE + 1, '0');
  const intPart = digits.slice(0, digits.length - SCALE);
  const fracPart = digits.slice(digits.length - SCALE).replace(/0+$/, '');
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative && body !== '0' ? `-${body}` : body;
}

/** Rebuilds a domain entry (with its lines) from the database, for reversal and correction. */
export async function loadDomainEntry(
  db: DbOrTx,
  id: string,
): Promise<{ row: JournalEntryRow; lines: JournalLineRow[]; entry: DomainJournalEntry }> {
  const row = required(await getEntry(db, id), 'journal entry');
  const lines = await linesOf(db, id);
  const accountIds = [...new Set(lines.map((l) => l.ledgerAccountId))];
  const accountRows = accountIds.length
    ? await db.select({ id: ledgerAccounts.id, entityId: ledgerAccounts.entityId }).from(ledgerAccounts).where(inArray(ledgerAccounts.id, accountIds))
    : [];
  const entityOf = new Map(accountRows.map((a) => [a.id, a.entityId]));
  const natures = Array.isArray(row.metadata.lineNatures) ? (row.metadata.lineNatures as string[]) : [];
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.metadata)) if (typeof value === 'string') metadata[key] = value;

  const entry: DomainJournalEntry = {
    id: row.id,
    effectiveDate: row.entryDate,
    kind: (typeof row.metadata.domainKind === 'string' ? row.metadata.domainKind : 'adjustment') as DomainJournalEntry['kind'],
    status: row.status === 'draft' ? 'pending' : row.status === 'reversed' ? 'reversed' : 'posted',
    description: row.description,
    reversesEntryId: row.reversesEntryId,
    reversedByEntryId: row.reversedByEntryId,
    replacesEntryId: typeof row.metadata.replacesEntryId === 'string' ? row.metadata.replacesEntryId : null,
    refundOfEntryId: typeof row.metadata.refundOfEntryId === 'string' ? row.metadata.refundOfEntryId : null,
    sourceRecordIds: row.sourceRecordId ? [row.sourceRecordId] : [],
    metadata,
    lines: lines.map((line, index) => ({
      ledgerAccountId: line.ledgerAccountId,
      entityId: entityOf.get(line.ledgerAccountId) ?? row.entityId,
      amount: normalizeDecimal(line.amount),
      currency: line.currency,
      counterpartyEntityId: null,
      economicOwnerEntityId: line.economicOwnerEntityId,
      categoryId: line.categoryId,
      nature: (natures[index] ?? 'unknown') as DomainJournalEntry['lines'][number]['nature'],
      memo: line.memo,
    })),
  };
  return { row, lines, entry };
}

/** Deletes a draft entry and its lines. Posted entries can never be deleted. */
export async function deleteDraft(db: DbOrTx, id: string): Promise<boolean> {
  return mapErrors('delete draft journal entry', async () => {
    const rows = await db
      .delete(journalEntries)
      .where(and(eq(journalEntries.id, id), eq(journalEntries.status, 'draft')))
      .returning({ id: journalEntries.id });
    return rows.length > 0;
  });
}

export async function listReversals(db: DbOrTx, entryId: string): Promise<JournalEntryRow[]> {
  return db.select().from(journalEntries).where(eq(journalEntries.reversesEntryId, entryId)).orderBy(desc(journalEntries.createdAt));
}
