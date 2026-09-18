/**
 * Paper-trading risk checks. Every check fails closed: when a figure needed to verify a rule is unknown, the
 * rule does not pass. Live execution is always disabled; there is no execution connector.
 */
import type { ExecutionStatus, RiskPolicy, TradeProposal, TradeProposalInput } from '@financialos/contracts';
import type { IsoDate } from '../dates';
import type { FxTable } from '../fx';
import { dec, money, type Dec } from '../money';
import { convertOrNull, decString } from './shared';

export type RiskCheck = TradeProposal['riskChecks'][number];

export interface TradePrice {
  value: string;
  currency: string;
  source: string;
  asOf: string;
}

export interface TradeRiskContext {
  policy: Pick<RiskPolicy, 'maxPositionShare' | 'maxSingleOrderValueUsd' | 'allowedInstrumentKinds' | 'leverageAllowed'>;
  instrumentKind: string | null;
  /** Current market price used for valuation and paper fills. */
  price: TradePrice | null;
  fx: FxTable;
  asOf: IsoDate;
  /** Total portfolio value in USD, including cash. */
  portfolioValueUsd: string | null;
  heldQuantity: string | null;
  /** Cash available to fund a purchase, in USD. */
  availableCashUsd: string | null;
  restricted: boolean;
  /** True when the order would use margin or borrowed money. */
  usesMargin?: boolean;
}

function check(rule: string, passed: boolean, detail: string): RiskCheck {
  return { rule, passed, detail };
}

function toUsd(amount: Dec, currency: string, ctx: TradeRiskContext): Dec | null {
  const converted = convertOrNull(money(amount, currency), 'USD', ctx.asOf, ctx.fx);
  return converted.value ? dec(converted.value.amount) : null;
}

export function evaluateTradeRisk(proposal: TradeProposalInput, ctx: TradeRiskContext): RiskCheck[] {
  const checks: RiskCheck[] = [];
  const quantity = dec(proposal.quantity);
  const isSell = proposal.side === 'sell';
  checks.push(check('quantity_positive', quantity.greaterThan(0), quantity.greaterThan(0) ? `Quantity ${proposal.quantity}` : 'Quantity must be positive'));

  checks.push(
    ctx.price
      ? check('price_available', true, `Price ${ctx.price.value} ${ctx.price.currency} from ${ctx.price.source} as of ${ctx.price.asOf}`)
      : check('price_available', false, 'No current price is available, so the order cannot be valued'),
  );

  const kindAllowed = ctx.instrumentKind !== null && ctx.policy.allowedInstrumentKinds.includes(ctx.instrumentKind);
  checks.push(
    check(
      'instrument_kind_allowed',
      kindAllowed,
      ctx.instrumentKind === null ? 'Instrument type is unknown' : kindAllowed ? `${ctx.instrumentKind} is allowed` : `${ctx.instrumentKind} is not in the allowed list`,
    ),
  );

  const unitPrice = proposal.limitPrice !== null ? dec(proposal.limitPrice) : ctx.price ? dec(ctx.price.value) : null;
  const priceCurrency = proposal.limitPrice !== null ? proposal.currency : (ctx.price?.currency ?? proposal.currency);
  const orderUsd = unitPrice === null ? null : toUsd(quantity.times(unitPrice), priceCurrency, ctx);
  const maxOrder = dec(ctx.policy.maxSingleOrderValueUsd);
  checks.push(
    orderUsd === null
      ? check('max_single_order_value', false, 'Order value in USD is unknown')
      : check(
          'max_single_order_value',
          orderUsd.lessThanOrEqualTo(maxOrder),
          `Order value ${decString(orderUsd, 2)} USD against a limit of ${ctx.policy.maxSingleOrderValueUsd} USD`,
        ),
  );

  // Leverage: never allowed. A purchase must be fully funded by available cash.
  let leverageDetail: string;
  let leveragePassed: boolean;
  if (ctx.usesMargin) {
    leveragePassed = false;
    leverageDetail = 'Margin or borrowed money is not allowed';
  } else if (isSell) {
    leveragePassed = true;
    leverageDetail = 'A sale uses no leverage';
  } else if (orderUsd === null || ctx.availableCashUsd === null) {
    leveragePassed = false;
    leverageDetail = 'Cannot confirm the purchase is fully funded from available cash';
  } else {
    leveragePassed = orderUsd.lessThanOrEqualTo(dec(ctx.availableCashUsd));
    leverageDetail = leveragePassed ? 'Fully funded from available cash' : 'The purchase exceeds available cash and would need leverage';
  }
  checks.push(check('no_leverage', leveragePassed && ctx.policy.leverageAllowed === false, leverageDetail));

  const heldValueUsd = ctx.heldQuantity !== null && ctx.price ? toUsd(dec(ctx.heldQuantity).times(dec(ctx.price.value)), ctx.price.currency, ctx) : null;
  if (heldValueUsd === null || orderUsd === null || ctx.portfolioValueUsd === null || !dec(ctx.portfolioValueUsd).greaterThan(0)) {
    checks.push(check('max_position_share', false, 'Position share after the trade cannot be calculated'));
  } else {
    const after = isSell ? heldValueUsd.minus(orderUsd) : heldValueUsd.plus(orderUsd);
    const share = after.dividedBy(dec(ctx.portfolioValueUsd));
    checks.push(
      check(
        'max_position_share',
        share.lessThanOrEqualTo(dec(ctx.policy.maxPositionShare)),
        `Position would be ${decString(share.times(100), 2)}% of the portfolio (limit ${decString(dec(ctx.policy.maxPositionShare).times(100), 2)}%)`,
      ),
    );
  }

  if (isSell) {
    if (ctx.heldQuantity === null) checks.push(check('sell_within_holding', false, 'Held quantity is unknown'));
    else {
      const ok = quantity.lessThanOrEqualTo(dec(ctx.heldQuantity));
      checks.push(check('sell_within_holding', ok, ok ? `Selling ${proposal.quantity} of ${ctx.heldQuantity} held` : `Cannot sell ${proposal.quantity}: only ${ctx.heldQuantity} held`));
    }
    checks.push(check('restricted_not_sold', !ctx.restricted, ctx.restricted ? 'Restricted holdings cannot be sold here' : 'Not restricted'));
  } else {
    checks.push(check('sell_within_holding', true, 'Not a sale'));
    checks.push(check('restricted_not_sold', true, 'Not a sale'));
  }
  return checks;
}

