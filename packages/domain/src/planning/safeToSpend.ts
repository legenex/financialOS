/**
 * Safe-to-spend: how much eligible personal cash can be spent before the next horizon without missing a
 * dated obligation or eating into protected reserves.
 *
 *   eligible cash = Σ fresh, known balances of the primary owner's personal cash accounts − third-party money in them
 *   lowest        = minimum of the dated projection starting from eligible cash (each obligation once, on its date)
 *   safe          = max(0, lowest − protected reserves held inside eligible accounts)
 *   shortfall     = the negative part of (lowest − reserves), when there is one
 */
import type { Confidence, Goal, Money, SafeToSpendResult, ScenarioAdjustment, SourceLink } from '@financialos/contracts';
import { addDays, diffDays, type IsoDate } from '../dates';
import type { FxTable } from '../fx';
import { D, dec, money, roundToCurrency, type Dec } from '../money';
import {
  expandRecurringFlows,
  goalCommitmentFlows,
  horizonEnd,
  obligationFlows,
  projectCashFlow,
  receivablePayableFlows,
  type CashFlowItem,
  type CashFlowMode,
  type CashFlowProjection,
  type GoalContributionPlan,
  type ObligationFlowSource,
  type OpeningBalance,
  type ReceivablePayableFlowSource,
  type RecurringFlowSource,
} from './cashflow';
import { ExplanationBuilder } from './explain-local';
import { applyScenario } from './scenarios';
import { ageInHours, convertOrNull, PlanningError } from './shared';
import { accountLink, BUSINESS_ENTITY_KINDS, type PlanningAccount, type PlanningEntity, type ThirdPartyHolding } from './types';

export interface SafeToSpendSettings {
  budgetCurrency: string;
  horizonDays: number;
  horizonBasis: 'fixed_days' | 'next_income';
  includeNearCash: boolean;
  staleAfterHours: number;
  /** Upper bound for the next-income horizon (default 120 days). */
  maxNextIncomeDays?: number;
  fxMaxStalenessDays?: number;
  cashFlowMode?: CashFlowMode;
}

export interface ProtectedReserve {
  id: string;
  name: string;
  heldIn: Goal['heldIn'];
  /** Amount protected. Null = unknown. */
  amount: Money | null;
  /** How the amount was chosen, for the explanation. */
  basis: string;
}

export interface SafeToSpendInput {
  /** Evaluation instant (ISO date-time). */
  now: string;
  /** Today's calendar date in the reporting time zone. */
  today: IsoDate;
  primaryOwnerEntityId: string;
  entities: readonly PlanningEntity[];
  accounts: readonly PlanningAccount[];
  thirdPartyHoldings?: readonly ThirdPartyHolding[];
  recurring?: readonly RecurringFlowSource[];
  obligations?: readonly ObligationFlowSource[];
  receivables?: readonly ReceivablePayableFlowSource[];
  goalContributions?: readonly GoalContributionPlan[];
  /** Additional dated items (e.g. a simulated purchase). */
  extraFlows?: readonly CashFlowItem[];
  reserves?: readonly ProtectedReserve[];
  scenario?: { id: string; adjustments: readonly ScenarioAdjustment[] } | null;
  /**
   * Whether recurring/obligation data has ever been confirmed by the owner. When omitted it is derived: any
   * confirmed recurring item or any owner-entered obligation counts.
   */
  planningDataConfirmed?: boolean;
  settings: SafeToSpendSettings;
  fx: FxTable;
}

/** Detailed result: the contract object plus the engine output for reuse (purchase impact, coach). */
export interface SafeToSpendComputation {
  result: SafeToSpendResult;
  projection: CashFlowProjection | null;
  eligibleAccountIds: string[];
  excludedAccounts: Array<{ accountId: string; reason: string }>;
  protectedReserves: Money;
}

const EXCLUDED_KINDS: Partial<Record<PlanningAccount['kind'], string>> = {
  credit_card: 'Credit card: credit limits are not cash',
  restricted_equity: 'Restricted asset: never part of spending capacity',
  pension: 'Pension: not accessible spending cash',
  property: 'Property: not liquid',
  mortgage: 'Liability: not cash',
  loan: 'Liability: not cash',
  private_investment: 'Private investment: not liquid',
};

