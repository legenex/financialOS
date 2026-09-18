/**
 * Business: per-entity cash summaries, the consolidated economic view, the 13-week forecast,
 * receivables and payables, the third-party clearing account and the support tracker.
 *
 * Confirming a fee mode changes how every held allocation is treated, so it is re-applied by a
 * durable job rather than inline in the request.
 */
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ArrangementPolicyInput,
  ReceivablePayableInput,
  type ClearingAccountSummary,
  type ConsolidatedView,
  type EntityCashSummary,
  type CashForecast,
  type ReceivablePayable,
  type SupportTracker,
} from '@financialos/contracts';
import { receivablesPayables, thirdPartyArrangements } from '@financialos/db';
import { errors } from '../../errors';
import { parseBody, parseQuery } from '../../validation';
import { resolvePeriod, shiftDays } from '../../data/common';
import { consolidatedView, entityCashSummaries, forecastFor, supportTracker } from '../../data/finance';
import { listReceivableRows, receivableView } from '../../data/planning';
import { loadClearingSummaries } from '../../data/thirdparty';
import { audit, enqueueJob, financeBase, loadOne, ownerRoutes, requireUuid } from './_shared';

const IsoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PeriodQuery = z.object({ from: IsoDateString.optional(), to: IsoDateString.optional(), entityId: z.uuid().optional() });
const ConsolidatedQuery = PeriodQuery.extend({ entityIds: z.union([z.string(), z.array(z.string())]).optional() });
const ForecastQuery = z.object({ entityId: z.uuid().optional(), scenarioId: z.uuid().optional(), weeks: z.coerce.number().int().min(1).max(52).optional() });
const ReceivableQuery = z.object({ entityId: z.uuid().optional(), kind: z.enum(['receivable', 'payable']).optional() });

function entityIdList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : value.split(',');
  return raw.map((v) => v.trim()).filter((v) => /^[0-9a-f-]{36}$/i.test(v));
}