export interface PaperTradeContext extends TradeRiskContext {
  id: string;
  createdAt: string;
  createdBy: TradeProposal['createdBy'];
  /** Timestamp recorded for a paper fill. */
  fillAt: string;
}

/**
 * Records a paper trade proposal. Rejected when any check fails. A limit order only paper-fills when the market
 * price is at or better than the limit; otherwise it stays simulated. Fills use the provided price and source.
 */
export function simulateTradeProposal(input: TradeProposalInput, ctx: PaperTradeContext): TradeProposal {
  const riskChecks = evaluateTradeRisk(input, ctx);
  const base = {
    id: ctx.id,
    mode: 'paper' as const,
    instrument: input.instrument,
    side: input.side,
    quantity: input.quantity,
    limitPrice: input.limitPrice,
    currency: input.currency,
    rationale: input.rationale,
    createdBy: ctx.createdBy,
    riskChecks,
    createdAt: ctx.createdAt,
  };
  if (riskChecks.some((c) => !c.passed) || !ctx.price) return { ...base, status: 'rejected', paperFill: null };
  const market = dec(ctx.price.value);
  if (input.limitPrice !== null) {
    const limit = dec(input.limitPrice);
    const fills = input.side === 'buy' ? market.lessThanOrEqualTo(limit) : market.greaterThanOrEqualTo(limit);
    if (!fills) return { ...base, status: 'simulated', paperFill: null };
  }
  return { ...base, status: 'paper_filled', paperFill: { price: ctx.price.value, at: ctx.fillAt, priceSource: ctx.price.source } };
}

export const LIVE_EXECUTION_REQUIREMENTS = [
  'A separately authorised execution connector (none exists in FinancialOS)',
  'A complete written mandate that states the permitted instruments',
  'The capital allocation the mandate may use',
  'The leverage allowed (none unless explicitly granted)',
  'Position limits',
  'Order limits',
  'Loss limits',
  'An emergency stop',
] as const;

/** Live execution is always disabled. */
export function executionStatus(): ExecutionStatus {
  return {
    liveExecutionEnabled: false,
    reason: 'Live trading is disabled. FinancialOS only records paper trades and has no connector that can place orders.',
    requirements: [...LIVE_EXECUTION_REQUIREMENTS],
  };
}
