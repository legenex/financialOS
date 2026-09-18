import { ExecutionStatus, TradeProposal, type TradeProposalInput } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { evaluateTradeRisk, executionStatus, LIVE_EXECUTION_REQUIREMENTS, simulateTradeProposal, type PaperTradeContext, type RiskCheck, type TradeRiskContext } from './paperTrading';
import { deepFreeze, uid } from './testing';

const PROPOSAL_ID = uid(600);

const POLICY = {
  maxPositionShare: '0.2',
  maxSingleOrderValueUsd: '12500',
  allowedInstrumentKinds: ['equity', 'etf'],
  leverageAllowed: false as const,
};

function ctx(overrides: Partial<TradeRiskContext> = {}): TradeRiskContext {
  return {
    policy: POLICY,
    instrumentKind: 'equity',
    price: { value: '50', currency: 'USD', source: 'Example Market Data', asOf: '2026-03-10T15:00:00Z' },
    fx: new FxTable(),
    asOf: '2026-03-10',
    portfolioValueUsd: '100000',
    heldQuantity: '100',
    availableCashUsd: '20000',
    restricted: false,
    ...overrides,
  };
}

function paperCtx(overrides: Partial<PaperTradeContext> = {}): PaperTradeContext {
  return { ...ctx(), id: PROPOSAL_ID, createdAt: '2026-03-10T15:05:00Z', createdBy: 'owner', fillAt: '2026-03-10T15:05:30Z', ...overrides };
}

function proposal(overrides: Partial<TradeProposalInput> = {}): TradeProposalInput {
  return { instrument: 'AAA', side: 'buy', quantity: '10', limitPrice: null, currency: 'USD', rationale: 'Rebalancing towards the target weight.', ...overrides };
}

const by = (checks: RiskCheck[], rule: string): RiskCheck => checks.find((c) => c.rule === rule)!;