const LIQUIDITY_REASONS: Record<PlanningAccount['liquidityClass'], string | null> = {
  cash: null,
  near_cash: 'Near-cash is excluded by the safe-to-spend setting',
  marketable: 'Marketable investments are not guaranteed spending cash',
  restricted: 'Restricted asset: never part of spending capacity',
  illiquid: 'Illiquid asset',
  property: 'Property: not liquid',
  liability: 'Liability or credit line: credit limits and buying power are not cash',
  receivable: 'Receivable: not yet received',
  contingent: 'Contingent: not certain',
};

const RESERVE_KINDS: ReadonlySet<Goal['kind']> = new Set(['emergency_reserve', 'reserve']);

/**
 * Protected reserves from goals. Reserve-type goals protect their target (a floor to keep); other protected
 * goals protect the verified amount already set aside (capped at the target). Archived goals protect nothing.
 */
export function reservesFromGoals(goals: ReadonlyArray<Pick<Goal, 'id' | 'name' | 'kind' | 'protected' | 'heldIn' | 'status' | 'target' | 'fundedVerified'>>): ProtectedReserve[] {
  return goals
    .filter((g) => g.protected && g.status !== 'archived')
    .map((g) => {
      if (RESERVE_KINDS.has(g.kind)) return { id: g.id, name: g.name, heldIn: g.heldIn, amount: g.target, basis: 'reserve target' };
      const funded = dec(g.fundedVerified.amount);
      const capped = funded.greaterThan(dec(g.target.amount)) ? g.target : g.fundedVerified;
      return { id: g.id, name: g.name, heldIn: g.heldIn, amount: capped, basis: 'verified amount set aside' };
    });
}

function classifyAccount(account: PlanningAccount, input: SafeToSpendInput, entities: Map<string, PlanningEntity>): string | null {
  const owner = account.economicOwnerEntityId;
  if (owner === null) return 'Economic owner unconfirmed';
  if (owner !== input.primaryOwnerEntityId) {
    const kind = entities.get(owner)?.kind;
    if (kind === 'third_party') return 'Third-party money: belongs to someone else';
    if (kind && BUSINESS_ENTITY_KINDS.includes(kind)) return 'Business account: company cash is not personal spending money';
    return 'Belongs to another entity';
  }
  if (account.legalEntityId !== null && account.legalEntityId !== input.primaryOwnerEntityId) {
    const legalKind = entities.get(account.legalEntityId)?.kind;
    if (legalKind && BUSINESS_ENTITY_KINDS.includes(legalKind)) return 'Business account: company cash is not personal spending money';
    if (legalKind === 'third_party') return 'Held by a third party';
  }
  const kindReason = EXCLUDED_KINDS[account.kind];
  if (kindReason) return kindReason;
  if (account.liquidityClass === 'near_cash' && input.settings.includeNearCash) {
    // allowed by setting
  } else {
    const reason = LIQUIDITY_REASONS[account.liquidityClass];
    if (reason) return reason;
  }
  if (!account.includeInSafeToSpend) return 'Excluded from safe-to-spend by the owner';
  return null;
}

const INCOME_KINDS = new Set(['salary', 'income']);

function findNextIncome(flows: readonly CashFlowItem[], today: IsoDate): CashFlowItem | null {
  const candidates = flows
    .filter((f) => f.direction === 'in' && f.certainty === 'committed' && f.amount !== null && f.date > today)
    .filter((f) => f.source === 'receivable' || INCOME_KINDS.has(f.kind ?? ''))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  return candidates[0] ?? null;
}

