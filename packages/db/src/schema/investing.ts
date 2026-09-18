import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, money, pk, rate, tstz, updatedAt } from './_columns';
import { instruments } from './org';
import { agentClients } from './security';

export const TRADE_PROPOSAL_STATUSES = ['draft', 'simulated', 'paper_filled', 'rejected', 'expired'] as const;

/** Paper-only trade proposals. There is no execution path. */
export const tradeProposals = pgTable(
  'trade_proposals',
  {
    id: pk(),
    mode: text('mode').$type<'paper'>().notNull().default('paper'),
    instrument: text('instrument').notNull(),
    instrumentId: uuid('instrument_id').references(() => instruments.id),
    side: text('side').$type<'buy' | 'sell'>().notNull(),
    quantity: money('quantity').notNull(),
    limitPrice: money('limit_price'),
    currency: text('currency').notNull(),
    rationale: text('rationale').notNull(),
    createdBy: text('created_by').$type<'owner' | 'agent'>().notNull(),
    agentClientId: uuid('agent_client_id').references(() => agentClients.id),
    riskChecks: jsonb('risk_checks')
      .$type<Array<{ rule: string; passed: boolean; detail: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text('status').$type<(typeof TRADE_PROPOSAL_STATUSES)[number]>().notNull().default('draft'),
    expiresAt: tstz('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [
    check('trade_proposals_paper_only_check', sql`mode = 'paper'`),
    check('trade_proposals_side_check', inList('side', ['buy', 'sell'])),
    check('trade_proposals_created_by_check', inList('created_by', ['owner', 'agent'])),
    check('trade_proposals_status_check', inList('status', TRADE_PROPOSAL_STATUSES)),
    check('trade_proposals_quantity_check', sql`quantity > 0`),
  ],
);

export const paperFills = pgTable(
  'paper_fills',
  {
    id: pk(),
    proposalId: uuid('proposal_id')
      .notNull()
      .unique('paper_fills_proposal_key')
      .references(() => tradeProposals.id),
    price: money('price').notNull(),
    quantity: money('quantity').notNull(),
    filledAt: tstz('filled_at').notNull(),
    priceSource: text('price_source').notNull(),
    createdAt: createdAt(),
  },
  () => [check('paper_fills_price_check', sql`price >= 0`)],
);

/** Versioned risk policy; one current row. Leverage is never allowed. */
export const riskPolicies = pgTable(
  'risk_policies',
  {
    id: pk(),
    version: integer('version').notNull().unique('risk_policies_version_key'),
    maxPositionShare: rate('max_position_share').notNull(),
    maxSingleOrderValueUsd: money('max_single_order_value_usd').notNull(),
    allowedInstrumentKinds: text('allowed_instrument_kinds').array().notNull(),
    leverageAllowed: boolean('leverage_allowed').notNull().default(false),
    isCurrent: boolean('is_current').notNull().default(true),
    createdBy: text('created_by').notNull().default('owner'),
    createdAt: createdAt(),
  },
  (t) => [
    check('risk_policies_no_leverage_check', sql`leverage_allowed = false`),
    check('risk_policies_share_check', sql`max_position_share > 0 AND max_position_share <= 1`),
    uniqueIndex('risk_policies_one_current').on(t.isCurrent).where(sql`is_current`),
  ],
);

/** Live execution is disabled and no execution connector exists. */
export const executionMandates = pgTable(
  'execution_mandates',
  {
    id: pk(),
    brokerKey: text('broker_key').notNull(),
    status: text('status').$type<'disabled'>().notNull().default('disabled'),
    reason: text('reason').notNull(),
    requirements: jsonb('requirements').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [check('execution_mandates_disabled_check', sql`status = 'disabled'`)],
);
