/**
 * Runway: how many months liquid money lasts at the trailing average net outflow.
 *
 *   liquid balance      = Σ known cash (+ near-cash when enabled) balances in scope − third-party money in them
 *   monthly net outflow = average over trailing complete, covered months of −(Σ signed operating flows)
 *   months              = liquid balance / monthly net outflow
 *
 * Internal movements (transfers, investment and property flows, third-party money, FX conversions, and
 * intercompany/salary/owner flows between entities inside the scope) are excluded. Business support is counted
 * but reported on its own line. Restricted and illiquid assets are never part of the balance.
 */
import type { Money, RunwayResult, SourceLink, TransactionNature } from '@financialos/contracts';
import { addDays, addMonths, daysInMonth, monthKey, parseIsoDate, type IsoDate } from '../dates';
import type { FxTable } from '../fx';
import { D, dec, money, roundToCurrency, type Dec } from '../money';
import { ExplanationBuilder } from './explain-local';
import { compareStrings, convertOrNull, decString, PlanningError } from './shared';
import { accountLink, BUSINESS_ENTITY_KINDS, type PlanningAccount, type PlanningEntity, type ThirdPartyHolding } from './types';

export interface RunwayFlow {
  id: string;
  accountId: string;
  date: IsoDate;
  /** Signed amount: positive = money in, negative = money out (account currency). Split lines are separate flows. */
  amount: Money;
  nature: TransactionNature;
  /** Owner-controlled counterparty entity, when known (used to eliminate movements inside the scope). */
  counterpartyEntityId?: string | null;
  status?: 'pending' | 'posted' | 'reversed' | 'superseded';
  label?: string;
}

export interface RunwayInput {
  scope: { kind: 'personal' | 'entity'; entityId: string | null; label: string };
  /** Entities inside the scope: the primary owner for personal runway, or the entity (or group) for business runway. */
  scopeEntityIds: readonly string[];
  asOf: IsoDate;
  currency: string;
  entities: readonly PlanningEntity[];
  accounts: readonly PlanningAccount[];
  thirdPartyHoldings?: readonly ThirdPartyHolding[];
  includeNearCash: boolean;
  flows: readonly RunwayFlow[];
  /** Months (YYYY-MM) whose history is complete. Takes precedence over `historyStart`. */
  coveredMonths?: readonly string[];
  /** Date from which history is complete. */
  historyStart?: IsoDate | null;
  minimumHistoryMonths: number;
  /** Maximum number of trailing complete months to average (default 6). */
  trailingMonths?: number;
  fx: FxTable;
  fxMaxStalenessDays?: number;
}

export interface RunwayMonth {
  month: string;
  inflows: Money;
  outflows: Money;
  netOutflow: Money;
  businessSupport: Money;
}

export interface RunwayComputation {
  result: RunwayResult;
  months: RunwayMonth[];
  excludedFlows: Array<{ nature: TransactionNature | 'internal_to_scope'; total: Money; count: number }>;
}

export const RUNWAY_EXCLUDED_NATURES: ReadonlySet<TransactionNature> = new Set([
  'transfer_internal',
  'investment_contribution',
  'investment_withdrawal',
  'investment_trade',
  'property_purchase',
  'third_party',
  'fx_conversion',
]);

const INTERNAL_WHEN_IN_SCOPE: ReadonlySet<TransactionNature> = new Set([
  'intercompany',
  'salary',
  'owner_contribution',
  'owner_drawing',
  'business_support',
  'loan_repayment',
  'payroll',
]);

const LIQUID_FLOW_KINDS: ReadonlySet<PlanningAccount['kind']> = new Set(['credit_card', 'card']);
const NEVER_LIQUID_KINDS: ReadonlySet<PlanningAccount['kind']> = new Set(['restricted_equity', 'pension', 'property', 'mortgage', 'loan', 'private_investment']);