export function registerBusinessRoutes(app: FastifyInstance): void {
  ownerRoutes(app, (scope) => {
    scope.get('/api/business/entities', async (req): Promise<{ items: EntityCashSummary[] }> => {
      const query = parseQuery(PeriodQuery, req.query);
      const base = await financeBase(req);
      const period = resolvePeriod(query, base.today, 90);
      return {
        items: await entityCashSummaries(req.server.fos, base, {
          ...(query.entityId ? { entityIds: [query.entityId] } : {}),
          from: period.from,
          to: period.to,
        }),
      };
    });

    scope.get('/api/business/consolidated', async (req): Promise<ConsolidatedView> => {
      const query = parseQuery(ConsolidatedQuery, req.query);
      const base = await financeBase(req);
      const period = resolvePeriod(query, base.today, 90);
      const ids = entityIdList(query.entityIds);
      return consolidatedView(req.server.fos, base, { ...(ids.length > 0 ? { entityIds: ids } : {}), from: period.from, to: period.to });
    });

    scope.get('/api/business/forecast', async (req): Promise<CashForecast> => {
      const query = parseQuery(ForecastQuery, req.query);
      const base = await financeBase(req);
      if (query.entityId && !base.entityRows.some((e) => e.id === query.entityId)) throw errors.notFound('entity_not_found', 'Entity not found.');
      return forecastFor(req.server.fos, base, {
        entityId: query.entityId ?? null,
        ...(query.scenarioId ? { scenarioId: query.scenarioId } : {}),
        ...(query.weeks ? { weeks: query.weeks } : {}),
      });
    });

    scope.get('/api/business/receivables-payables', async (req): Promise<{ items: ReceivablePayable[] }> => {
      const query = parseQuery(ReceivableQuery, req.query);
      const rows = await listReceivableRows(req.server.fos.db, {
        ...(query.entityId ? { entityIds: [query.entityId] } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
      });
      return { items: rows.map(receivableView) };
    });

    scope.post('/api/business/receivables-payables', async (req, reply): Promise<ReceivablePayable> => {
      const input = parseBody(ReceivablePayableInput, req.body);
      const [row] = await req.server.fos.db
        .insert(receivablesPayables)
        .values({
          entityId: input.entityId,
          kind: input.kind,
          counterpartyName: input.counterparty,
          intercompanyEntityId: input.intercompanyEntityId,
          reference: input.reference,
          amount: input.amount,
          currency: input.currency,
          outstanding: input.outstanding ?? input.amount,
          issuedOn: input.issuedOn,
          dueOn: input.dueOn,
          expectedOn: input.expectedOn,
          probability: input.probability,
          status: input.status,
          category: input.category,
          source: 'manual',
        })
        .returning();
      if (!row) throw new Error('receivable insert returned no row');
      await audit(req, 'receivable.created', { type: 'receivable', id: row.id }, `${row.kind === 'receivable' ? 'Receivable' : 'Payable'} recorded`);
      reply.code(201);
      return receivableView(row);
    });

    scope.put('/api/business/receivables-payables', async (req): Promise<ReceivablePayable> => {
      const input = parseBody(ReceivablePayableInput.partial().extend({ id: z.uuid() }), req.body);
      const { db, clock } = req.server.fos;
      const { id, counterparty, outstanding, ...rest } = input;
      const [row] = await db
        .update(receivablesPayables)
        .set({
          ...rest,
          ...(counterparty !== undefined ? { counterpartyName: counterparty } : {}),
          ...(outstanding !== undefined && outstanding !== null ? { outstanding } : {}),
          updatedAt: clock.now(),
        })
        .where(eq(receivablesPayables.id, id))
        .returning();
      if (!row) throw errors.notFound('receivable_not_found', 'Receivable or payable not found.');
      await audit(req, 'receivable.updated', { type: 'receivable', id }, 'Receivable or payable updated');
      return receivableView(row);
    });

    scope.get('/api/business/clearing', async (req): Promise<{ items: ClearingAccountSummary[] }> => {
      const base = await financeBase(req);
      return { items: base.clearing.map((bundle) => bundle.summary) };
    });

    scope.put<{ Params: { arrangementId: string } }>('/api/business/clearing/:arrangementId/policy', async (req): Promise<{ jobId: string; arrangement: ClearingAccountSummary }> => {
      const arrangementId = requireUuid(req.params.arrangementId, 'arrangement_not_found');
      const input = parseBody(ArrangementPolicyInput, req.body);
      const { db, clock } = req.server.fos;
      const existing = await loadOne(
        db.select().from(thirdPartyArrangements).where(eq(thirdPartyArrangements.id, arrangementId)).limit(1),
        'arrangement_not_found',
        'Third-party arrangement not found.',
      );
      if (input.feeMode !== 'unconfirmed' && input.feeRate === null && existing.feeRate === null) {
        throw errors.badRequest('Record the fee rate before confirming how the fee is charged.');
      }
      const [row] = await db
        .update(thirdPartyArrangements)
        .set({
          feeMode: input.feeMode,
          feeModeConfirmed: input.feeMode !== 'unconfirmed',
          ...(input.feeRate !== null ? { feeRate: input.feeRate } : {}),
          feeRecipientEntityId: input.feeRecipientEntityId,
          ...(input.openingBalance !== null ? { openingBalance: input.openingBalance } : {}),
          ...(input.openingBalanceAsOf !== null ? { openingBalanceAsOf: input.openingBalanceAsOf } : {}),
          evidenceNote: input.evidenceNote,
          updatedAt: clock.now(),
        })
        .where(eq(thirdPartyArrangements.id, arrangementId))
        .returning();
      if (!row) throw errors.notFound('arrangement_not_found', 'Third-party arrangement not found.');
      // Held allocations are re-applied by the worker: the policy decides how every past receipt
      // is split, so it is never recomputed inline in a request.
      const { jobId } = await enqueueJob(req, {
        queue: 'reconcile.monthly',
        label: `Re-apply third-party fee policy (${row.id.slice(0, 8)})`,
        data: { reason: 'third_party_fee_policy', arrangementId, feeMode: input.feeMode },
        singletonKey: `third_party_policy:${arrangementId}`,
        idempotencyKey: `third_party_policy:${arrangementId}:${clock.now().toISOString()}`,
        subjectType: 'arrangement',
        subjectId: arrangementId,
        entityId: row.thirdPartyEntityId,
      });
      await audit(req, 'third_party.policy_changed', { type: 'arrangement', id: arrangementId }, `Third-party fee policy set to ${input.feeMode}`, {
        feeMode: input.feeMode,
        feeRateRecorded: input.feeRate !== null,
        jobId,
      });
      const base = await financeBase(req);
      const summary = base.clearing.find((bundle) => bundle.row.id === arrangementId)?.summary;
      if (!summary) {
        const [bundle] = await loadClearingSummaries(db, { fallbackCurrency: base.settings.reportingCurrency, arrangementIds: [arrangementId] });
        if (!bundle) throw errors.notFound('arrangement_not_found', 'Third-party arrangement not found.');
        return { jobId, arrangement: bundle.summary };
      }
      return { jobId, arrangement: summary };
    });

    scope.get('/api/business/support', async (req): Promise<SupportTracker> => {
      const query = parseQuery(PeriodQuery, req.query);
      const base = await financeBase(req);
      const period = resolvePeriod(query, base.today, 365);
      return supportTracker(req.server.fos, base, { from: period.from, to: period.to });
    });
  });
}

export { asc, shiftDays };
