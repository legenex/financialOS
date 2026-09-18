/**
 * Today, safe-to-spend, runway and wealth.
 *
 * Each handler loads inputs through the read-model layer and hands them to @financialos/domain.
 * When inputs are missing the engine returns `provisional` or `insufficient_data` with a null
 * amount; these handlers never substitute a number of their own.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RunwayResult, SafeToSpendResult, TodayResponse, WealthSummary } from '@financialos/contracts';
import type { WealthScope } from '@financialos/domain';
import { errors } from '../../errors';
import { parseQuery } from '../../validation';
import { allRunways, buildToday, safeToSpendFor, wealthFor } from '../../data/finance';
import { ScopeQuery, financeBase, ownerRoutes } from './_shared';

const SafeToSpendQuery = z.object({
  horizonDays: z.coerce.number().int().min(1).max(365).optional(),
  scenarioId: z.uuid().optional(),
});

const TodayQuery = z.object({ scenarioId: z.uuid().optional() });

export function registerTodayRoutes(app: FastifyInstance): void {
  ownerRoutes(app, (scope) => {
    scope.get('/api/today', async (req): Promise<TodayResponse> => {
      const query = parseQuery(TodayQuery, req.query);
      const base = await financeBase(req);
      return buildToday(req.server.fos, base, query.scenarioId ? { scenarioId: query.scenarioId } : {});
    });

    scope.get('/api/safe-to-spend', async (req): Promise<SafeToSpendResult> => {
      const query = parseQuery(SafeToSpendQuery, req.query);
      const base = await financeBase(req);
      return safeToSpendFor(req.server.fos, base, {
        ...(query.horizonDays !== undefined ? { horizonDays: query.horizonDays } : {}),
        ...(query.scenarioId ? { scenarioId: query.scenarioId } : {}),
      });
    });

    scope.get('/api/runway', async (req): Promise<{ items: RunwayResult[] }> => {
      const base = await financeBase(req);
      return { items: await allRunways(req.server.fos, base) };
    });

    scope.get('/api/wealth', async (req): Promise<WealthSummary> => {
      const query = parseQuery(ScopeQuery, req.query);
      const base = await financeBase(req);
      let wealthScope: WealthScope;
      if (query.scope === 'entity' || (query.entityId && query.scope !== 'consolidated' && query.scope !== 'personal')) {
        if (!query.entityId) throw errors.badRequest('An entityId is required for the entity scope.');
        if (!base.entityRows.some((e) => e.id === query.entityId)) throw errors.notFound('entity_not_found', 'Entity not found.');
        wealthScope = { kind: 'entity', entityId: query.entityId };
      } else if (query.scope === 'consolidated') {
        wealthScope = { kind: 'consolidated' };
      } else {
        wealthScope = { kind: 'personal' };
      }
      if (!base.primaryOwner && wealthScope.kind !== 'entity') {
        throw errors.conflict('owner_entity_missing', 'No primary owner entity is recorded yet, so wealth cannot be segmented.');
      }
      return wealthFor(base, wealthScope);
    });
  });
}
