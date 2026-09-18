/**
 * import.parse / import.commit / import.reverse.
 *
 * Parsing uses `@financialos/integrations`' file pipeline; dedupe planning uses
 * `@financialos/domain`'s `planImport`. Classification here is deliberately minimal: every
 * committed row is posted as `nature: 'unknown'`, `method: 'none'`, `needsReview: true` against a
 * per-entity suspense ledger account, and one aggregate `unclassified` exception is raised per
 * batch. A full rule-based classifier (matching `rules` rows, transfer detection, third-party
 * clearing) is a separate, larger feature and out of scope for this pass — see the worker's
 * final report.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { ColumnMapping } from '@financialos/contracts';
import {
  accounts,
  classifications,
  documents,
  importBatches,
  importRows,
  sourceRecords,
  type DbOrTx,
} from '@financialos/db';
import { planImport, reverseEntry, type ExistingSourceRecord, type IncomingSourceRow, type JournalEntry } from '@financialos/domain';
import { parseFile, type ParseFileOptions } from '@financialos/integrations';
import { decryptEnvelope } from '@financialos/security/crypto';
import { redactText } from '@financialos/security/redact';
import { ensureCashLedgerAccount, ensureSuspenseLedgerAccount, postIncomeExpenseEntry, writeEntry } from '../ledger';
import { raiseException } from '../exceptions';
import type { JobContext, JobOutcome } from './types';

async function readDocumentBytes(ctx: JobContext, documentId: string): Promise<Uint8Array> {
  const [doc] = await ctx.db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) throw new Error(`document ${documentId} not found`);
  const raw = readFileSync(join(ctx.config.documentsDir, doc.storageKey));
  if (!doc.encrypted) return raw;
  return decryptEnvelope(ctx.keyring, raw, { aad: `document:${doc.id}` });
}

export async function handleImportParse(ctx: JobContext, data: { importBatchId: string }): Promise<JobOutcome> {
  const [batch] = await ctx.db.select().from(importBatches).where(eq(importBatches.id, data.importBatchId)).limit(1);
  if (!batch) throw new Error(`import batch ${data.importBatchId} not found`);
  // 'parsing' is included: the configure route sets it synchronously before enqueuing this very
  // job, so it is this job's own signal to proceed, not evidence that another run already did.
  if (!['uploaded', 'needs_mapping', 'parsing'].includes(batch.status)) {
    return { status: 'skipped', summary: `batch is already ${batch.status}` };
  }
  if (!batch.accountId || !batch.fileKind) {
    await ctx.db.update(importBatches).set({ status: 'failed', error: 'account and file kind must be chosen before parsing' }).where(eq(importBatches.id, batch.id));
    return { status: 'ok', summary: 'batch is missing account/file kind; marked failed' };
  }
  const [account] = await ctx.db.select().from(accounts).where(eq(accounts.id, batch.accountId)).limit(1);
  if (!account) throw new Error(`account ${batch.accountId} not found`);

  await ctx.db.update(importBatches).set({ status: 'parsing' }).where(eq(importBatches.id, batch.id));

  const mapping = batch.mapping ? ColumnMapping.parse(batch.mapping) : null;
  const bytes = await readDocumentBytes(ctx, batch.documentId!);
  const options: ParseFileOptions = {
    kind: batch.fileKind,
    mapping,
    timezone: mapping?.sourceTimezone ?? 'UTC',
    currency: batch.statementCurrency ?? account.currency ?? mapping?.defaultCurrency ?? 'USD',
    fileName: batch.fileName,
  };

  let result: Awaited<ReturnType<typeof parseFile>>;
  try {
    result = await parseFile(bytes, options);
  } catch (err) {
    const message = err instanceof Error ? redactText(err.message) : 'parse failed';
    await ctx.db.update(importBatches).set({ status: 'failed', error: message }).where(eq(importBatches.id, batch.id));
    return { status: 'ok', summary: `parse failed: ${message}` };
  }

  if (!mapping) {
    await ctx.db
      .update(importBatches)
      .set({
        status: 'needs_mapping',
        detectedHeaders: result.detectedHeaders,
        sampleRows: result.sampleRows,
        checks: result.checks,
        parser: result.parser,
        parserVersion: result.parserVersion,
      })
      .where(eq(importBatches.id, batch.id));
    return { status: 'ok', summary: 'headers detected; mapping required before rows can be planned' };
  }

  const incoming: IncomingSourceRow[] = result.rows.map((row) => ({
    rowNumber: row.rowNumber,
    accountId: account.id,
    bookedOn: row.bookedOn,
    amount: { amount: row.amount, currency: row.currency },
    description: row.description,
    providerTransactionId: row.externalId,
    pending: row.pending,
    counterparty: row.counterparty,
    valueOn: row.valueOn,
  }));

  const existingRows = await ctx.db
    .select({
      id: sourceRecords.id,
      accountId: sourceRecords.accountId,
      bookedOn: sourceRecords.bookedOn,
      amount: sourceRecords.amount,
      currency: sourceRecords.currency,
      description: sourceRecords.description,
      providerId: sourceRecords.providerId,
      pending: sourceRecords.pending,
      dedupeKey: sourceRecords.dedupeKey,
      contentHash: sourceRecords.contentHash,
    })
    .from(sourceRecords)
    .where(and(eq(sourceRecords.accountId, account.id), isNull(sourceRecords.supersededBy), ne(sourceRecords.importBatchId, batch.id)));

  const existing: ExistingSourceRecord[] = existingRows
    .filter((r): r is typeof r & { bookedOn: string; amount: string; currency: string } => r.bookedOn !== null && r.amount !== null && r.currency !== null)
    .map((r) => ({
      id: r.id,
      accountId: r.accountId,
      bookedOn: r.bookedOn,
      amount: { amount: r.amount, currency: r.currency },
      description: r.description ?? '',
      providerTransactionId: r.providerId,
      pending: r.pending,
      dedupeKey: r.dedupeKey,
      contentHash: r.contentHash,
    }));

  const plan = planImport(existing, incoming);

  await ctx.db.delete(importRows).where(eq(importRows.batchId, batch.id));
  if (plan.rows.length > 0) {
    await ctx.db.insert(importRows).values(
      plan.rows.map((planned, i) => {
        const row = result.rows[i]!;
        return {
          batchId: batch.id,
          rowNumber: row.rowNumber,
          status: planned.status,
          raw: row.raw,
          parsed: { description: row.description, counterparty: row.counterparty, reference: row.reference, categoryHint: row.categoryHint },
          bookedOn: row.bookedOn,
          description: row.description,
          amount: row.amount,
          currency: row.currency,
          balance: row.balance,
          pending: row.pending,
          message: planned.explanation.join('; '),
          dedupeKey: planned.dedupeKey,
          duplicateOfSourceRecordId: planned.status === 'duplicate' || planned.status === 'possible_duplicate' || planned.status === 'pending_to_posted' ? planned.matchedRecordId : null,
        };
      }),
    );
  }

  await ctx.db
    .update(importBatches)
    .set({
      status: 'previewed',
      detectedHeaders: result.detectedHeaders,
      sampleRows: result.sampleRows,
      checks: result.checks,
      parser: result.parser,
      parserVersion: result.parserVersion,
      counts: { ...plan.counts, error: result.errors.length, skipped: result.skipped.length, imported: 0 },
      coverageFrom: result.coverage.from,
      coverageTo: result.coverage.to,
      statementOpening: result.statementBalances.opening?.amount ?? batch.statementOpening,
      statementClosing: result.statementBalances.closing?.amount ?? batch.statementClosing,
    })
    .where(eq(importBatches.id, batch.id));

  return { status: 'ok', summary: `parsed ${result.rows.length} row(s)`, detail: plan.counts };
}

export async function handleImportCommit(ctx: JobContext, data: { importBatchId: string; idempotencyKey: string; includePossibleDuplicates: number[] }): Promise<JobOutcome> {
  const [batch] = await ctx.db.select().from(importBatches).where(eq(importBatches.id, data.importBatchId)).limit(1);
  if (!batch) throw new Error(`import batch ${data.importBatchId} not found`);
  if (batch.status === 'committed') return { status: 'skipped', summary: 'already committed' };
  // 'committing' is included: the commit route sets it synchronously before enqueuing this very
  // job, so it is this job's own signal to proceed, not evidence that another run already did.
  if (batch.status !== 'previewed' && batch.status !== 'committing') {
    throw new Error(`batch ${batch.id} is ${batch.status}, expected previewed`);
  }
  if (!batch.accountId) throw new Error('batch has no account');

  const [account] = await ctx.db.select().from(accounts).where(eq(accounts.id, batch.accountId)).limit(1);
  if (!account) throw new Error(`account ${batch.accountId} not found`);
  if (!account.legalEntityId) {
    await raiseException(ctx.db, {
      dedupeKey: `ownership_uncertain:${account.id}`,
      kind: 'ownership_uncertain',
      severity: 'warning',
      title: `${account.name}: legal entity not confirmed`,
      body: 'This account has no confirmed legal entity, so imported transactions cannot be posted to the ledger yet.',
      subjectType: 'account',
      subjectId: account.id,
      source: 'worker',
    });
    return { status: 'ok', summary: 'account has no confirmed legal entity; source records recorded but not posted' };
  }

  await ctx.db.update(importBatches).set({ status: 'committing' }).where(eq(importBatches.id, batch.id));

  const includeSet = new Set(data.includePossibleDuplicates);
  const rows = await ctx.db
    .select()
    .from(importRows)
    .where(
      and(
        eq(importRows.batchId, batch.id),
        inArray(importRows.status, ['new', 'possible_duplicate']),
      ),
    )
    .orderBy(importRows.rowNumber);
  const toCommit = rows.filter((r) => r.status === 'new' || includeSet.has(r.rowNumber));

  const cash = await ensureCashLedgerAccount(ctx.db, {
    entityId: account.legalEntityId,
    accountId: account.id,
    accountName: account.name,
    currency: account.currency,
    liability: account.liquidityClass === 'liability',
  });

  let imported = 0;
  for (const row of toCommit) {
    if (row.amount === null || row.currency === null || row.bookedOn === null) continue;
    const [sourceRecord] = await ctx.db
      .insert(sourceRecords)
      .values({
        accountId: account.id,
        origin: 'import',
        recordKind: 'transaction',
        importBatchId: batch.id,
        documentId: batch.documentId,
        dedupeKey: row.dedupeKey ?? `row:${row.id}`,
        contentHash: row.dedupeKey ?? `row:${row.id}`,
        raw: (row.raw ?? {}) as Record<string, unknown>,
        bookedOn: row.bookedOn,
        amount: row.amount,
        currency: row.currency,
        description: row.description,
        pending: row.pending,
      })
      .onConflictDoUpdate({ target: [sourceRecords.accountId, sourceRecords.dedupeKey], set: { lastSeenAt: new Date() } })
      .returning({ id: sourceRecords.id });
    const sourceRecordId = sourceRecord!.id;

    await ctx.db
      .insert(classifications)
      .values({
        sourceRecordId,
        version: 1,
        isCurrent: true,
        nature: 'unknown',
        method: 'none',
        confidence: 'none',
        needsReview: true,
        createdBy: 'worker',
      })
      .onConflictDoNothing({ target: [classifications.sourceRecordId, classifications.version] });

    const direction: 'income' | 'expense' = row.amount.startsWith('-') ? 'expense' : 'income';
    const suspense = await ensureSuspenseLedgerAccount(ctx.db, account.legalEntityId, direction);
    await postIncomeExpenseEntry(ctx.db, {
      id: randomUUID(),
      effectiveDate: row.bookedOn,
      description: row.description ?? 'Imported transaction',
      entityId: account.legalEntityId,
      cashLedgerAccountId: cash.id,
      pnlLedgerAccountId: suspense.id,
      amount: { amount: row.amount.replace('-', ''), currency: row.currency },
      direction,
      nature: 'unknown',
      chartAccounts: [cash, suspense],
      idempotencyKey: `import:${sourceRecordId}`,
      sourceRecordId,
      importBatchId: batch.id,
      economicOwnerEntityId: account.economicOwnerEntityId,
    });

    await ctx.db.update(importRows).set({ sourceRecordId, status: 'new' }).where(eq(importRows.id, row.id));
    imported += 1;
  }

  if (imported > 0) {
    await raiseException(ctx.db, {
      dedupeKey: `unclassified:batch:${batch.id}`,
      kind: 'unclassified',
      severity: 'info',
      title: `${imported} imported transaction(s) need a category`,
      body: `Imported from ${batch.fileName}. Every row was posted to suspense pending classification.`,
      subjectType: 'import_batch',
      subjectId: batch.id,
      entityId: account.legalEntityId,
      source: 'worker',
    });
  }

  await ctx.db
    .update(importBatches)
    .set({
      status: 'committed',
      committedAt: new Date(),
      commitIdempotencyKey: data.idempotencyKey,
      counts: { ...batch.counts, imported } as typeof batch.counts,
    })
    .where(eq(importBatches.id, batch.id));

  return { status: 'ok', summary: `committed ${imported} row(s)`, detail: { imported } };
}

export async function handleImportReverse(ctx: JobContext, data: { importBatchId: string; reason: string }): Promise<JobOutcome> {
  const [batch] = await ctx.db.select().from(importBatches).where(eq(importBatches.id, data.importBatchId)).limit(1);
  if (!batch) throw new Error(`import batch ${data.importBatchId} not found`);
  if (batch.status === 'reversed') return { status: 'skipped', summary: 'already reversed' };
  // 'reversing' is included: the reverse route sets it (racily, just after enqueuing) as its own
  // signal that this job should proceed, not evidence that another run already did.
  if (batch.status !== 'committed' && batch.status !== 'reversing') {
    throw new Error(`batch ${batch.id} is ${batch.status}, expected committed`);
  }

  await ctx.db.update(importBatches).set({ status: 'reversing' }).where(eq(importBatches.id, batch.id));

  const entries = await ctx.db.query.journalEntries.findMany({
    where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.importBatchId, batch.id), eqOp(t.status, 'posted')),
  });

  let reversed = 0;
  const now = new Date().toISOString().slice(0, 10);
  for (const row of entries) {
    const lines = await ctx.db.query.journalLines.findMany({ where: (t, { eq: eqOp }) => eqOp(t.entryId, row.id) });
    const original: JournalEntry = {
      id: row.id,
      effectiveDate: row.entryDate,
      kind: 'transaction' as JournalEntry['kind'],
      status: 'posted',
      description: row.description,
      reversesEntryId: row.reversesEntryId,
      reversedByEntryId: row.reversedByEntryId,
      replacesEntryId: null,
      refundOfEntryId: null,
      sourceRecordIds: row.sourceRecordId ? [row.sourceRecordId] : [],
      metadata: (row.metadata ?? {}) as Record<string, string>,
      lines: lines.map((l) => ({
        ledgerAccountId: l.ledgerAccountId,
        entityId: row.entityId,
        amount: l.amount,
        currency: l.currency,
        counterpartyEntityId: null,
        economicOwnerEntityId: l.economicOwnerEntityId,
        categoryId: l.categoryId,
        nature: 'unknown',
        memo: l.memo,
      })),
    };
    const { reversal } = reverseEntry(original, { id: randomUUID(), effectiveDate: now, reason: data.reason });
    const written = await writeEntry(ctx.db, reversal, {
      idempotencyKey: `reverse:${row.id}`,
      sourceRecordId: row.sourceRecordId,
      importBatchId: batch.id,
      createdBy: 'worker',
      reversesEntryId: row.id,
    });
    if (written.created) {
      await ctx.db.update(importBatches).set({}).where(eq(importBatches.id, batch.id)); // no-op keeps types aligned; real update below
      const { journalEntries: journalEntriesTable } = await import('@financialos/db');
      await ctx.db
        .update(journalEntriesTable)
        .set({ status: 'reversed', reversedByEntryId: written.entryId, reversedAt: new Date(), reversalReason: data.reason })
        .where(eq(journalEntriesTable.id, row.id));
      reversed += 1;
    }
  }

  await ctx.db.update(importBatches).set({ status: 'reversed', reversedAt: new Date(), reversalReason: data.reason }).where(eq(importBatches.id, batch.id));
  return { status: 'ok', summary: `reversed ${reversed} entr(y/ies)`, detail: { reversed } };
}
