/**
 * Portfolio summary: allocation, currency exposure, concentration, cost-basis completeness, income, and
 * performance only when the data supports it. Restricted holdings are listed separately and never counted in
 * the marketable total.
 *
 * Performance:
 *   time-weighted  (period return) — only when a valuation exists on every external cash-flow date;
 *                  valuations are end-of-day (after that day's flows): r = (V_d − F_d) / V_prev − 1
 *   money-weighted (annualised XIRR) — only with dated external flows and start/end valuations;
 *                  Newton–Raphson in Decimal with a bisection fallback and bounded iterations
 *   otherwise      method 'none' with the reason
 */
import type { Instrument, Money, PortfolioSummary, Restriction } from '@financialos/contracts';
import { diffDays, type IsoDate } from '../dates';
import type { FxTable } from '../fx';
import { D, dec, money, roundToCurrency, type Dec } from '../money';
import { compareStrings, convertOrNull, decString, PlanningError } from './shared';

export interface PortfolioHoldingLine {
  instrument: { id?: string | null; symbol: string; name: string; kind: Instrument['kind']; currency: string | null };
  quantity: string | null;
  price: Money | null;
  /** Date (or date-time) of the price. Null = same as the snapshot. */
  priceAsOf: string | null;
  /** Reported market value. Used when quantity × price is not available. */
  value: Money | null;
  costBasis: Money | null;
  costBasisComplete: boolean;
  restricted: boolean;
}

export interface PortfolioHoldingsSnapshot {
  accountId: string;
  asOf: IsoDate;
  completeness: 'complete' | 'partial' | 'unknown';
  lines: readonly PortfolioHoldingLine[];
}

export interface CorporateActionInput {
  id: string;
  symbol: string;
  kind: 'split' | 'reverse_split';
  /** New shares per old share: a 2-for-1 split is "2", a 1-for-10 reverse split is "0.1". */
  ratio: string;
  effectiveOn: IsoDate;
}

export interface PortfolioIncomeEntry {
  date: IsoDate;
  kind: 'dividend' | 'interest' | 'fee';
  amount: Money;
}

export interface PerformanceInput {
  start: { date: IsoDate; value: Money | null };
  end: { date: IsoDate; value: Money | null };
  /** External contributions (+) and withdrawals (−). Null = unknown. */
  externalFlows: ReadonlyArray<{ date: IsoDate; amount: Money }> | null;
  /** End-of-day valuations (after that day's flows). */
  valuations: ReadonlyArray<{ date: IsoDate; value: Money }>;
}

export interface PortfolioInput {
  currency: string;
  asOf: IsoDate;
  snapshots: readonly PortfolioHoldingsSnapshot[];
  restrictions?: ReadonlyArray<Pick<Restriction, 'accountId' | 'instrumentId' | 'status'>>;
  /** Accounts whose whole content is restricted. */
  restrictedAccountIds?: readonly string[];
  corporateActions?: readonly CorporateActionInput[];
  /** Null = income history unknown. */
  income?: readonly PortfolioIncomeEntry[] | null;
  performance?: PerformanceInput | null;
  /** Share above which a position is flagged (default 0.2). */
  concentrationThreshold?: string;
  fx: FxTable;
}

export interface PortfolioPosition {
  symbol: string;
  name: string;
  kind: Instrument['kind'];
  currency: string | null;
  quantity: string | null;
  value: Money | null;
  restricted: boolean;
  accountIds: string[];
}

export interface PortfolioComputation {
  summary: PortfolioSummary;
  positions: PortfolioPosition[];
  /** 'period' for time-weighted (not annualised), 'annualised' for money-weighted. */
  performanceBasis: 'period' | 'annualised' | null;
  appliedCorporateActions: Array<{ accountId: string; symbol: string; actionId: string }>;
}

function dateOnly(value: string): IsoDate {
  return value.slice(0, 10);
}

/**
 * Applies splits effective after the snapshot date (and on or before `asOf`) to a snapshot quantity.
 * A snapshot taken on or after the effective date already reflects the split and is left unchanged.
 */
