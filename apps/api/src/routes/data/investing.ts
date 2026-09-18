/**
 * Investing: paper trade proposals, the risk policy and the execution status.
 *
 * There is no execution path anywhere in FinancialOS. `/api/execution-status` always reports live
 * execution as disabled together with everything that would have to exist first.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { TradeProposalInput, type ExecutionStatus, type RiskPolicy, type TradeProposal } from '@financialos/contracts';
import { instruments as instrumentsTable, paperFills, prices, riskPolicies, tradeProposals } from '@financialos/db';
import { dec, executionStatus, simulateTradeProposal, type TradePrice } from '@financialos/domain';
import { errors } from '../../errors';
import { parseBody, parseQuery } from '../../validation';
import { iso, normalizeDecimal, shiftDays } from '../../data/common';
import { loadPortfolio } from '../../data/portfolio';
import { audit, financeBase, loadOne, ownerRoutes, requireUuid } from './_shared';

const DEFAULT_RISK_POLICY = {
  maxPositionShare: '0.2',
  maxSingleOrderValueUsd: '10000',
  allowedInstrumentKinds: ['equity', 'etf', 'fund'],
} as const;

const RiskPolicyInput = z.object({
  maxPositionShare: z.string().regex(/^0?\.\d{1,18}$|^1(\.0+)?$/),
  maxSingleOrderValueUsd: z.string().regex(/^\d{1,20}(\.\d{1,18})?$/),
  allowedInstrumentKinds: z.array(z.string().max(40)).min(1).max(20),
});

function policyView(row: typeof riskPolicies.$inferSelect): RiskPolicy {
  return {
    maxPositionShare: normalizeDecimal(row.maxPositionShare),
    maxSingleOrderValueUsd: normalizeDecimal(row.maxSingleOrderValueUsd),
    allowedInstrumentKinds: row.allowedInstrumentKinds,
    leverageAllowed: false,
    version: row.version,
    updatedAt: iso(row.createdAt),
  };
}

function proposalView(row: typeof tradeProposals.$inferSelect, fill: typeof paperFills.$inferSelect | undefined): TradeProposal {
  return {
    id: row.id,
    mode: 'paper',
    instrument: row.instrument,
    side: row.side,
    quantity: normalizeDecimal(row.quantity),
    limitPrice: normalizeDecimal(row.limitPrice),
    currency: row.currency,
    rationale: row.rationale,
    createdBy: row.createdBy,
    riskChecks: row.riskChecks,
    status: row.status,
    paperFill: fill ? { price: normalizeDecimal(fill.price), at: iso(fill.filledAt), priceSource: fill.priceSource } : null,
    createdAt: iso(row.createdAt),
  };
}

export function registerInvestingRoutes(app: FastifyInstance): void {
  ownerRoutes(app, (scope) => {
    scope.get('/api/trade-proposals', async (req): Promise<{ items: TradeProposal[] }> => {
      const query = parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
      const { db } = req.server.fos;
      const rows = await db.select().from(tradeProposals).orderBy(desc(tradeProposals.createdAt)).limit(query.limit);
      if (rows.length === 0) return { items: [] };
      const fills = await db.select().from(paperFills).where(inArray(paperFills.proposalId, rows.map((r) => r.id)));
      const fillByProposal = new Map(fills.map((f) => [f.proposalId, f]));
      return { items: rows.map((row) => proposalView(row, fillByProposal.get(row.id))) };
    });

    scope.post('/api/trade-proposals', async (req, reply): Promise<TradeProposal> => {
      const input = parseBody(TradeProposalInput, req.body);
      const { db, clock } = req.server.fos;
      const base = await financeBase(req);
      const now = clock.now();

      const [policyRow] = await db.select().from(riskPolicies).where(eq(riskPolicies.isCurrent, true)).limit(1);
      const policy = policyRow
        ? { maxPositionShare: normalizeDecimal(policyRow.maxPositionShare), maxSingleOrderValueUsd: normalizeDecimal(policyRow.maxSingleOrderValueUsd), allowedInstrumentKinds: policyRow.allowedInstrumentKinds, leverageAllowed: false as const }
        : { ...DEFAULT_RISK_POLICY, allowedInstrumentKinds: [...DEFAULT_RISK_POLICY.allowedInstrumentKinds], leverageAllowed: false as const };

      const symbol = input.instrument.trim().toUpperCase();
      const [instrument] = await db.select().from(instrumentsTable).where(eq(instrumentsTable.symbol, symbol)).limit(1);
      let price: TradePrice | null = null;
      if (instrument) {
        const [row] = await db.select().from(prices).where(eq(prices.instrumentId, instrument.id)).orderBy(desc(prices.asOf)).limit(1);
        if (row) price = { value: normalizeDecimal(row.price), currency: row.currency, source: row.source, asOf: row.asOf.toISOString() };
      }

      const portfolio = await loadPortfolio(db, {
        accounts: base.accounts,
        currency: 'USD',
        asOf: base.today,
        from: shiftDays(base.today, -365),
        fx: base.fx,
      });

      const proposal = simulateTradeProposal(input, {
        id: randomUUID(),
        createdAt: now.toISOString(),
        createdBy: 'owner',
        fillAt: now.toISOString(),
        policy,
        instrumentKind: instrument?.kind ?? null,
        price,
        fx: base.fx,
        asOf: base.today,
        // Unknown stays null: a missing portfolio value must not silently pass a share limit.
        portfolioValueUsd: portfolio.totalMarketable ? portfolio.totalMarketable.amount : null,
        heldQuantity: null,
        availableCashUsd: null,
        restricted: false,
      });

      await db.transaction(async (tx) => {
        await tx.insert(tradeProposals).values({
          id: proposal.id,
          mode: 'paper',
          instrument: proposal.instrument,
          instrumentId: instrument?.id ?? null,
          side: proposal.side,
          quantity: proposal.quantity,
          limitPrice: proposal.limitPrice,
          currency: proposal.currency,
          rationale: proposal.rationale,
          createdBy: 'owner',
          riskChecks: proposal.riskChecks,
          status: proposal.status,
          createdAt: now,
        });
        if (proposal.paperFill) {
          await tx.insert(paperFills).values({
            proposalId: proposal.id,
            price: proposal.paperFill.price,
            quantity: proposal.quantity,
            filledAt: new Date(proposal.paperFill.at),
            priceSource: proposal.paperFill.priceSource,
          });
        }
      });
      await audit(req, 'trade_proposal.created', { type: 'trade_proposal', id: proposal.id }, `Paper trade proposal recorded (${proposal.status})`, {
        status: proposal.status,
        failedChecks: proposal.riskChecks.filter((c) => !c.passed).map((c) => c.rule),
      });
      reply.code(201);
      return proposal;
    });

    scope.get('/api/risk-policy', async (req): Promise<RiskPolicy> => {
      const [row] = await req.server.fos.db.select().from(riskPolicies).where(eq(riskPolicies.isCurrent, true)).limit(1);
      if (row) return policyView(row);
      return {
        maxPositionShare: DEFAULT_RISK_POLICY.maxPositionShare,
        maxSingleOrderValueUsd: DEFAULT_RISK_POLICY.maxSingleOrderValueUsd,
        allowedInstrumentKinds: [...DEFAULT_RISK_POLICY.allowedInstrumentKinds],
        leverageAllowed: false,
        version: 0,
        updatedAt: iso(req.server.fos.clock.now()),
      };
    });

    scope.put('/api/risk-policy', async (req): Promise<RiskPolicy> => {
      const input = parseBody(RiskPolicyInput, req.body);
      if (!dec(input.maxPositionShare).greaterThan(0)) throw errors.badRequest('The maximum position share must be greater than zero.');
      const { db, clock } = req.server.fos;
      const row = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(riskPolicies).where(eq(riskPolicies.isCurrent, true)).limit(1);
        if (current) await tx.update(riskPolicies).set({ isCurrent: false }).where(eq(riskPolicies.id, current.id));
        const [created] = await tx
          .insert(riskPolicies)
          .values({
            version: (current?.version ?? 0) + 1,
            maxPositionShare: input.maxPositionShare,
            maxSingleOrderValueUsd: input.maxSingleOrderValueUsd,
            allowedInstrumentKinds: input.allowedInstrumentKinds,
            leverageAllowed: false,
            isCurrent: true,
            createdAt: clock.now(),
          })
          .returning();
        if (!created) throw new Error('risk policy insert returned no row');
        return created;
      });
      await audit(req, 'risk_policy.updated', { type: 'risk_policy', id: row.id }, `Risk policy version ${row.version} recorded`);
      return policyView(row);
    });

    scope.get('/api/execution-status', async (): Promise<ExecutionStatus> => executionStatus());
  });
}

export { and, loadOne, requireUuid };