function inScope(account: PlanningAccount, input: RunwayInput, entities: Map<string, PlanningEntity>): boolean {
  const scope = new Set(input.scopeEntityIds);
  const ownerKind = account.economicOwnerEntityId ? entities.get(account.economicOwnerEntityId)?.kind : undefined;
  if (ownerKind === 'third_party') return false;
  if (input.scope.kind === 'personal') {
    if (account.economicOwnerEntityId === null || !scope.has(account.economicOwnerEntityId)) return false;
    const legalKind = account.legalEntityId ? entities.get(account.legalEntityId)?.kind : undefined;
    return !(legalKind && BUSINESS_ENTITY_KINDS.includes(legalKind));
  }
  return account.legalEntityId !== null && scope.has(account.legalEntityId);
}

function completeMonths(input: RunwayInput, earliestFlow: IsoDate | null, ex: ExplanationBuilder): string[] {
  const currentMonth = monthKey(input.asOf);
  if (input.coveredMonths) {
    return [...new Set(input.coveredMonths)].filter((m) => m < currentMonth).sort(compareStrings);
  }
  let start = input.historyStart ?? null;
  if (start === null && earliestFlow !== null) {
    start = earliestFlow;
    ex.assume(`History is assumed to be complete from the first recorded flow on ${earliestFlow}`);
  }
  if (start === null) return [];
  const first = parseIsoDate(start).d === 1 ? start : addMonths(`${monthKey(start)}-01`, 1);
  const months: string[] = [];
  for (let cursor = `${monthKey(first)}-01`; monthKey(cursor) < currentMonth; cursor = addMonths(cursor, 1)) months.push(monthKey(cursor));
  return months;
}

/** Date reached after `months` (fractional) from `from`: whole calendar months, then the fraction of the next month in days. */
export function depletionDateAfter(from: IsoDate, months: Dec): IsoDate {
  if (months.isNegative()) throw new PlanningError('Months must not be negative');
  const whole = months.floor();
  const base = addMonths(from, whole.toNumber());
  const { y, m } = parseIsoDate(base);
  const days = months.minus(whole).times(daysInMonth(y, m)).floor().toNumber();
  return addDays(base, days);
}