export function computeSafeToSpend(input: SafeToSpendInput): SafeToSpendComputation {
  const { settings, fx, today } = input;
  const currency = settings.budgetCurrency;
  if (!Number.isFinite(settings.staleAfterHours) || settings.staleAfterHours <= 0) throw new PlanningError('staleAfterHours must be positive');
  const entities = new Map(input.entities.map((e) => [e.id, e]));
  const fxStale = settings.fxMaxStalenessDays ?? 7;
  const ex = new ExplanationBuilder('', '');
  ex.formula(
    'safe to spend = max(0, lowest projected eligible cash in the horizon − protected reserves held in eligible accounts); ' +
      'eligible cash = fresh known personal cash balances − third-party money held in them',
  );
  const issues: string[] = [];
  const noteIssue = (text: string) => {
    if (!issues.includes(text)) issues.push(text);
  };

  // 1. Eligible accounts and opening balances.
  const openings: OpeningBalance[] = [];
  const eligibleAccountIds: string[] = [];
  const excludedAccounts: SafeToSpendComputation['excludedAccounts'] = [];
  const holdingsByAccount = new Map<string, ThirdPartyHolding[]>();
  for (const holding of input.thirdPartyHoldings ?? []) {
    holdingsByAccount.set(holding.accountId, [...(holdingsByAccount.get(holding.accountId) ?? []), holding]);
  }
  let oldestUsedAgeHours = 0;
  let classifiedEligible = 0;

  for (const account of input.accounts) {
    if (account.status === 'closed') continue;
    const link = accountLink(account);
    if (account.creditLimit) {
      ex.excluded(`${account.name}: credit limit`, account.creditLimit, { note: 'Credit limits and buying power are not cash', links: [link] });
    }
    const reason = classifyAccount(account, input, entities);
    if (reason) {
      excludedAccounts.push({ accountId: account.id, reason });
      ex.excluded(account.name, account.balance, { note: reason, links: [link] });
      continue;
    }
    classifiedEligible += 1;
    if (account.balance === null) {
      openings.push({ id: account.id, label: account.name, balance: null, links: [link] });
      ex.missing(`${account.name}: balance unknown`, { links: [link] });
      noteIssue('unknown_balance');
      continue;
    }
    if (account.balanceAsOf === null) {
      openings.push({ id: account.id, label: account.name, balance: null, links: [link] });
      ex.missing(`${account.name}: balance date unknown, so its freshness cannot be confirmed`, { value: account.balance, links: [link] });
      noteIssue('stale_balance');
      continue;
    }
    const age = ageInHours(account.balanceAsOf, input.now);
    if (age > settings.staleAfterHours) {
      openings.push({ id: account.id, label: account.name, balance: null, links: [link] });
      ex.missing(`${account.name}: balance is stale (${Math.floor(age)} h old, limit ${settings.staleAfterHours} h) and was not counted`, {
        value: account.balance,
        links: [link],
      });
      noteIssue('stale_balance');
      continue;
    }
    const converted = convertOrNull(account.balance, currency, today, fx, { maxStalenessDays: fxStale });
    if (converted.value === null) {
      openings.push({ id: account.id, label: account.name, balance: null, links: [link] });
      ex.missing(`${account.name}: ${converted.reason}`, { value: account.balance, links: [link] });
      noteIssue('missing_fx');
      continue;
    }
    let net: Dec = dec(converted.value.amount);
    ex.input(`${account.name} balance`, converted.value, { note: `As of ${account.balanceAsOf}`, links: [link], fx: converted.fx });
    for (const holding of holdingsByAccount.get(account.id) ?? []) {
      const holdingLinks: SourceLink[] = [{ kind: 'arrangement', id: holding.arrangementId, label: holding.label }, link];
      if (holding.amount === null) {
        ex.missing(`${holding.label}: third-party amount in ${account.name} is unknown`, { links: holdingLinks });
        noteIssue('unknown_third_party');
        continue;
      }
      const tp = convertOrNull(holding.amount, currency, today, fx, { maxStalenessDays: fxStale });
      if (tp.value === null) {
        ex.missing(`${holding.label}: ${tp.reason}`, { value: holding.amount, links: holdingLinks });
        noteIssue('missing_fx');
        continue;
      }
      net = net.minus(dec(tp.value.amount));
      ex.subtracted(`${holding.label} (third-party money in ${account.name})`, tp.value, { note: 'Belongs to a third party', links: holdingLinks, fx: tp.fx });
    }
    oldestUsedAgeHours = Math.max(oldestUsedAgeHours, age);
    eligibleAccountIds.push(account.id);
    openings.push({ id: account.id, label: account.name, balance: money(net, currency), links: [link] });
  }
  if (classifiedEligible === 0) ex.missing('No eligible personal cash accounts are configured');

  // 2. Dated flows in scope.
  const personal = (entityId: string | null | undefined) => entityId === null || entityId === undefined || entityId === input.primaryOwnerEntityId;
  const recurringInScope = (input.recurring ?? []).filter((r) => personal(r.entityId));
  const obligationsInScope = (input.obligations ?? []).filter((o) => personal(o.entityId));
  const receivablesInScope = (input.receivables ?? []).filter((r) => personal(r.entityId));
  const outOfScope =
    (input.recurring ?? []).length - recurringInScope.length + (input.obligations ?? []).length - obligationsInScope.length + (input.receivables ?? []).length - receivablesInScope.length;
  if (outOfScope > 0) ex.assume(`${outOfScope} recurring items, obligations or receivables belong to other entities and are not part of personal safe-to-spend`);

  const maxIncomeDays = settings.maxNextIncomeDays ?? 120;
  const searchEnd = addDays(today, Math.max(settings.horizonDays, maxIncomeDays));
  const buildFlows = (end: IsoDate) => {
    const expansion = expandRecurringFlows(recurringInScope, today, end);
    const rp = receivablePayableFlows(receivablesInScope);
    let flows: CashFlowItem[] = [
      ...expansion.flows,
      ...obligationFlows(obligationsInScope),
      ...rp.flows,
      ...goalCommitmentFlows((input.goalContributions ?? []).filter((g) => g.commitment)),
      ...(input.extraFlows ?? []),
    ];
    if (input.scenario && input.scenario.adjustments.length > 0) {
      flows = applyScenario(flows, input.scenario.adjustments, { scenarioId: input.scenario.id }).items;
    }
    return { flows, expansion, undated: rp.undated };
  };

  // 3. Horizon.
  let to = horizonEnd(today, settings.horizonDays);
  let basis = `Fixed ${settings.horizonDays} days`;
  if (settings.horizonBasis === 'next_income') {
    const next = findNextIncome(buildFlows(searchEnd).flows, today);
    if (next) {
      to = next.date;
      basis = `Until the next confirmed income on ${next.date} (${next.label})`;
    } else {
      ex.assume(`No confirmed income date found within ${maxIncomeDays} days; using a fixed ${settings.horizonDays}-day horizon`);
    }
  }
  const { flows, expansion, undated } = buildFlows(to);
  for (const item of expansion.unscheduled) {
    ex.missing(`${item.name}: recurring item has no next due date and could not be scheduled`, { links: [{ kind: 'recurring', id: item.id, label: item.name }] });
    noteIssue('unscheduled_recurring');
  }
  for (const item of expansion.pastDue) {
    ex.assume(`${item.name}: the expected payment on ${item.nextDueOn} has not been matched yet; check whether it is still outstanding`);
  }
  for (const item of undated) {
    ex.missing(`${item.label}: no expected date`, { links: [{ kind: 'receivable', id: item.id, label: item.label }] });
  }

  const planningConfirmed =
    input.planningDataConfirmed ?? (recurringInScope.some((r) => r.confirmed) || obligationsInScope.length > 0);
  if (!planningConfirmed) {
    ex.missing('No recurring bills or obligations have been confirmed yet, so upcoming commitments may be missing');
    noteIssue('unconfirmed_planning');
  }

  // 4. Projection.
  const projection = projectCashFlow(openings, flows, {
    from: today,
    to,
    currency,
    mode: settings.cashFlowMode ?? 'committed_only',
    fx,
    fxDate: today,
    fxMaxStalenessDays: fxStale,
  });
  for (const flow of projection.applied) {
    const label = `${flow.label} on ${flow.date}`;
    const note = [flow.estimate ? 'estimated amount' : null, flow.weight !== '1' ? `weighted by probability ${flow.weight}` : null, flow.overdue ? `overdue since ${flow.originalDate}` : null]
      .filter(Boolean)
      .join('; ');
    if (flow.direction === 'out') ex.subtracted(label, flow.amount, { note: note || null, links: flow.links, fx: flow.fx });
    else ex.added(label, flow.amount, { note: note || null, links: flow.links, fx: flow.fx });
  }
  for (const unknown of projection.unknownAmounts) {
    ex.missing(`${unknown.label} on ${unknown.date}: amount unknown`, { links: unknown.links });
    noteIssue(unknown.direction === 'out' ? 'unknown_obligation' : 'unknown_inflow');
  }
  for (const skipped of projection.skipped) {
    if (skipped.reason === 'outside_horizon') continue;
    ex.excluded(`${skipped.label} on ${skipped.date}`, null, { note: skipped.detail, links: skipped.links });
  }
  if (projection.unconverted.length > 0) noteIssue('missing_fx');

  // 5. Protected reserves.
  let reserveTotal = new D(0);
  for (const reserve of input.reserves ?? []) {
    const links: SourceLink[] = [{ kind: 'goal', id: reserve.id, label: reserve.name }];
    if (reserve.heldIn !== 'eligible_cash_accounts') {
      const note = reserve.heldIn === 'separate_accounts' ? 'Already outside eligible cash' : 'Not yet funded: nothing is set aside in eligible cash';
      ex.excluded(`Protected reserve: ${reserve.name}`, reserve.amount, { note, links });
      continue;
    }
    if (reserve.amount === null) {
      ex.missing(`Protected reserve ${reserve.name}: amount unknown`, { links });
      noteIssue('unknown_reserve');
      continue;
    }
    const converted = convertOrNull(reserve.amount, currency, today, fx, { maxStalenessDays: fxStale });
    if (converted.value === null) {
      ex.missing(`Protected reserve ${reserve.name}: ${converted.reason}`, { value: reserve.amount, links });
      noteIssue('missing_fx');
      continue;
    }
    reserveTotal = reserveTotal.plus(dec(converted.value.amount));
    ex.subtracted(`Protected reserve: ${reserve.name}`, converted.value, { note: `Held in eligible accounts (${reserve.basis}); subtracted once from the lowest point`, links, fx: converted.fx });
  }
  const protectedReserves = roundToCurrency(money(reserveTotal, currency));

  // 6. Result.
  const horizonDays = diffDays(today, to);
  const horizon = { from: today, to, days: horizonDays, basis };
  const computedAt = input.now;
  if (projection.opening === null) {
    ex.summary('Safe to spend is not available: no eligible personal cash account has a fresh, known balance.');
    const result: SafeToSpendResult = {
      status: 'insufficient_data',
      amount: null,
      shortfall: null,
      currency,
      horizon,
      eligibleCash: null,
      lowestProjectedBalance: null,
      lowestProjectedOn: null,
      protectedReserves,
      obligationsInHorizon: projection.outflows,
      expectedInflowsInHorizon: projection.inflows,
      unknownAmountObligations: projection.unknownOutflowCount,
      confidence: 'none',
      timeline: [],
      explanation: ex.build(),
      computedAt,
    };
    return { result, projection, eligibleAccountIds, excludedAccounts, protectedReserves };
  }

  const lowest = projection.lowest!;
  const available = dec(lowest.amount).minus(reserveTotal);
  const amount = roundToCurrency(money(available.isNegative() ? new D(0) : available, currency));
  const shortfall = available.isNegative() ? roundToCurrency(money(available.negated(), currency)) : null;
  const status: SafeToSpendResult['status'] = issues.length > 0 ? 'provisional' : 'ok';
  let confidence: Confidence;
  if (status === 'provisional') confidence = issues.length >= 2 ? 'low' : 'medium';
  else confidence = oldestUsedAgeHours <= settings.staleAfterHours / 2 ? 'high' : 'medium';

  ex.result('Eligible cash', projection.opening, { note: 'Sum of fresh eligible balances after third-party money' });
  ex.result('Lowest projected balance', lowest, { note: `On ${projection.lowestOn}` });
  ex.result('Protected reserves held in eligible accounts', protectedReserves);
  if (shortfall) ex.result('Shortfall', shortfall, { note: 'Obligations and reserves exceed eligible cash in the horizon' });
  ex.result('Safe to spend', amount);
  ex.assume(
    settings.cashFlowMode === 'probability_weighted'
      ? 'Expected items are weighted by their probability'
      : 'All outflows in the horizon are counted in full; only committed or confirmed inflows are counted',
  );
  ex.assume('Items dated on the same day are applied outflows first');
  ex.summary(
    `Safe to spend through ${to}: ${amount.amount} ${currency}${shortfall ? ` (shortfall ${shortfall.amount} ${currency})` : ''}${status === 'provisional' ? ', provisional because some data is missing' : ''}.`,
  );

  const result: SafeToSpendResult = {
    status,
    amount,
    shortfall,
    currency,
    horizon,
    eligibleCash: projection.opening,
    lowestProjectedBalance: lowest,
    lowestProjectedOn: projection.lowestOn,
    protectedReserves,
    obligationsInHorizon: projection.outflows,
    expectedInflowsInHorizon: projection.inflows,
    unknownAmountObligations: projection.unknownOutflowCount,
    confidence,
    timeline: projection.timeline,
    explanation: ex.build(),
    computedAt,
  };
  return { result, projection, eligibleAccountIds, excludedAccounts, protectedReserves };
}

/** Convenience wrapper returning only the contract object. */
export function safeToSpend(input: SafeToSpendInput): SafeToSpendResult {
  return computeSafeToSpend(input).result;
}