export function adjustForSplits(
  quantity: Dec,
  symbol: string,
  snapshotDate: IsoDate,
  actions: readonly CorporateActionInput[],
  asOf: IsoDate,
): { quantity: Dec; factor: Dec; applied: CorporateActionInput[] } {
  let factor = new D(1);
  const applied: CorporateActionInput[] = [];
  for (const action of [...actions].sort((a, b) => compareStrings(a.effectiveOn, b.effectiveOn))) {
    if (action.symbol !== symbol) continue;
    const ratio = dec(action.ratio);
    if (!ratio.greaterThan(0)) throw new PlanningError(`Split ratio must be positive: ${action.ratio}`);
    if (action.kind === 'split' && !ratio.greaterThan(1)) throw new PlanningError(`A split ratio must be above 1: ${action.ratio}`);
    if (action.kind === 'reverse_split' && !ratio.lessThan(1)) throw new PlanningError(`A reverse split ratio must be below 1: ${action.ratio}`);
    if (action.effectiveOn <= snapshotDate || action.effectiveOn > asOf) continue;
    factor = factor.times(ratio);
    applied.push(action);
  }
  return { quantity: quantity.times(factor), factor, applied };
}

// ------------------------------------------------------------------------------------------------------------
// Performance
// ------------------------------------------------------------------------------------------------------------

type Performance = PortfolioSummary['performance'];

function none(reason: string, marketChange: Money | null = null, netContributions: Money | null = null): Performance {
  return { method: 'none', value: null, marketChange, netContributions, reasonUnavailable: reason };
}

/** Net present value of dated flows at annual rate r (actual/365). */
function npv(flows: ReadonlyArray<{ t: Dec; amount: Dec }>, r: Dec): { value: Dec; derivative: Dec } {
  const base = new D(1).plus(r);
  let value = new D(0);
  let derivative = new D(0);
  for (const f of flows) {
    const discount = base.pow(f.t.negated());
    value = value.plus(f.amount.times(discount));
    derivative = derivative.minus(f.t.times(f.amount).times(discount).dividedBy(base));
  }
  return { value, derivative };
}

/**
 * Annualised internal rate of return for dated flows (investor perspective: money paid in is negative).
 * Returns null when no rate exists or none can be found within the iteration bounds.
 */