export function computeRunway(input: RunwayInput): RunwayComputation {
  const { currency, fx } = input;
  const entities = new Map(input.entities.map((e) => [e.id, e]));
  const trailing = input.trailingMonths ?? 6;
  if (trailing < 1 || input.minimumHistoryMonths < 1) throw new PlanningError('History month settings must be at least 1');
  const fxStale = input.fxMaxStalenessDays ?? 7;
  const scopeSet = new Set(input.scopeEntityIds);
  const ex = new ExplanationBuilder('', 'months = liquid balance ÷ average monthly net outflow over trailing complete months');

  // Balance.
  const scopedAccounts = input.accounts.filter((a) => a.status === 'active' && inScope(a, input, entities));
  const holdings = new Map<string, ThirdPartyHolding[]>();
  for (const h of input.thirdPartyHoldings ?? []) holdings.set(h.accountId, [...(holdings.get(h.accountId) ?? []), h]);
  let balance: Dec | null = new D(0);
  let liquidCount = 0;
  const flowAccountIds = new Set<string>();
  for (const account of scopedAccounts) {
    const link = accountLink(account);
    const liquidClass = account.liquidityClass === 'cash' || account.liquidityClass === 'near_cash';
    if (liquidClass || LIQUID_FLOW_KINDS.has(account.kind)) flowAccountIds.add(account.id);
    const counted = !NEVER_LIQUID_KINDS.has(account.kind) && (account.liquidityClass === 'cash' || (account.liquidityClass === 'near_cash' && input.includeNearCash));
    if (!counted) {
      const reason =
        account.liquidityClass === 'near_cash'
          ? 'Near-cash excluded by setting'
          : account.liquidityClass === 'restricted' || account.kind === 'restricted_equity'
            ? 'Restricted asset: never counted in runway'
            : `Not liquid cash (${account.liquidityClass})`;
      ex.excluded(account.name, account.balance, { note: reason, links: [link] });
      continue;
    }
    liquidCount += 1;
    if (account.balance === null) {
      ex.missing(`${account.name}: balance unknown`, { links: [link] });
      balance = null;
      continue;
    }
    const converted = convertOrNull(account.balance, currency, input.asOf, fx, { maxStalenessDays: fxStale });
    if (converted.value === null) {
      ex.missing(`${account.name}: ${converted.reason}`, { value: account.balance, links: [link] });
      balance = null;
      continue;
    }
    ex.input(`${account.name} balance`, converted.value, { note: account.balanceAsOf ? `As of ${account.balanceAsOf}` : null, links: [link], fx: converted.fx });
    let net = dec(converted.value.amount);
    for (const h of holdings.get(account.id) ?? []) {
      const hLinks: SourceLink[] = [{ kind: 'arrangement', id: h.arrangementId, label: h.label }, link];
      const tp = h.amount === null ? null : convertOrNull(h.amount, currency, input.asOf, fx, { maxStalenessDays: fxStale });
      if (tp === null || tp.value === null) {
        ex.missing(`${h.label}: third-party amount in ${account.name} unknown`, { links: hLinks });
        balance = null;
        continue;
      }
      net = net.minus(dec(tp.value.amount));
      ex.subtracted(`${h.label} (third-party money)`, tp.value, { links: hLinks, fx: tp.fx });
    }
    if (balance !== null) balance = balance.plus(net);
  }
  if (liquidCount === 0) {
    ex.missing('No liquid accounts in this scope');
    balance = null;
  }

  // Flows.
  const relevant = input.flows.filter((f) => flowAccountIds.has(f.accountId) && f.status !== 'reversed' && f.status !== 'superseded');
  const earliest = relevant.reduce<IsoDate | null>((acc, f) => (acc === null || f.date < acc ? f.date : acc), null);
  const available = completeMonths(input, earliest, ex);
  const used = available.slice(-trailing);
  const usedSet = new Set(used);
  const monthTotals = new Map<string, { inflows: Dec; outflows: Dec; support: Dec }>(used.map((m) => [m, { inflows: new D(0), outflows: new D(0), support: new D(0) }]));
  const excluded = new Map<string, { total: Dec; count: number }>();
  let unconverted = 0;
  let unknownNature = 0;
  for (const flow of relevant) {
    const bucket = monthTotals.get(monthKey(flow.date));
    if (!bucket || !usedSet.has(monthKey(flow.date))) continue;
    const internal = INTERNAL_WHEN_IN_SCOPE.has(flow.nature) && flow.counterpartyEntityId !== null && flow.counterpartyEntityId !== undefined && scopeSet.has(flow.counterpartyEntityId);
    if (RUNWAY_EXCLUDED_NATURES.has(flow.nature) || internal) {
      const key = internal ? 'internal_to_scope' : flow.nature;
      const converted = convertOrNull(flow.amount, currency, flow.date, fx, { maxStalenessDays: fxStale, method: 'historical' });
      const entry = excluded.get(key) ?? { total: new D(0), count: 0 };
      excluded.set(key, { total: converted.value ? entry.total.plus(dec(converted.value.amount).abs()) : entry.total, count: entry.count + 1 });
      continue;
    }
    const converted = convertOrNull(flow.amount, currency, flow.date, fx, { maxStalenessDays: fxStale, method: 'historical' });
    if (converted.value === null) {
      unconverted += 1;
      continue;
    }
    if (flow.nature === 'unknown') unknownNature += 1;
    const amount = dec(converted.value.amount);
    if (amount.isNegative()) bucket.outflows = bucket.outflows.plus(amount.negated());
    else bucket.inflows = bucket.inflows.plus(amount);
    if (flow.nature === 'business_support') bucket.support = bucket.support.plus(amount.negated());
  }
  if (unconverted > 0) ex.missing(`${unconverted} flows could not be converted to ${currency} and were left out of the average`);
  if (unknownNature > 0) ex.assume(`${unknownNature} unclassified flows were counted as operating cash flow`);

  const months: RunwayMonth[] = used.map((m) => {
    const t = monthTotals.get(m)!;
    return {
      month: m,
      inflows: roundToCurrency(money(t.inflows, currency)),
      outflows: roundToCurrency(money(t.outflows, currency)),
      netOutflow: roundToCurrency(money(t.outflows.minus(t.inflows), currency)),
      businessSupport: roundToCurrency(money(t.support, currency)),
    };
  });
  const excludedFlows = [...excluded.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([nature, v]) => ({ nature: nature as TransactionNature | 'internal_to_scope', total: roundToCurrency(money(v.total, currency)), count: v.count }));
  for (const e of excludedFlows) {
    const label = e.nature === 'internal_to_scope' ? 'Movements between entities inside this scope' : `Excluded ${e.nature.replace(/_/g, ' ')} flows`;
    ex.excluded(`${label} (${e.count})`, e.total, { note: 'Not operating cash flow' });
  }

  const historyMonths = used.length;
  const base = {
    scope: input.scope,
    historyMonths,
    minimumHistoryMonths: input.minimumHistoryMonths,
  };
  const liquidBalance = balance === null ? null : roundToCurrency(money(balance, currency));
  if (liquidBalance) ex.result('Liquid balance', liquidBalance);

  if (liquidBalance === null) {
    ex.summary(`Runway for ${input.scope.label} is not available: the liquid balance is not fully known.`);
    return { result: { ...base, status: 'insufficient_data', months: null, depletionDate: null, liquidBalance: null, averageMonthlyNetOutflow: null, explanation: ex.build() }, months, excludedFlows };
  }
  if (historyMonths < input.minimumHistoryMonths) {
    ex.missing(`Only ${historyMonths} complete month${historyMonths === 1 ? '' : 's'} of history; at least ${input.minimumHistoryMonths} are needed`);
    ex.summary(`Runway for ${input.scope.label} needs more history before a figure can be shown.`);
    return {
      result: { ...base, status: 'insufficient_history', months: null, depletionDate: null, liquidBalance, averageMonthlyNetOutflow: null, explanation: ex.build() },
      months,
      excludedFlows,
    };
  }

  const totalNet = months.reduce((acc, m) => acc.plus(dec(m.netOutflow.amount)), new D(0));
  const average = totalNet.dividedBy(historyMonths);
  const averageMoney = roundToCurrency(money(average, currency));
  for (const m of months) {
    ex.input(`${m.month} net outflow`, m.netOutflow, { note: `In ${m.inflows.amount}, out ${m.outflows.amount}` });
  }
  const supportTotal = months.reduce((acc, m) => acc.plus(dec(m.businessSupport.amount)), new D(0));
  if (!supportTotal.isZero()) {
    const supportAverage = roundToCurrency(money(supportTotal.dividedBy(historyMonths), currency));
    ex.input('Business support (monthly average, included above)', supportAverage, {
      note: `Without it the average monthly net outflow would be ${roundToCurrency(money(average.minus(dec(supportAverage.amount)), currency)).amount}`,
    });
  }
  ex.result('Average monthly net outflow', averageMoney, { note: `Over ${historyMonths} complete months (${used[0]} to ${used[used.length - 1]})` });

  if (!average.greaterThan(0)) {
    ex.summary(`${input.scope.label} is not depleting: money in has matched or exceeded money out over the last ${historyMonths} months.`);
    return {
      result: { ...base, status: 'not_depleting', months: null, depletionDate: null, liquidBalance, averageMonthlyNetOutflow: averageMoney, explanation: ex.build() },
      months,
      excludedFlows,
    };
  }

  const monthsLeft = balance!.greaterThan(0) ? balance!.dividedBy(average) : new D(0);
  const monthsText = decString(monthsLeft, 2, 'down');
  const depletionDate = depletionDateAfter(input.asOf, dec(monthsText));
  ex.result('Runway (months)', null, { note: `${monthsText} months, reaching zero around ${depletionDate} at the current pace` });
  ex.summary(`${input.scope.label}: about ${monthsText} months of runway at the trailing average net outflow.`);
  return {
    result: { ...base, status: 'finite', months: monthsText, depletionDate, liquidBalance, averageMonthlyNetOutflow: averageMoney, explanation: ex.build() },
    months,
    excludedFlows,
  };
}

export function runway(input: RunwayInput): RunwayResult {
  return computeRunway(input).result;
}
