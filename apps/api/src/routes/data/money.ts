/**
 * Money: entities, institutions, accounts, balances, holdings, transactions, classification,
 * categories, rules, portfolio, restrictions, fixed income, documents and the CSV export.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AccountInput,
  BalanceSnapshotInput,
  ClassificationInput,
  DocumentRecord,
  EntityInput,
  FixedIncomeTerms,
  Restriction,
  SaleScheduleRequest,
  TransactionQuery,
  type Account,
  type Category,
  type CoverageGap,
  type DocumentRecord as DocumentRecordType,
  type Entity,
  type Holdings,
  type Institution,
  type InterestProjection,
  type PortfolioSummary,
  type Reconciliation,
  type SaleScheduleResult,
  type Transaction,
  type TransactionPage,
} from '@financialos/contracts';
import {
  accounts as accountsTable,
  balanceSnapshots,
  categories as categoriesTable,
  coveragePeriods,
  documents as documentsTable,
  entities as entitiesTable,
  fixedIncomeTerms as fixedIncomeTable,
  institutions as institutionsTable,
  reconciliations,
  restrictions as restrictionsTable,
  rules as rulesTable,
  transferMatches,
  watchEvents,
} from '@financialos/db';
import { CsvWriter } from '@financialos/security/csv';
import { coverageWindow, detectCoverageGaps, validateRule, type ClassificationRule } from '@financialos/domain';
import { errors } from '../../errors';
import { parseBody, parseQuery } from '../../validation';
import { assertSessionStillValid } from '../../auth/guards';
import { sendSessionBoundDownload } from '../../auth/streams';
import { iso, loadFxTable, loadSettings, normalizeDecimal, reportingToday, shiftDays } from '../../data/common';
import { entityView, holdingsView, institutionView, loadAccountBundles, loadHoldings, snapshotView } from '../../data/accounts';
import {
  applyOwnerClassification,
  classificationHistory,
  loadTransaction,
  loadTransactionPage,
  type TransactionContext,
} from '../../data/transactions';
import { fixedIncomeFor, interestProjectionFor, listRestrictions, listWatchEvents, loadPortfolio, planRestrictedSale, restrictionView, saleScheduleOptions } from '../../data/portfolio';
import { audit, financeBase, loadOne, ownerRoutes, requireUuid } from './_shared';

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const ALLOWED_DOCUMENT_MIME = new Set([
  'application/pdf',
  'text/csv',
  'text/plain',
  'image/png',
  'image/jpeg',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/xml',
  'text/xml',
  'application/octet-stream',
]);
const CSV_EXPORT_MAX_ROWS = 50_000;

const CategoryInput = z.object({
  parentId: z.uuid().nullable(),
  name: z.string().min(1).max(80),
  kind: z.enum(['expense', 'income', 'transfer', 'other']),
  essential: z.boolean(),
});

const TextMatch = z.enum(['contains', 'startsWith', 'equals']);
const RuleCondition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('description'), op: TextMatch, value: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('counterparty'), op: TextMatch, value: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('amount_range'), min: z.string().nullable(), max: z.string().nullable() }),
  z.object({ kind: z.literal('direction'), value: z.enum(['in', 'out']) }),
  z.object({ kind: z.literal('currency'), value: z.string().min(2).max(10) }),
  z.object({ kind: z.literal('account'), accountIds: z.array(z.uuid()).min(1).max(50) }),
  z.object({ kind: z.literal('card_last4'), value: z.string().regex(/^\d{4}$/) }),
]);
const RuleActions = z.object({
  categoryId: z.uuid().nullable().optional(),
  nature: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  economicOwnerEntityId: z.uuid().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});
const RuleInput = z.object({
  name: z.string().min(1).max(80),
  priority: z.number().int().min(0).max(1000).default(100),
  active: z.boolean().default(true),
  kind: z.enum(['general', 'ownership']).default('general'),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  conditions: z.array(RuleCondition).min(1).max(20),
  actions: RuleActions,
  entityId: z.uuid().nullable().default(null),
  accountId: z.uuid().nullable().default(null),
});
const RulePatch = RuleInput.partial().extend({ id: z.uuid() });

const RestrictionInput = Restriction.omit({ id: true });
const RestrictionPatch = RestrictionInput.partial();
const WatchEventInput = z.object({
  instrumentId: z.uuid().nullable(),
  accountId: z.uuid().nullable(),
  kind: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  status: z.enum(['unverified', 'verified', 'occurred', 'dismissed']).default('unverified'),
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  notes: z.string().max(1000).nullable(),
  sourceUrl: z.string().url().max(500).nullable(),
});
const WatchEventPatch = WatchEventInput.partial().extend({ id: z.uuid() });

const DocumentQuery = z.object({ accountId: z.uuid().optional(), entityId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
const SnapshotQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const InterestQuery = z.object({ months: z.coerce.number().int().min(1).max(600).default(12) });
const ExportQuery = TransactionQuery.extend({ limit: z.coerce.number().int().min(1).max(CSV_EXPORT_MAX_ROWS).default(CSV_EXPORT_MAX_ROWS) });

function ruleFromRow(row: typeof rulesTable.$inferSelect): ClassificationRule & { entityId: string | null; accountId: string | null } {
  const match = row.match as { conditions?: unknown; kind?: unknown; confidence?: unknown };
  return {
    id: row.id,
    name: row.name,
    enabled: row.active,
    priority: row.priority,
    kind: match.kind === 'ownership' ? 'ownership' : 'general',
    conditions: (match.conditions as ClassificationRule['conditions']) ?? [],
    actions: row.action as ClassificationRule['actions'],
    confidence: (match.confidence as ClassificationRule['confidence']) ?? 'medium',
    entityId: row.entityId,
    accountId: row.accountId,
  };
}

async function transactionContext(req: FastifyRequest): Promise<TransactionContext> {
  const { db } = req.server.fos;
  const [settings, fx] = await Promise.all([loadSettings(db), loadFxTable(db)]);
  return { reportingCurrency: settings.reportingCurrency, fx };
}

/** Documents are stored encrypted; the plaintext never touches disk. */
function documentView(row: typeof documentsTable.$inferSelect): DocumentRecordType {
  return {
    id: row.id,
    fileName: row.fileName,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    kind: row.kind,
    accountId: row.accountId,
    entityId: row.entityId,
    uploadedAt: iso(row.uploadedAt),
    encrypted: true,
    note: row.note,
  };
}