describe('every risk check passes on a clean proposal', () => {
  const checks = evaluateTradeRisk(deepFreeze(proposal()), deepFreeze(ctx()));

  it('runs all eight checks and passes them', () => {
    expect(checks.map((c) => c.rule)).toEqual([
      'quantity_positive',
      'price_available',
      'instrument_kind_allowed',
      'max_single_order_value',
      'no_leverage',
      'max_position_share',
      'sell_within_holding',
      'restricted_not_sold',
    ]);
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  it('records the figures behind each check', () => {
    expect(by(checks, 'price_available').detail).toBe('Price 50 USD from Example Market Data as of 2026-03-10T15:00:00Z');
    expect(by(checks, 'max_single_order_value').detail).toBe('Order value 500 USD against a limit of 12500 USD');
    expect(by(checks, 'max_position_share').detail).toBe('Position would be 5.5% of the portfolio (limit 20%)');
    expect(by(checks, 'no_leverage').detail).toBe('Fully funded from available cash');
  });
});

describe('each check fails closed', () => {
  it('fails a quantity that is not positive', () => {
    expect(by(evaluateTradeRisk(proposal({ quantity: '0' }), ctx()), 'quantity_positive')).toEqual({ rule: 'quantity_positive', passed: false, detail: 'Quantity must be positive' });
  });

  it('fails when no price is available, and everything that depends on it', () => {
    const checks = evaluateTradeRisk(proposal(), ctx({ price: null }));
    expect(by(checks, 'price_available')).toEqual({ rule: 'price_available', passed: false, detail: 'No current price is available, so the order cannot be valued' });
    expect(by(checks, 'max_single_order_value')).toEqual({ rule: 'max_single_order_value', passed: false, detail: 'Order value in USD is unknown' });
    expect(by(checks, 'max_position_share').passed).toBe(false);
  });

  it('fails an instrument type that is not allowed, or not known', () => {
    expect(by(evaluateTradeRisk(proposal(), ctx({ instrumentKind: 'crypto' })), 'instrument_kind_allowed')).toEqual({
      rule: 'instrument_kind_allowed',
      passed: false,
      detail: 'crypto is not in the allowed list',
    });
    expect(by(evaluateTradeRisk(proposal(), ctx({ instrumentKind: null })), 'instrument_kind_allowed').detail).toBe('Instrument type is unknown');
    expect(by(evaluateTradeRisk(proposal(), ctx({ instrumentKind: 'etf' })), 'instrument_kind_allowed').passed).toBe(true);
  });

  it('fails an order above the single-order limit', () => {
    const checks = evaluateTradeRisk(proposal({ quantity: '1000' }), ctx());
    expect(by(checks, 'max_single_order_value')).toEqual({ rule: 'max_single_order_value', passed: false, detail: 'Order value 50000 USD against a limit of 12500 USD' });
    // 250 shares at 50 is exactly the limit and is allowed.
    expect(by(evaluateTradeRisk(proposal({ quantity: '250' }), ctx()), 'max_single_order_value').passed).toBe(true);
  });

  it('fails anything that would need leverage, and anything it cannot prove is funded', () => {
    expect(by(evaluateTradeRisk(proposal(), ctx({ usesMargin: true })), 'no_leverage')).toEqual({ rule: 'no_leverage', passed: false, detail: 'Margin or borrowed money is not allowed' });
    expect(by(evaluateTradeRisk(proposal({ quantity: '100' }), ctx({ availableCashUsd: '4000' })), 'no_leverage')).toEqual({
      rule: 'no_leverage',
      passed: false,
      detail: 'The purchase exceeds available cash and would need leverage',
    });
    expect(by(evaluateTradeRisk(proposal(), ctx({ availableCashUsd: null })), 'no_leverage').detail).toBe('Cannot confirm the purchase is fully funded from available cash');
    expect(by(evaluateTradeRisk(proposal({ side: 'sell' }), ctx({ availableCashUsd: null })), 'no_leverage')).toEqual({ rule: 'no_leverage', passed: true, detail: 'A sale uses no leverage' });
  });

  it('fails a position that would breach the concentration limit, and anything it cannot compute', () => {
    // 100 held at 50 plus 300 more: 20 000 of 100 000 is exactly the 20 % limit.
    expect(by(evaluateTradeRisk(proposal({ quantity: '300' }), ctx({ availableCashUsd: '100000' })), 'max_position_share').passed).toBe(true);
    const over = by(evaluateTradeRisk(proposal({ quantity: '301' }), ctx({ availableCashUsd: '100000' })), 'max_position_share');
    expect(over.passed).toBe(false);
    expect(over.detail).toBe('Position would be 20.05% of the portfolio (limit 20%)');
    for (const context of [ctx({ portfolioValueUsd: null }), ctx({ portfolioValueUsd: '0' }), ctx({ heldQuantity: null })]) {
      expect(by(evaluateTradeRisk(proposal(), context), 'max_position_share')).toEqual({ rule: 'max_position_share', passed: false, detail: 'Position share after the trade cannot be calculated' });
    }
  });

  it('refuses a sale larger than the holding', () => {
    expect(by(evaluateTradeRisk(proposal({ side: 'sell', quantity: '150' }), ctx()), 'sell_within_holding')).toEqual({
      rule: 'sell_within_holding',
      passed: false,
      detail: 'Cannot sell 150: only 100 held',
    });
    expect(by(evaluateTradeRisk(proposal({ side: 'sell', quantity: '100' }), ctx()), 'sell_within_holding')).toEqual({
      rule: 'sell_within_holding',
      passed: true,
      detail: 'Selling 100 of 100 held',
    });
    expect(by(evaluateTradeRisk(proposal({ side: 'sell', quantity: '1' }), ctx({ heldQuantity: null })), 'sell_within_holding')).toEqual({
      rule: 'sell_within_holding',
      passed: false,
      detail: 'Held quantity is unknown',
    });
  });

  it('refuses to sell a restricted instrument', () => {
    expect(by(evaluateTradeRisk(proposal({ side: 'sell', quantity: '10' }), ctx({ restricted: true })), 'restricted_not_sold')).toEqual({
      rule: 'restricted_not_sold',
      passed: false,
      detail: 'Restricted holdings cannot be sold here',
    });
    // A purchase is not a sale, so the restriction check does not apply to it.
    expect(by(evaluateTradeRisk(proposal(), ctx({ restricted: true })), 'restricted_not_sold')).toEqual({ rule: 'restricted_not_sold', passed: true, detail: 'Not a sale' });
  });

  it('values an order priced in another currency in USD', () => {
    const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18', asOf: '2026-03-08', source: 'test' }]);
    const local = ctx({ fx, price: { value: '900', currency: 'ZAR', source: 'Example Market Data', asOf: '2026-03-10T15:00:00Z' } });
    expect(by(evaluateTradeRisk(proposal(), local), 'max_single_order_value').detail).toBe('Order value 500 USD against a limit of 12500 USD');
    const noRate = ctx({ price: { value: '900', currency: 'ZAR', source: 'Example Market Data', asOf: '2026-03-10T15:00:00Z' } });
    expect(by(evaluateTradeRisk(proposal(), noRate), 'max_single_order_value').detail).toBe('Order value in USD is unknown');
  });
});

describe('paper fills', () => {
  it('fills a clean market order and records the price source', () => {
    const result = simulateTradeProposal(proposal(), paperCtx());
    expect(() => TradeProposal.parse(result)).not.toThrow();
    expect(result.mode).toBe('paper');
    expect(result.status).toBe('paper_filled');
    expect(result.paperFill).toEqual({ price: '50', at: '2026-03-10T15:05:30Z', priceSource: 'Example Market Data' });
    expect(result.riskChecks.every((c) => c.passed)).toBe(true);
    expect(result.createdBy).toBe('owner');
  });

  it('rejects the proposal when any check fails, and records no fill', () => {
    for (const [input, context] of [
      [proposal({ quantity: '0' }), paperCtx()],
      [proposal({ quantity: '1000' }), paperCtx()],
      [proposal({ side: 'sell', quantity: '150' }), paperCtx()],
      [proposal({ side: 'sell', quantity: '10' }), paperCtx({ restricted: true })],
      [proposal(), paperCtx({ instrumentKind: 'crypto' })],
      [proposal(), paperCtx({ usesMargin: true })],
      [proposal(), paperCtx({ price: null })],
    ] as const) {
      const result = simulateTradeProposal(input, context);
      expect(result.status).toBe('rejected');
      expect(result.paperFill).toBeNull();
      expect(result.riskChecks.some((c) => !c.passed)).toBe(true);
    }
  });

  it('only fills a limit order when the market price is at or better than the limit', () => {
    const buyTooLow = simulateTradeProposal(proposal({ limitPrice: '45' }), paperCtx());
    expect(buyTooLow.status).toBe('simulated');
    expect(buyTooLow.paperFill).toBeNull();

    const buyFills = simulateTradeProposal(proposal({ limitPrice: '55' }), paperCtx());
    expect(buyFills.status).toBe('paper_filled');
    expect(buyFills.paperFill!.price).toBe('50');

    const sellTooHigh = simulateTradeProposal(proposal({ side: 'sell', quantity: '10', limitPrice: '55' }), paperCtx());
    expect(sellTooHigh.status).toBe('simulated');

    const sellFills = simulateTradeProposal(proposal({ side: 'sell', quantity: '10', limitPrice: '45' }), paperCtx());
    expect(sellFills.status).toBe('paper_filled');

    const exactly = simulateTradeProposal(proposal({ limitPrice: '50' }), paperCtx());
    expect(exactly.status).toBe('paper_filled');
  });

  it('values a limit order at the limit price, not the market price', () => {
    const result = simulateTradeProposal(proposal({ quantity: '100', limitPrice: '99' }), paperCtx({ availableCashUsd: '20000' }));
    expect(by(result.riskChecks, 'max_single_order_value').detail).toBe('Order value 9900 USD against a limit of 12500 USD');
    expect(by(result.riskChecks, 'no_leverage').passed).toBe(true);
  });

  it('is deterministic and carries the proposal through unchanged', () => {
    const input = proposal();
    const context = paperCtx();
    expect(JSON.stringify(simulateTradeProposal(input, context))).toBe(JSON.stringify(simulateTradeProposal(input, context)));
    const result = simulateTradeProposal(input, context);
    expect(result.id).toBe(PROPOSAL_ID);
    expect(result.instrument).toBe('AAA');
    expect(result.quantity).toBe('10');
    expect(result.rationale).toBe('Rebalancing towards the target weight.');
    expect(result.createdAt).toBe('2026-03-10T15:05:00Z');
  });
});

describe('live execution', () => {
  it('is always disabled, with the full list of what it would take', () => {
    const status = executionStatus();
    expect(() => ExecutionStatus.parse(status)).not.toThrow();
    expect(status.liveExecutionEnabled).toBe(false);
    expect(status.reason).toBe('Live trading is disabled. FinancialOS only records paper trades and has no connector that can place orders.');
    expect(status.requirements).toEqual([...LIVE_EXECUTION_REQUIREMENTS]);
    expect(status.requirements).toHaveLength(8);
    expect(status.requirements.join(' ')).toContain('separately authorised execution connector');
    expect(status.requirements.join(' ')).toContain('emergency stop');
    expect(status.requirements.join(' ')).toContain('leverage allowed (none unless explicitly granted)');
  });

  it('returns a fresh object every time, so nothing can flip the flag for later callers', () => {
    const first = executionStatus();
    const second = executionStatus();
    expect(first).not.toBe(second);
    expect(first.requirements).not.toBe(second.requirements);
    expect(first).toEqual(second);
  });

  it('never reports any status other than paper for a proposal', () => {
    const statuses = [
      simulateTradeProposal(proposal(), paperCtx()).status,
      simulateTradeProposal(proposal({ limitPrice: '45' }), paperCtx()).status,
      simulateTradeProposal(proposal({ quantity: '0' }), paperCtx()).status,
    ];
    expect(new Set(statuses)).toEqual(new Set(['paper_filled', 'simulated', 'rejected']));
    expect(simulateTradeProposal(proposal(), paperCtx()).mode).toBe('paper');
  });
});