export function xirr(flows: ReadonlyArray<{ date: IsoDate; amount: Dec }>, maxIterations = 100): Dec | null {
  if (flows.length < 2) return null;
  const first = flows.reduce((min, f) => (f.date < min ? f.date : min), flows[0]!.date);
  const timed = flows.map((f) => ({ t: new D(diffDays(first, f.date)).dividedBy(365), amount: f.amount }));
  if (!timed.some((f) => f.amount.isNegative()) || !timed.some((f) => f.amount.greaterThan(0))) return null;
  const scale = timed.reduce((acc, f) => acc.plus(f.amount.abs()), new D(0));
  const tolerance = scale.times('1e-20');
  const lowerBound = new D('-0.999999');

  let r = new D('0.1');
  for (let i = 0; i < maxIterations; i += 1) {
    const { value, derivative } = npv(timed, r);
    if (value.abs().lessThanOrEqualTo(tolerance)) return r;
    if (derivative.isZero()) break;
    const next = r.minus(value.dividedBy(derivative));
    if (!next.isFinite() || next.lessThanOrEqualTo(lowerBound)) break;
    if (next.minus(r).abs().lessThan('1e-24')) return next;
    r = next;
  }

  // Bisection fallback on [lowerBound, hi].
  let lo = lowerBound;
  let hi = new D(1);
  let fLo = npv(timed, lo).value;
  let fHi = npv(timed, hi).value;
  for (let i = 0; i < 60 && fLo.times(fHi).greaterThan(0); i += 1) {
    hi = hi.times(2);
    fHi = npv(timed, hi).value;
  }
  if (fLo.times(fHi).greaterThan(0)) return null;
  for (let i = 0; i < maxIterations * 2; i += 1) {
    const mid = lo.plus(hi).dividedBy(2);
    const fMid = npv(timed, mid).value;
    if (fMid.abs().lessThanOrEqualTo(tolerance) || hi.minus(lo).lessThan('1e-18')) return mid;
    if (fLo.times(fMid).lessThan(0)) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return lo.plus(hi).dividedBy(2);
}

export function computePerformance(input: PerformanceInput | null | undefined, currency: string, fx: FxTable): { performance: Performance; basis: 'period' | 'annualised' | null } {
  if (!input) return { performance: none('No valuation history is available'), basis: null };
  const { start, end } = input;
  if (end.date <= start.date) return { performance: none('The end date must be after the start date'), basis: null };
  if (start.value === null || end.value === null) return { performance: none('Start and end valuations are both required'), basis: null };
  const conv = (m: Money, date: IsoDate): Dec | null => {
    const c = convertOrNull(m, currency, date, fx, { method: 'historical' });
    return c.value ? dec(c.value.amount) : null;
  };
  const startValue = conv(start.value, start.date);
  const endValue = conv(end.value, end.date);
  if (startValue === null || endValue === null) return { performance: none(`Valuations could not be converted to ${currency}`), basis: null };
  if (input.externalFlows === null) {
    return { performance: none('External contributions and withdrawals are unknown, so returns and market change cannot be separated'), basis: null };
  }
  const flowsByDate = new Map<IsoDate, Dec>();
  for (const flow of input.externalFlows) {
    if (flow.date <= start.date || flow.date > end.date) continue;
    const amount = conv(flow.amount, flow.date);
    if (amount === null) return { performance: none(`A contribution or withdrawal could not be converted to ${currency}`), basis: null };
    flowsByDate.set(flow.date, (flowsByDate.get(flow.date) ?? new D(0)).plus(amount));
  }
  const net = [...flowsByDate.values()].reduce((acc, v) => acc.plus(v), new D(0));
  const netContributions = roundToCurrency(money(net, currency));
  const marketChange = roundToCurrency(money(endValue.minus(startValue).minus(net), currency));

  // Time-weighted: needs a valuation on every flow date.
  const valuationByDate = new Map<IsoDate, Dec>();
  let valuationsConvertible = true;
  for (const v of input.valuations) {
    const value = conv(v.value, v.date);
    if (value === null) valuationsConvertible = false;
    else valuationByDate.set(v.date, value);
  }
  valuationByDate.set(start.date, startValue);
  valuationByDate.set(end.date, endValue);
  const flowDates = [...flowsByDate.keys()].sort(compareStrings);
  const missingValuation = flowDates.find((d) => !valuationByDate.has(d));
  let twrReason: string | null = null;
  if (!valuationsConvertible) twrReason = 'some valuations could not be converted';
  else if (missingValuation) twrReason = `no valuation on the flow date ${missingValuation}`;
  if (twrReason === null) {
    const points = [...new Set([...flowDates, end.date])].sort(compareStrings);
    let previous = startValue;
    let growth = new D(1);
    let ok = true;
    for (const date of points) {
      if (!previous.greaterThan(0)) {
        ok = false;
        break;
      }
      const value = valuationByDate.get(date)!;
      const flow = flowsByDate.get(date) ?? new D(0);
      growth = growth.times(value.minus(flow).dividedBy(previous));
      previous = value;
    }
    if (ok) {
      return {
        performance: { method: 'time_weighted', value: decString(growth.minus(1), 8), marketChange, netContributions, reasonUnavailable: null },
        basis: 'period',
      };
    }
    twrReason = 'a sub-period starts from a zero or negative value';
  }

  // Money-weighted.
  const cashflows = [
    { date: start.date, amount: startValue.negated() },
    ...flowDates.map((date) => ({ date, amount: flowsByDate.get(date)!.negated() })),
    { date: end.date, amount: endValue },
  ];
  const rate = xirr(cashflows);
  if (rate === null) {
    return { performance: none(`Time-weighted return unavailable (${twrReason}) and no money-weighted return could be solved`, marketChange, netContributions), basis: null };
  }
  return {
    performance: { method: 'money_weighted', value: decString(rate, 8), marketChange, netContributions, reasonUnavailable: null },
    basis: 'annualised',
  };
}

// ------------------------------------------------------------------------------------------------------------
// Summary
// ------------------------------------------------------------------------------------------------------------

function restrictionStatus(
  restrictions: PortfolioInput['restrictions'],
  accountId: string,
  instrumentId: string | null | undefined,
): 'verified' | 'reported_unverified' | 'none_recorded' {
  const relevant = (restrictions ?? []).filter(
    (r) => r.accountId === accountId && (r.instrumentId === null || !instrumentId || r.instrumentId === instrumentId) && r.status !== 'rejected' && r.status !== 'expired',
  );
  if (relevant.some((r) => r.status === 'verified')) return 'verified';
  if (relevant.some((r) => r.status === 'reported_unverified')) return 'reported_unverified';
  return 'none_recorded';
}

function share(part: Dec, total: Dec): string {
  return total.isZero() ? '0' : decString(part.dividedBy(total), 6);
}

export function computePortfolio(input: PortfolioInput): PortfolioComputation {
  const { currency, fx, asOf } = input;
  const threshold = dec(input.concentrationThreshold ?? '0.2');
  const restrictedAccounts = new Set(input.restrictedAccountIds ?? []);
  const actions = input.corporateActions ?? [];
  let unknownValues = 0;
  let partial = false;
  const applied: PortfolioComputation['appliedCorporateActions'] = [];
  const positions = new Map<string, PortfolioPosition & { valueDec: Dec | null; qtyDec: Dec | null; costKnownValue: Dec }>();
  const restricted: PortfolioSummary['restricted'] = [];

  for (const snapshot of input.snapshots) {
    if (snapshot.completeness !== 'complete') partial = true;
    for (const line of snapshot.lines) {
      const symbol = line.instrument.symbol;
      let quantity: Dec | null = null;
      let valueNative: Money | null = null;
      if (line.quantity !== null) {
        const adjusted = adjustForSplits(dec(line.quantity), symbol, snapshot.asOf, actions, asOf);
        quantity = adjusted.quantity;
        for (const a of adjusted.applied) applied.push({ accountId: snapshot.accountId, symbol, actionId: a.id });
        if (line.price) {
          const priceDate = line.priceAsOf ? dateOnly(line.priceAsOf) : snapshot.asOf;
          const priceFactor = adjustForSplits(new D(1), symbol, priceDate, actions, asOf).factor;
          valueNative = money(quantity.times(dec(line.price.amount)).dividedBy(priceFactor), line.price.currency);
        }
      }
      valueNative ??= line.value;
      let value: Dec | null = null;
      if (valueNative) {
        const converted = convertOrNull(valueNative, currency, asOf, fx);
        value = converted.value ? dec(converted.value.amount) : null;
      }
      const isRestricted = line.restricted || restrictedAccounts.has(snapshot.accountId) || line.instrument.kind === 'restricted_equity';
      if (isRestricted) {
        restricted.push({
          accountId: snapshot.accountId,
          instrument: symbol,
          quantity: quantity === null ? null : decString(quantity),
          indicativeValue: value === null ? null : roundToCurrency(money(value, currency)),
          restrictionStatus: restrictionStatus(input.restrictions, snapshot.accountId, line.instrument.id),
          note: 'Indicative value only. Restricted holdings are not part of spending capacity, runway or the marketable total.',
        });
        continue;
      }
      if (value === null) unknownValues += 1;
      const key = symbol;
      const existing = positions.get(key);
      const lineCurrency = line.instrument.currency ?? line.price?.currency ?? line.value?.currency ?? null;
      if (!existing) {
        positions.set(key, {
          symbol,
          name: line.instrument.name,
          kind: line.instrument.kind,
          currency: lineCurrency,
          quantity: null,
          value: null,
          restricted: false,
          accountIds: [snapshot.accountId],
          valueDec: value,
          qtyDec: quantity,
          costKnownValue: line.costBasisComplete && value !== null ? value : new D(0),
        });
      } else {
        existing.accountIds = [...new Set([...existing.accountIds, snapshot.accountId])];
        existing.valueDec = existing.valueDec === null || value === null ? (existing.valueDec ?? value) : existing.valueDec.plus(value);
        existing.qtyDec = existing.qtyDec === null || quantity === null ? null : existing.qtyDec.plus(quantity);
        if (line.costBasisComplete && value !== null) existing.costKnownValue = existing.costKnownValue.plus(value);
      }
    }
  }

  const list = [...positions.values()].map((p) => ({
    ...p,
    quantity: p.qtyDec === null ? null : decString(p.qtyDec),
    value: p.valueDec === null ? null : roundToCurrency(money(p.valueDec, currency)),
  }));
  const known = list.filter((p) => p.valueDec !== null);
  const totalDec = known.reduce((acc, p) => acc.plus(p.valueDec!), new D(0));
  const totalMarketable = known.length > 0 ? roundToCurrency(money(totalDec, currency)) : null;

  const group = (keyOf: (p: (typeof list)[number]) => string) => {
    const totals = new Map<string, Dec>();
    for (const p of known) totals.set(keyOf(p), (totals.get(keyOf(p)) ?? new D(0)).plus(p.valueDec!));
    return [...totals.entries()].sort((a, b) => b[1].comparedTo(a[1]) || compareStrings(a[0], b[0]));
  };
  const allocation = group((p) => p.kind).map(([label, v]) => ({ label, value: roundToCurrency(money(v, currency)), share: share(v, totalDec) }));
  const currencyExposure = group((p) => p.currency ?? 'unknown').map(([code, v]) => ({ currency: code, value: roundToCurrency(money(v, currency)), share: share(v, totalDec) }));
  const concentration = group((p) => p.symbol).map(([label, v]) => {
    const s = totalDec.isZero() ? new D(0) : v.dividedBy(totalDec);
    return { label, share: share(v, totalDec), warning: s.greaterThan(threshold) };
  });
  const costKnown = known.reduce((acc, p) => acc.plus(p.costKnownValue), new D(0));
  const costBasisCompleteness = totalDec.greaterThan(0) ? share(costKnown, totalDec) : null;

  // Income.
  let income: PortfolioSummary['income'];
  if (input.income === null || input.income === undefined) income = { dividends: null, interest: null, fees: null };
  else {
    const sums: Record<'dividend' | 'interest' | 'fee', Dec | null> = { dividend: new D(0), interest: new D(0), fee: new D(0) };
    for (const entry of input.income) {
      const c = convertOrNull(entry.amount, currency, entry.date, fx, { method: 'historical' });
      const current = sums[entry.kind];
      if (current === null) continue;
      sums[entry.kind] = c.value === null ? null : current.plus(dec(c.value.amount).abs());
    }
    const out = (v: Dec | null) => (v === null ? null : roundToCurrency(money(v, currency)));
    income = { dividends: out(sums.dividend), interest: out(sums.interest), fees: out(sums.fee) };
  }

  const { performance, basis } = computePerformance(input.performance, currency, fx);
  let status: PortfolioSummary['status'] = 'ok';
  if (totalMarketable === null) status = 'insufficient_data';
  else if (unknownValues > 0 || partial) status = 'provisional';

  return {
    summary: {
      currency,
      status,
      totalMarketable,
      allocation,
      currencyExposure,
      concentration,
      costBasisCompleteness,
      income,
      performance,
      restricted,
    },
    positions: list
      .map(({ valueDec: _v, qtyDec: _q, costKnownValue: _c, ...p }) => p)
      .sort((a, b) => compareStrings(a.symbol, b.symbol)),
    performanceBasis: basis,
    appliedCorporateActions: applied,
  };
}

export function portfolioSummary(input: PortfolioInput): PortfolioSummary {
  return computePortfolio(input).summary;
}

// ------------------------------------------------------------------------------------------------------------
// Target allocation (paper simulation)
// ------------------------------------------------------------------------------------------------------------

export interface TargetWeight {
  /** Instrument kind or symbol, depending on `by`. */
  label: string;
  /** Fraction of the marketable total (0–1). */
  weight: string;
}

export interface TargetAllocationTrade {
  label: string;
  currentValue: Money;
  targetValue: Money;
  /** Positive = buy, negative = sell. */
  tradeValue: Money;
  side: 'buy' | 'sell' | 'hold';
  /** Units to trade at the given price (symbol mode only), rounded down to 8 decimals. */
  quantity: string | null;
}

export interface TargetAllocationResult {
  currency: string;
  trades: TargetAllocationTrade[];
  unallocated: Money;
  caveats: string[];
}

export const TARGET_ALLOCATION_CAVEATS = [
  'Paper simulation only: these are the trades that would match the target weights, not a recommendation.',
  'Taxes, fees, spreads, lot sizes and restrictions are not included.',
  'Restricted holdings are excluded and cannot be sold here.',
] as const;

/**
 * Trades needed (on paper) to move the marketable positions to target weights. Positions with unknown value
 * are left out and reported. Weights may sum to less than 1; the rest is reported as unallocated.
 */
export function simulateTargetAllocation(
  positions: readonly PortfolioPosition[],
  targets: readonly TargetWeight[],
  options: { currency: string; by: 'kind' | 'symbol'; prices?: Readonly<Record<string, Money>>; tolerance?: Money },
): TargetAllocationResult {
  const { currency } = options;
  const caveats: string[] = [...TARGET_ALLOCATION_CAVEATS];
  const weightSum = targets.reduce((acc, t) => acc.plus(dec(t.weight)), new D(0));
  if (targets.some((t) => dec(t.weight).isNegative())) throw new PlanningError('Target weights must not be negative');
  if (weightSum.greaterThan(1)) throw new PlanningError('Target weights must not add up to more than 1');
  if (new Set(targets.map((t) => t.label)).size !== targets.length) throw new PlanningError('Target labels must be unique');
  const current = new Map<string, Dec>();
  let total = new D(0);
  for (const p of positions) {
    if (p.restricted) continue;
    if (p.value === null) {
      caveats.push(`${p.symbol} has no known value and was left out.`);
      continue;
    }
    if (p.value.currency !== currency) throw new PlanningError(`Position values must be in ${currency}`);
    const label = options.by === 'kind' ? p.kind : p.symbol;
    current.set(label, (current.get(label) ?? new D(0)).plus(dec(p.value.amount)));
    total = total.plus(dec(p.value.amount));
  }
  const tolerance = options.tolerance ? dec(options.tolerance.amount) : new D(0);
  const labels = [...new Set([...targets.map((t) => t.label), ...current.keys()])].sort(compareStrings);
  const trades: TargetAllocationTrade[] = labels.map((label) => {
    const target = targets.find((t) => t.label === label);
    const targetValue = total.times(target ? dec(target.weight) : 0);
    const now = current.get(label) ?? new D(0);
    const delta = roundToCurrency(money(targetValue.minus(now), currency));
    const deltaDec = dec(delta.amount);
    const side = deltaDec.abs().lessThanOrEqualTo(tolerance) ? 'hold' : deltaDec.greaterThan(0) ? 'buy' : 'sell';
    const price = options.by === 'symbol' ? options.prices?.[label] : undefined;
    let quantity: string | null = null;
    if (price && side !== 'hold') {
      if (price.currency !== currency) throw new PlanningError(`Prices must be in ${currency}`);
      if (dec(price.amount).greaterThan(0)) quantity = decString(deltaDec.abs().dividedBy(dec(price.amount)), 8, 'down');
    }
    return {
      label,
      currentValue: roundToCurrency(money(now, currency)),
      targetValue: roundToCurrency(money(targetValue, currency)),
      tradeValue: side === 'hold' ? money('0', currency) : delta,
      side,
      quantity,
    };
  });
  return { currency, trades, unallocated: roundToCurrency(money(total.times(new D(1).minus(weightSum)), currency)), caveats };
}