export function registerMoneyRoutes(app: FastifyInstance): void {
  ownerRoutes(app, async (scope) => {
    await scope.register(multipart, {
      limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 12, fieldSize: 4096 },
      attachFieldsToBody: false,
    });

    // --- Entities -----------------------------------------------------------------------
    scope.get('/api/entities', async (req): Promise<{ items: Entity[] }> => {
      const rows = await req.server.fos.db.select().from(entitiesTable).where(isNull(entitiesTable.archivedAt)).orderBy(desc(entitiesTable.primaryOwner), asc(entitiesTable.name));
      return { items: rows.map(entityView) };
    });

    scope.post('/api/entities', async (req, reply): Promise<Entity> => {
      const input = parseBody(EntityInput, req.body);
      const { db } = req.server.fos;
      const [row] = await db
        .insert(entitiesTable)
        .values({
          name: input.name,
          kind: input.kind,
          jurisdiction: input.jurisdiction,
          baseCurrency: input.baseCurrency,
          ownerControlled: input.kind === 'third_party' ? false : input.ownerControlled,
          legalStatusConfirmed: input.legalStatusConfirmed,
          notes: input.notes,
          provenance: { source: 'owner', sourceKind: 'manual_entry', verified: false },
        })
        .returning();
      if (!row) throw new Error('entity insert returned no row');
      await audit(req, 'entity.created', { type: 'entity', id: row.id }, `Entity created (${row.kind})`, { kind: row.kind });
      reply.code(201);
      return entityView(row);
    });

    scope.patch<{ Params: { id: string } }>('/api/entities/:id', async (req): Promise<Entity> => {
      const id = requireUuid(req.params.id, 'entity_not_found');
      const input = parseBody(EntityInput.partial(), req.body);
      const { db } = req.server.fos;
      const [row] = await db
        .update(entitiesTable)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
          ...(input.baseCurrency !== undefined ? { baseCurrency: input.baseCurrency } : {}),
          ...(input.ownerControlled !== undefined ? { ownerControlled: input.ownerControlled } : {}),
          ...(input.legalStatusConfirmed !== undefined ? { legalStatusConfirmed: input.legalStatusConfirmed } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          updatedAt: req.server.fos.clock.now(),
        })
        .where(eq(entitiesTable.id, id))
        .returning();
      if (!row) throw errors.notFound('entity_not_found', 'Entity not found.');
      await audit(req, 'entity.updated', { type: 'entity', id: row.id }, 'Entity updated', { fields: Object.keys(input) });
      return entityView(row);
    });

    // --- Institutions -------------------------------------------------------------------
    scope.get('/api/institutions', async (req): Promise<{ items: Institution[] }> => {
      const rows = await req.server.fos.db.select().from(institutionsTable).orderBy(asc(institutionsTable.name));
      return { items: rows.map(institutionView) };
    });

    scope.post('/api/institutions', async (req, reply): Promise<Institution> => {
      const input = parseBody(
        z.object({
          name: z.string().min(1).max(120),
          country: z.string().max(60).nullable(),
          kind: z.enum(['bank', 'broker', 'wallet', 'fund', 'issuer', 'lender', 'other']),
          providerKey: z.string().max(64).nullable(),
        }),
        req.body,
      );
      const [row] = await req.server.fos.db.insert(institutionsTable).values(input).returning();
      if (!row) throw new Error('institution insert returned no row');
      await audit(req, 'institution.created', { type: 'institution', id: row.id }, 'Institution created');
      reply.code(201);
      return institutionView(row);
    });

    // --- Accounts -----------------------------------------------------------------------
    const accountBundles = async (req: FastifyRequest, ids?: string[]) => {
      const { db, clock } = req.server.fos;
      const [settings, fx] = await Promise.all([loadSettings(db), loadFxTable(db)]);
      return loadAccountBundles(db, {
        ...(ids ? { accountIds: ids } : {}),
        includeClosed: true,
        fx,
        now: clock.now(),
        staleAfterHours: settings.staleAfterHours,
        reportingCurrency: settings.reportingCurrency,
      });
    };

    scope.get('/api/accounts', async (req): Promise<{ items: Account[] }> => {
      const query = parseQuery(z.object({ entityId: z.uuid().optional() }), req.query);
      const bundles = await accountBundles(req);
      const filtered = query.entityId ? bundles.filter((b) => b.row.legalEntityId === query.entityId || b.row.economicOwnerEntityId === query.entityId) : bundles;
      return { items: filtered.map((b) => b.account) };
    });

    scope.post('/api/accounts', async (req, reply): Promise<Account> => {
      const input = parseBody(AccountInput, req.body);
      const { db } = req.server.fos;
      const [row] = await db
        .insert(accountsTable)
        .values({
          name: input.name,
          kind: input.kind,
          currency: input.currency,
          institutionId: input.institutionId,
          legalEntityId: input.legalEntityId,
          economicOwnerEntityId: input.economicOwnerEntityId,
          ownershipConfirmed: input.ownershipConfirmed,
          liquidityClass: input.liquidityClass,
          includeInSafeToSpend: input.includeInSafeToSpend,
          maskedIdentifier: input.maskedIdentifier,
          notes: input.notes,
          createdFrom: 'user',
          provenance: { source: 'owner', sourceKind: 'manual_entry', verified: false },
        })
        .returning();
      if (!row) throw new Error('account insert returned no row');
      await audit(req, 'account.created', { type: 'account', id: row.id }, `Account created (${row.kind})`, { liquidityClass: row.liquidityClass });
      reply.code(201);
      const [bundle] = await accountBundles(req, [row.id]);
      if (!bundle) throw new Error('account vanished after insert');
      return bundle.account;
    });

    scope.get<{ Params: { id: string } }>('/api/accounts/:id', async (req): Promise<Account> => {
      const id = requireUuid(req.params.id, 'account_not_found');
      const [bundle] = await accountBundles(req, [id]);
      if (!bundle) throw errors.notFound('account_not_found', 'Account not found.');
      return bundle.account;
    });

    scope.patch<{ Params: { id: string } }>('/api/accounts/:id', async (req): Promise<Account> => {
      const id = requireUuid(req.params.id, 'account_not_found');
      const input = parseBody(AccountInput.partial(), req.body);
      const { db, clock } = req.server.fos;
      const [row] = await db
        .update(accountsTable)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.institutionId !== undefined ? { institutionId: input.institutionId } : {}),
          ...(input.legalEntityId !== undefined ? { legalEntityId: input.legalEntityId } : {}),
          ...(input.economicOwnerEntityId !== undefined ? { economicOwnerEntityId: input.economicOwnerEntityId } : {}),
          ...(input.ownershipConfirmed !== undefined ? { ownershipConfirmed: input.ownershipConfirmed } : {}),
          ...(input.liquidityClass !== undefined ? { liquidityClass: input.liquidityClass } : {}),
          ...(input.includeInSafeToSpend !== undefined ? { includeInSafeToSpend: input.includeInSafeToSpend } : {}),
          ...(input.maskedIdentifier !== undefined ? { maskedIdentifier: input.maskedIdentifier } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          updatedAt: clock.now(),
        })
        .where(eq(accountsTable.id, id))
        .returning();
      if (!row) throw errors.notFound('account_not_found', 'Account not found.');
      await audit(req, 'account.updated', { type: 'account', id: row.id }, 'Account updated', { fields: Object.keys(input) });
      const [bundle] = await accountBundles(req, [id]);
      if (!bundle) throw errors.notFound('account_not_found', 'Account not found.');
      return bundle.account;
    });

    scope.get<{ Params: { id: string } }>('/api/accounts/:id/snapshots', async (req) => {
      const id = requireUuid(req.params.id, 'account_not_found');
      const query = parseQuery(SnapshotQuery, req.query);
      const rows = await req.server.fos.db
        .select()
        .from(balanceSnapshots)
        .where(eq(balanceSnapshots.accountId, id))
        .orderBy(desc(balanceSnapshots.reportedAt))
        .limit(query.limit);
      return { items: rows.map(snapshotView) };
    });

    scope.post<{ Params: { id: string } }>('/api/accounts/:id/snapshots', async (req, reply) => {
      const id = requireUuid(req.params.id, 'account_not_found');
      const input = parseBody(BalanceSnapshotInput, req.body);
      if (input.accountId !== id) throw errors.badRequest('The snapshot account does not match the URL.');
      const { db, clock } = req.server.fos;
      await loadOne(db.select({ id: accountsTable.id }).from(accountsTable).where(eq(accountsTable.id, id)).limit(1), 'account_not_found', 'Account not found.');
      const [row] = await db
        .insert(balanceSnapshots)
        .values({
          accountId: id,
          kind: input.kind,
          amount: input.balance.amount,
          currency: input.balance.currency,
          reportedAt: clock.now(),
          sourceAsOf: input.sourceAsOf ? new Date(input.sourceAsOf) : null,
          approximate: input.approximate,
          completeness: input.completeness,
          source: input.source,
          documentId: input.documentId,
          provenance: { source: input.source, sourceKind: 'owner_reported', verified: false },
        })
        .returning();
      if (!row) throw new Error('snapshot insert returned no row');
      await audit(req, 'balance_snapshot.created', { type: 'account', id }, `Balance snapshot recorded (${input.kind})`, { kind: input.kind, currency: input.balance.currency });
      reply.code(201);
      return snapshotView(row);
    });

    scope.get<{ Params: { id: string } }>('/api/accounts/:id/holdings', async (req): Promise<Holdings> => {
      const id = requireUuid(req.params.id, 'account_not_found');
      const holdings = await loadHoldings(req.server.fos.db, [id], 1);
      return holdingsView(id, holdings.get(id)?.[0]);
    });

    scope.get<{ Params: { id: string } }>('/api/accounts/:id/reconciliations', async (req): Promise<{ items: Reconciliation[] }> => {
      const id = requireUuid(req.params.id, 'account_not_found');
      const rows = await req.server.fos.db
        .select()
        .from(reconciliations)
        .where(eq(reconciliations.accountId, id))
        .orderBy(desc(reconciliations.periodEnd))
        .limit(100);
      return {
        items: rows.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          openingBalance: row.openingBalance === null ? null : { amount: normalizeDecimal(row.openingBalance), currency: row.currency },
          movements: { amount: normalizeDecimal(row.movements), currency: row.currency },
          expectedClosing: row.expectedClosing === null ? null : { amount: normalizeDecimal(row.expectedClosing), currency: row.currency },
          actualClosing: row.actualClosing === null ? null : { amount: normalizeDecimal(row.actualClosing), currency: row.currency },
          difference: row.difference === null ? null : { amount: normalizeDecimal(row.difference), currency: row.currency },
          status: row.status,
          batchId: row.batchId,
          resolvedAt: iso(row.resolvedAt),
          resolution: row.resolution,
        })),
      };
    });

    scope.get<{ Params: { id: string } }>('/api/accounts/:id/coverage', async (req): Promise<{ gaps: CoverageGap[]; periods: Array<{ from: string; to: string; source: string; complete: boolean }> }> => {
      const id = requireUuid(req.params.id, 'account_not_found');
      const { db, clock } = req.server.fos;
      const settings = await loadSettings(db);
      const today = reportingToday(settings, clock.now());
      const rows = await db
        .select()
        .from(coveragePeriods)
        .where(and(eq(coveragePeriods.accountId, id), eq(coveragePeriods.active, true)))
        .orderBy(asc(coveragePeriods.fromDate))
        .limit(1000);
      const report = detectCoverageGaps({
        accountId: id,
        periods: rows.map((r) => ({ from: r.fromDate, to: r.toDate, source: r.source, complete: r.complete })),
        window: coverageWindow(today, 24),
      });
      return {
        gaps: report.gaps,
        periods: rows.map((r) => ({ from: r.fromDate, to: r.toDate, source: r.source, complete: r.complete })),
      };
    });

    // --- Transactions -------------------------------------------------------------------
    scope.get('/api/transactions', async (req): Promise<TransactionPage> => {
      const query = parseQuery(TransactionQuery, req.query);
      const ctx = await transactionContext(req);
      return loadTransactionPage(req.server.fos.db, query, ctx);
    });

    scope.get<{ Params: { id: string } }>('/api/transactions/:id', async (req) => {
      const id = requireUuid(req.params.id, 'transaction_not_found');
      const ctx = await transactionContext(req);
      const transaction = await loadTransaction(req.server.fos.db, id, ctx);
      if (!transaction) throw errors.notFound('transaction_not_found', 'Transaction not found.');
      return { transaction, history: await classificationHistory(req.server.fos.db, id) };
    });

    scope.post<{ Params: { id: string } }>('/api/transactions/:id/classify', async (req): Promise<Transaction> => {
      const id = requireUuid(req.params.id, 'transaction_not_found');
      const input = parseBody(ClassificationInput, req.body);
      const { db, clock } = req.server.fos;
      const session = req.session;
      const ctx = await transactionContext(req);
      const existing = await loadTransaction(db, id, ctx);
      if (!existing) throw errors.notFound('transaction_not_found', 'Transaction not found.');
      const outcome = await db.transaction(async (tx) => {
        const applied = await applyOwnerClassification(tx, id, input, { at: clock.now(), createdBy: `session:${session?.id ?? 'owner'}` });
        if (applied.applied && input.createRule && (input.createRule.matchDescription || input.createRule.matchCounterparty)) {
          const conditions = [
            ...(input.createRule.matchDescription ? [{ kind: 'description', op: 'contains', value: input.createRule.matchDescription }] : []),
            ...(input.createRule.matchCounterparty ? [{ kind: 'counterparty', op: 'contains', value: input.createRule.matchCounterparty }] : []),
          ];
          await tx.insert(rulesTable).values({
            name: `From transaction ${id.slice(0, 8)}`,
            priority: 100,
            active: true,
            match: { kind: 'general', confidence: 'medium', conditions },
            action: { categoryId: input.categoryId, nature: input.nature, ...(input.economicOwnerEntityId ? { economicOwnerEntityId: input.economicOwnerEntityId } : {}) },
            createdFrom: 'user',
          });
        }
        return applied;
      });
      await audit(req, 'transaction.classified', { type: 'transaction', id }, `Transaction classified as ${input.nature}`, {
        nature: input.nature,
        applied: outcome.applied,
        version: outcome.version,
        ruleCreated: Boolean(input.createRule),
      });
      const updated = await loadTransaction(db, id, ctx);
      if (!updated) throw errors.notFound('transaction_not_found', 'Transaction not found.');
      return updated;
    });

    scope.post<{ Params: { id: string } }>('/api/transfer-matches/:id', async (req) => {
      const id = requireUuid(req.params.id, 'transfer_match_not_found');
      const input = parseBody(z.object({ action: z.enum(['confirm', 'reject']) }), req.body);
      const { db, clock } = req.server.fos;
      const [row] = await db
        .update(transferMatches)
        .set({ status: input.action === 'confirm' ? 'confirmed' : 'rejected', decidedAt: clock.now(), decidedBy: 'owner' })
        .where(eq(transferMatches.id, id))
        .returning();
      if (!row) throw errors.notFound('transfer_match_not_found', 'Transfer match not found.');
      await audit(req, 'transfer_match.decided', { type: 'transfer_match', id }, `Transfer match ${input.action}ed`, { action: input.action });
      return { id: row.id, status: row.status, fromTransactionId: row.fromSourceRecordId, toTransactionId: row.toSourceRecordId, confidence: row.confidence };
    });

    // --- CSV export ---------------------------------------------------------------------
    scope.get('/api/transactions/export.csv', async (req, reply) => {
      const query = parseQuery(ExportQuery, req.query);
      const { db } = req.server.fos;
      const ctx = await transactionContext(req);
      const headers = [
        'id',
        'booked_on',
        'value_on',
        'account',
        'description',
        'counterparty',
        'amount',
        'currency',
        'nature',
        'category',
        'status',
        'classification_method',
        'needs_review',
      ];
      const writer = new CsvWriter(headers, { numericColumns: ['amount'] });
      let remaining = query.limit;
      let cursor: string | null = query.cursor ?? null;
      const rows: Transaction[] = [];
      while (remaining > 0) {
        const page: TransactionPage = await loadTransactionPage(db, { ...query, limit: Math.min(200, remaining), ...(cursor ? { cursor } : {}) }, ctx);
        rows.push(...page.items);
        remaining -= page.items.length;
        cursor = page.nextCursor;
        if (!cursor || page.items.length === 0) break;
      }
      await audit(req, 'export.transactions_csv', { type: 'transactions' }, 'Transactions exported as CSV', { rows: rows.length, filters: Object.keys(query) });
      // Re-check the session immediately before any bytes leave the server.
      const body = rows.reduce(
        (acc, t) =>
          acc +
          writer.row([
            t.id,
            t.bookedOn,
            t.valueOn,
            t.accountName,
            t.description,
            t.counterparty,
            t.amount.amount,
            t.amount.currency,
            t.nature,
            t.category?.name ?? null,
            t.status,
            t.classification.method,
            t.classification.needsReview ? 'yes' : 'no',
          ]),
        writer.header(),
      );
      return sendSessionBoundDownload(req, reply, {
        stream: Readable.from([Buffer.from(body, 'utf8')]),
        filename: 'transactions.csv',
        contentType: 'text/csv; charset=utf-8',
        size: Buffer.byteLength(body, 'utf8'),
      });
    });

    // --- Categories and rules ------------------------------------------------------------
    scope.get('/api/categories', async (req): Promise<{ items: Category[] }> => {
      const rows = await req.server.fos.db.select().from(categoriesTable).where(isNull(categoriesTable.archivedAt)).orderBy(asc(categoriesTable.name)).limit(1000);
      return { items: rows.map((row) => ({ id: row.id, parentId: row.parentId, name: row.name, kind: row.kind, essential: row.essential })) };
    });

    scope.post('/api/categories', async (req, reply): Promise<Category> => {
      const input = parseBody(CategoryInput, req.body);
      const [row] = await req.server.fos.db.insert(categoriesTable).values(input).returning();
      if (!row) throw new Error('category insert returned no row');
      await audit(req, 'category.created', { type: 'category', id: row.id }, 'Category created');
      reply.code(201);
      return { id: row.id, parentId: row.parentId, name: row.name, kind: row.kind, essential: row.essential };
    });

    scope.get('/api/rules', async (req) => {
      const rows = await req.server.fos.db.select().from(rulesTable).orderBy(desc(rulesTable.priority), asc(rulesTable.name)).limit(500);
      return { items: rows.map((row) => ({ ...ruleFromRow(row), hitCount: row.hitCount, lastHitAt: iso(row.lastHitAt) })) };
    });

    scope.post('/api/rules', async (req, reply) => {
      const input = parseBody(RuleInput, req.body);
      const candidate = { id: randomUUID(), name: input.name, enabled: input.active, priority: input.priority, kind: input.kind, conditions: input.conditions, actions: input.actions, confidence: input.confidence } as ClassificationRule;
      const issues = validateRule(candidate);
      if (issues.length > 0) throw errors.badRequest('The rule is not valid.', { issues });
      const [row] = await req.server.fos.db
        .insert(rulesTable)
        .values({
          name: input.name,
          priority: input.priority,
          active: input.active,
          match: { kind: input.kind, confidence: input.confidence, conditions: input.conditions },
          action: input.actions,
          entityId: input.entityId,
          accountId: input.accountId,
          createdFrom: 'user',
        })
        .returning();
      if (!row) throw new Error('rule insert returned no row');
      await audit(req, 'rule.created', { type: 'rule', id: row.id }, `Classification rule created (${row.name})`);
      reply.code(201);
      return ruleFromRow(row);
    });

    scope.patch('/api/rules', async (req) => {
      const input = parseBody(RulePatch, req.body);
      const { db, clock } = req.server.fos;
      const existing = await loadOne(db.select().from(rulesTable).where(eq(rulesTable.id, input.id)).limit(1), 'rule_not_found', 'Rule not found.');
      const current = ruleFromRow(existing);
      const merged = {
        id: existing.id,
        name: input.name ?? current.name,
        enabled: input.active ?? current.enabled,
        priority: input.priority ?? current.priority,
        kind: input.kind ?? current.kind,
        conditions: input.conditions ?? current.conditions,
        actions: input.actions ?? current.actions,
        confidence: input.confidence ?? current.confidence,
      } as ClassificationRule;
      const issues = validateRule(merged);
      if (issues.length > 0) throw errors.badRequest('The rule is not valid.', { issues });
      const [row] = await db
        .update(rulesTable)
        .set({
          name: merged.name,
          priority: merged.priority,
          active: merged.enabled,
          match: { kind: merged.kind, confidence: merged.confidence, conditions: merged.conditions },
          action: merged.actions as unknown as Record<string, unknown>,
          ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
          ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
          updatedAt: clock.now(),
        })
        .where(eq(rulesTable.id, input.id))
        .returning();
      if (!row) throw errors.notFound('rule_not_found', 'Rule not found.');
      await audit(req, 'rule.updated', { type: 'rule', id: row.id }, `Classification rule updated (${row.name})`);
      return ruleFromRow(row);
    });

    // --- Portfolio, restrictions, fixed income --------------------------------------------
    scope.get('/api/portfolio', async (req): Promise<PortfolioSummary> => {
      const query = parseQuery(z.object({ currency: z.string().regex(/^[A-Z0-9]{2,10}$/).optional() }), req.query);
      const base = await financeBase(req);
      return loadPortfolio(req.server.fos.db, {
        accounts: base.accounts,
        currency: query.currency ?? base.settings.reportingCurrency,
        asOf: base.today,
        from: shiftDays(base.today, -365),
        fx: base.fx,
      });
    });

    scope.get('/api/restrictions', async (req) => {
      const query = parseQuery(z.object({ accountId: z.uuid().optional() }), req.query);
      return { items: await listRestrictions(req.server.fos.db, query.accountId) };
    });

    scope.post('/api/restrictions', async (req, reply) => {
      const input = parseBody(RestrictionInput, req.body);
      const { db, clock } = req.server.fos;
      const [row] = await db
        .insert(restrictionsTable)
        .values({
          accountId: input.accountId,
          instrumentId: input.instrumentId,
          kind: input.kind,
          status: input.status,
          terms: input.terms as Record<string, unknown>,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          documentId: input.documentId,
          notes: input.notes,
          verifiedAt: input.status === 'verified' ? clock.now() : null,
        })
        .returning();
      if (!row) throw new Error('restriction insert returned no row');
      await audit(req, 'restriction.created', { type: 'account', id: input.accountId }, `Restriction recorded (${row.kind}, ${row.status})`);
      reply.code(201);
      return restrictionView(row);
    });

    scope.patch('/api/restrictions', async (req) => {
      const input = parseBody(RestrictionPatch.extend({ id: z.uuid() }), req.body);
      const { db, clock } = req.server.fos;
      const [row] = await db
        .update(restrictionsTable)
        .set({
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.status !== undefined ? { status: input.status, verifiedAt: input.status === 'verified' ? clock.now() : null } : {}),
          ...(input.terms !== undefined ? { terms: input.terms as Record<string, unknown> } : {}),
          ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
          ...(input.effectiveTo !== undefined ? { effectiveTo: input.effectiveTo } : {}),
          ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          updatedAt: clock.now(),
        })
        .where(eq(restrictionsTable.id, input.id))
        .returning();
      if (!row) throw errors.notFound('restriction_not_found', 'Restriction not found.');
      await audit(req, 'restriction.updated', { type: 'account', id: row.accountId }, `Restriction updated (${row.status})`);
      return restrictionView(row);
    });

    scope.post('/api/restricted/sale-schedule', async (req): Promise<SaleScheduleResult> => {
      const input = parseBody(SaleScheduleRequest, req.body);
      const { db, clock } = req.server.fos;
      const settings = await loadSettings(db);
      const today = reportingToday(settings, clock.now());
      const options = await saleScheduleOptions(db, input.accountId, today, null);
      return planRestrictedSale(input, options);
    });

    scope.get<{ Params: { id: string } }>('/api/accounts/:id/fixed-income', async (req): Promise<FixedIncomeTerms> => {
      const id = requireUuid(req.params.id, 'account_not_found');
      const bundle = await fixedIncomeFor(req.server.fos.db, id);
      if (!bundle) throw errors.notFound('fixed_income_not_recorded', 'No fixed-income terms are recorded for this account.');
      return bundle.terms;
    });

    scope.put<{ Params: { id: string } }>('/api/accounts/:id/fixed-income', async (req): Promise<FixedIncomeTerms> => {
      const id = requireUuid(req.params.id, 'account_not_found');
      const input = parseBody(FixedIncomeTerms.omit({ accountId: true }), req.body);
      const { db, clock } = req.server.fos;
      const values = {
        accountId: id,
        principal: input.principal?.amount ?? null,
        currency: input.principal?.currency ?? null,
        statedAnnualRate: input.statedAnnualRate,
        rateBasis: input.rateBasis,
        compounding: input.compounding,
        fees: input.fees,
        withdrawalTerms: input.withdrawalTerms,
        counterpartyName: input.counterparty,
        startDate: input.startDate,
        maturityDate: input.maturityDate,
        verified: input.verified,
        updatedAt: clock.now(),
      };
      await db.insert(fixedIncomeTable).values(values).onConflictDoUpdate({ target: fixedIncomeTable.accountId, set: values });
      await audit(req, 'fixed_income.updated', { type: 'account', id }, `Fixed-income terms recorded (${input.rateBasis})`, { verified: input.verified });
      const bundle = await fixedIncomeFor(db, id);
      if (!bundle) throw new Error('fixed income vanished after write');
      return bundle.terms;
    });

    scope.get<{ Params: { id: string } }>('/api/accounts/:id/interest-projection', async (req): Promise<InterestProjection> => {
      const id = requireUuid(req.params.id, 'account_not_found');
      const query = parseQuery(InterestQuery, req.query);
      const base = await financeBase(req);
      const bundle = base.accounts.find((b) => b.row.id === id);
      const value = bundle?.account.valuation.value;
      const balance = value && value.amount !== null && value.currency !== null ? { amount: value.amount, currency: value.currency } : null;
      const projection = await interestProjectionFor(req.server.fos.db, {
        accountId: id,
        asOf: base.today,
        months: query.months,
        balance,
        from: shiftDays(base.today, -365),
      });
      if (!projection) throw errors.notFound('fixed_income_not_recorded', 'No fixed-income terms are recorded for this account.');
      return projection;
    });

    // --- Watch events --------------------------------------------------------------------
    scope.get('/api/watch-events', async (req) => {
      const rows = await listWatchEvents(req.server.fos.db);
      return {
        items: rows.map((row) => ({
          id: row.id,
          instrumentId: row.instrumentId,
          accountId: row.accountId,
          kind: row.kind,
          title: row.title,
          status: row.status,
          expectedDate: row.expectedDate,
          notes: row.notes,
          sourceUrl: row.sourceUrl,
        })),
      };
    });

    scope.post('/api/watch-events', async (req, reply) => {
      const input = parseBody(WatchEventInput, req.body);
      const [row] = await req.server.fos.db.insert(watchEvents).values(input).returning();
      if (!row) throw new Error('watch event insert returned no row');
      await audit(req, 'watch_event.created', { type: 'watch_event', id: row.id }, `Watch event recorded (${row.kind}) — unverified until confirmed`);
      reply.code(201);
      return { id: row.id, instrumentId: row.instrumentId, accountId: row.accountId, kind: row.kind, title: row.title, status: row.status, expectedDate: row.expectedDate, notes: row.notes, sourceUrl: row.sourceUrl };
    });

    scope.patch('/api/watch-events', async (req) => {
      const input = parseBody(WatchEventPatch, req.body);
      const { id, ...rest } = input;
      const [row] = await req.server.fos.db
        .update(watchEvents)
        .set({ ...rest, updatedAt: req.server.fos.clock.now() })
        .where(eq(watchEvents.id, id))
        .returning();
      if (!row) throw errors.notFound('watch_event_not_found', 'Watch event not found.');
      await audit(req, 'watch_event.updated', { type: 'watch_event', id }, `Watch event updated (${row.status})`);
      return { id: row.id, instrumentId: row.instrumentId, accountId: row.accountId, kind: row.kind, title: row.title, status: row.status, expectedDate: row.expectedDate, notes: row.notes, sourceUrl: row.sourceUrl };
    });

    // --- Documents ------------------------------------------------------------------------
    scope.get('/api/documents', async (req): Promise<{ items: DocumentRecordType[] }> => {
      const query = parseQuery(DocumentQuery, req.query);
      const conditions = [];
      if (query.accountId) conditions.push(eq(documentsTable.accountId, query.accountId));
      if (query.entityId) conditions.push(eq(documentsTable.entityId, query.entityId));
      const rows = await req.server.fos.db
        .select()
        .from(documentsTable)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(documentsTable.uploadedAt))
        .limit(query.limit);
      return { items: rows.map(documentView) };
    });

    scope.post('/api/documents', async (req, reply): Promise<DocumentRecordType> => {
      const { db, config, keyring, clock } = req.server.fos;
      const file = await req.file();
      if (!file) throw errors.badRequest('Send the document as a multipart file field.');
      const mime = file.mimetype || 'application/octet-stream';
      if (!ALLOWED_DOCUMENT_MIME.has(mime)) throw errors.badRequest('That file type is not accepted.', { mime });
      const fields = file.fields as Record<string, { value?: unknown } | undefined>;
      const fieldValue = (name: string): string | null => {
        const raw = fields?.[name]?.value;
        return typeof raw === 'string' && raw.length > 0 ? raw : null;
      };
      const kindRaw = fieldValue('kind') ?? 'other';
      const kind = (['statement', 'agreement', 'valuation', 'tax', 'invoice', 'other'] as const).includes(kindRaw as 'other') ? (kindRaw as DocumentRecordType['kind']) : 'other';
      const accountId = fieldValue('accountId');
      const entityId = fieldValue('entityId');
      const note = fieldValue('note');
      if (accountId) requireUuid(accountId, 'account_not_found');
      if (entityId) requireUuid(entityId, 'entity_not_found');

      await mkdir(config.documentsDir, { recursive: true });
      const id = randomUUID();
      const storageKey = `${id}.enc`;
      const target = join(config.documentsDir, storageKey);
      const hash = createHash('sha256');
      let size = 0;
      const source = Readable.from(
        (async function* () {
          for await (const chunk of file.file) {
            const buf = chunk as Buffer;
            size += buf.length;
            if (size > MAX_DOCUMENT_BYTES) throw errors.badRequest('The document is larger than the 25 MB limit.');
            hash.update(buf);
            yield buf;
          }
        })(),
      );
      try {
        // The plaintext is never written to disk: it is encrypted as it streams through.
        await pipeline(source, keyring.createEncryptStream({ aad: `document:${id}` }), createWriteStream(target, { mode: 0o600 }));
      } catch (err) {
        await unlink(target).catch(() => undefined);
        throw err;
      }
      if (file.file.truncated) {
        await unlink(target).catch(() => undefined);
        throw errors.badRequest('The document is larger than the 25 MB limit.');
      }
      const sha256 = hash.digest('hex');
      // The wrapped data key also lives in the file header; recording it makes key rotation auditable.
      const handle = await open(target, 'r');
      let wrappedDek = '';
      let keyVersion = keyring.activeKid;
      try {
        const head = Buffer.alloc(128);
        const { bytesRead } = await handle.read(head, 0, 128, 0);
        const kidLen = head[7] ?? 0;
        if (bytesRead >= 8 + kidLen + 60) {
          keyVersion = head.subarray(8, 8 + kidLen).toString('ascii');
          wrappedDek = head.subarray(8 + kidLen, 8 + kidLen + 60).toString('base64url');
        }
      } finally {
        await handle.close();
      }

      const existing = await db.select().from(documentsTable).where(eq(documentsTable.sha256, sha256)).limit(1);
      if (existing[0]) {
        await unlink(target).catch(() => undefined);
        reply.code(200);
        return documentView(existing[0]);
      }
      const [row] = await db
        .insert(documentsTable)
        .values({
          id,
          fileName: file.filename.slice(0, 200),
          mime,
          sizeBytes: size,
          sha256,
          storageKey,
          wrappedDek,
          keyVersion,
          kind,
          accountId,
          entityId,
          note,
          source: 'upload',
          uploadedAt: clock.now(),
        })
        .returning();
      if (!row) throw new Error('document insert returned no row');
      await audit(req, 'document.uploaded', { type: 'document', id: row.id }, `Document uploaded (${kind})`, { mime, sizeBytes: size, sha256 });
      reply.code(201);
      return documentView(row);
    });

    scope.get<{ Params: { id: string } }>('/api/documents/:id/download', async (req, reply) => {
      const id = requireUuid(req.params.id, 'document_not_found');
      const { db, config, keyring } = req.server.fos;
      const row = await loadOne(db.select().from(documentsTable).where(eq(documentsTable.id, id)).limit(1), 'document_not_found', 'Document not found.');
      const path = join(config.documentsDir, row.storageKey);
      try {
        await stat(path);
      } catch {
        throw errors.notFound('document_file_missing', 'The stored file for this document is not on this server.');
      }
      // The session is re-checked here and again by sendSessionBoundDownload before any byte flows.
      await assertSessionStillValid(req, reply);
      await audit(req, 'document.downloaded', { type: 'document', id }, 'Document downloaded');
      const plain = createReadStream(path).pipe(keyring.createDecryptStream({ aad: `document:${id}` }));
      return sendSessionBoundDownload(req, reply, {
        stream: plain,
        filename: row.fileName,
        contentType: row.mime,
      });
    });
  });
}

export { DocumentRecord, sql };
