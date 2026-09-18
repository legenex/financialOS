/**
 * Composite read models: safe-to-spend, runway, wealth, the Today screen, the 13-week business
 * forecast, the consolidated view, per-entity cash summaries and the support tracker.
 *
 * Each function loads plain inputs and hands them to @financialos/domain. No arithmetic happens here.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type {
  AppSettings,
  BusinessCashWarning,
  CashForecast,
  ConsolidatedView,
  EntityCashSummary,
  Explanation,
  Freshness,
  NextAction,
  ResultStatus,
  RunwayResult,
  ScenarioAdjustment,
  SafeToSpendResult,
  SupportTracker,
  SupportTrackerEntry,
  TodayResponse,
  UpcomingCommitment,
  WealthSummary,
} from '@financialos/contracts';
import { coveragePeriods, exceptions as exceptionsTable, type DbOrTx } from '@financialos/db';
import {
  BUSINESS_ENTITY_KINDS,
  cashForecast,
  computeSafeToSpend as domainSafeToSpend,
  computeWealth,
  consolidateFlows,
  dec,
  entityFlowReport,
  money as makeMoney,
  reservesFromGoals,
  computeRunway,
  toConsolidatedEliminations,
  type AttributableThirdPartyResult,
  type CashFlowItem,
  type EntityInfo,
  type FxTable,
  type GoalContributionPlan,
  type IsoDate,
  type OpeningBalance,
  type RunwayInput,
  type SafeToSpendInput,
  type ThirdPartyHolding,
  type WealthScope,
} from '@financialos/domain';
import type { AppContext } from '../context';
import { loadFxTable, loadSettings, normalizeDecimal, reportingToday, shiftDays, uniqueIds } from './common';
import {
  entityInfo,
  loadAccountBundles,
  planningAccount,
  planningEntity,
  wealthAccount,
  type AccountBundle,
  type EntityRow,
} from './accounts';
import {
  listObligationRows,
  listReceivableRows,
  listRecurringRows,
  loadGoals,
  loadScenario,
  obligationFlowSources,
  receivableFlowSources,
  recurringFlowSources,
  type ObligationRow,
  type RecurringRow,
} from './planning';
import { loadAttributableThirdParty, loadClearingSummaries, type ClearingBundle } from './thirdparty';
import { counterpartyEntities, loadClassifiedRows, toConsolidationFlows, toRunwayFlows } from './transactions';
import { goalContributions, goals as goalsTable, entities as entitiesTable } from '@financialos/db';

export interface FinanceBase {
  settings: AppSettings;
  now: Date;
  today: IsoDate;
  fx: FxTable;
  entityRows: EntityRow[];
  entities: EntityInfo[];
  primaryOwner: EntityRow | null;
  accounts: AccountBundle[];
  clearing: ClearingBundle[];
  thirdParty: AttributableThirdPartyResult;
}

/** Loads the shared inputs used by every money view. Nothing is cached between requests. */
export async function loadFinanceBase(ctx: AppContext): Promise<FinanceBase> {
  const db = ctx.db;
  const now = ctx.clock.now();
  const settings = await loadSettings(db);
  const today = reportingToday(settings, now);
  const [fx, entityRows] = await Promise.all([
    loadFxTable(db),
    db.select().from(entitiesTable).orderBy(desc(entitiesTable.primaryOwner), asc(entitiesTable.name)).limit(500),
  ]);
  const accounts = await loadAccountBundles(db, {
    fx,
    now,
    staleAfterHours: settings.staleAfterHours,
    reportingCurrency: settings.reportingCurrency,
  });
  const clearing = await loadClearingSummaries(db, { fallbackCurrency: settings.reportingCurrency });
  const entities = entityRows.map(entityInfo);
  const thirdParty = await loadAttributableThirdParty(db, {
    entities,
    clearing,
    accounts: accounts.map((b) => ({
      id: b.row.id,
      name: b.row.name,
      legalEntityId: b.row.legalEntityId,
      economicOwnerEntityId: b.row.economicOwnerEntityId,
      value:
        b.account.valuation.value.amount !== null && b.account.valuation.value.currency !== null
          ? { amount: b.account.valuation.value.amount, currency: b.account.valuation.value.currency }
          : null,
    })),
  });
  return {
    settings,
    now,
    today,
    fx,
    entityRows,
    entities,
    primaryOwner: entityRows.find((e) => e.primaryOwner) ?? null,
    accounts,
    clearing,
    thirdParty,
  };
}

export function thirdPartyHoldings(base: FinanceBase): ThirdPartyHolding[] {
  return base.thirdParty.items
    .filter((item) => item.accountId !== null)
    .map((item) => ({
      accountId: item.accountId as string,
      arrangementId: item.arrangementId ?? 'unknown',
      label: item.note,
      amount: item.amount,
    }));
}

function businessEntityIds(base: FinanceBase): string[] {
  return base.entityRows.filter((e) => e.ownerControlled && BUSINESS_ENTITY_KINDS.includes(e.kind)).map((e) => e.id);
}

async function scenarioFor(db: DbOrTx, scenarioId: string | undefined): Promise<{ id: string; adjustments: ScenarioAdjustment[] } | null> {
  if (!scenarioId) return null;
  const bundle = await loadScenario(db, scenarioId);
  return bundle ? { id: bundle.scenario.id, adjustments: bundle.adjustments } : null;
}

// ---------------------------------------------------------------------------------------------
// Safe to spend
// ---------------------------------------------------------------------------------------------

export interface SafeToSpendOptions {
  horizonDays?: number;
  scenarioId?: string;
  extraFlows?: readonly CashFlowItem[];
}

export async function buildSafeToSpendInput(ctx: AppContext, base: FinanceBase, options: SafeToSpendOptions = {}): Promise<SafeToSpendInput> {
  const db = ctx.db;
  const ownerId = base.primaryOwner?.id ?? '';
  const horizonDays = options.horizonDays ?? base.settings.safeToSpendHorizonDays;
  const horizonTo = shiftDays(base.today, horizonDays + 31);
  const personalEntityIds = ownerId ? [ownerId] : [];
  const [recurringRows, obligationRows, receivableRows, goals, plannedContributions, scenario] = await Promise.all([
    listRecurringRows(db, { entityIds: personalEntityIds }),
    listObligationRows(db, { entityIds: personalEntityIds, to: horizonTo }),
    listReceivableRows(db, { entityIds: personalEntityIds }),
    loadGoals(db, { asOf: base.today, fx: base.fx }),
    db
      .select({ contribution: goalContributions, goalName: goalsTable.name, heldIn: goalsTable.heldIn })
      .from(goalContributions)
      .innerJoin(goalsTable, eq(goalContributions.goalId, goalsTable.id))
      .where(and(eq(goalContributions.status, 'planned'), gte(goalContributions.contributedOn, base.today), lte(goalContributions.contributedOn, horizonTo)))
      .limit(500),
    scenarioFor(db, options.scenarioId),
  ]);
  const contributionPlans: GoalContributionPlan[] = plannedContributions.map((row) => ({
    id: row.contribution.id,
    goalId: row.contribution.goalId,
    goalName: row.goalName,
    date: row.contribution.contributedOn,
    amount: { amount: normalizeDecimal(row.contribution.amount), currency: row.contribution.currency },
    // Only money that actually leaves the eligible cash accounts reduces spending capacity.
    commitment: row.heldIn === 'separate_accounts',
  }));
  return {
    now: base.now.toISOString(),
    today: base.today,
    primaryOwnerEntityId: ownerId,
    entities: base.entityRows.map(planningEntity),
    accounts: base.accounts.map(planningAccount),
    thirdPartyHoldings: thirdPartyHoldings(base),
    recurring: recurringFlowSources(recurringRows),
    obligations: obligationFlowSources(obligationRows),
    receivables: receivableFlowSources(receivableRows),
    goalContributions: contributionPlans,
    reserves: reservesFromGoals(goals),
    ...(options.extraFlows ? { extraFlows: options.extraFlows } : {}),
    scenario,
    settings: {
      budgetCurrency: base.settings.budgetCurrency,
      horizonDays,
      horizonBasis: base.settings.safeToSpendHorizonBasis,
      includeNearCash: base.settings.includeNearCashInSafeToSpend,
      staleAfterHours: base.settings.staleAfterHours,
    },
    fx: base.fx,
  };
}

export async function safeToSpendFor(ctx: AppContext, base: FinanceBase, options: SafeToSpendOptions = {}): Promise<SafeToSpendResult> {
  const input = await buildSafeToSpendInput(ctx, base, options);
  return domainSafeToSpend(input).result;
}

// ---------------------------------------------------------------------------------------------
// Runway
// ---------------------------------------------------------------------------------------------

async function historyStartFor(db: DbOrTx, accountIds: readonly string[]): Promise<IsoDate | null> {
  if (accountIds.length === 0) return null;
  const [row] = await db
    .select({ from: sql<string | null>`min(${coveragePeriods.fromDate})` })
    .from(coveragePeriods)
    .where(and(inArray(coveragePeriods.accountId, [...accountIds]), eq(coveragePeriods.active, true)));
  return row?.from ?? null;
}

export async function runwayFor(ctx: AppContext, base: FinanceBase, scope: RunwayInput['scope'], scopeEntityIds: readonly string[]): Promise<RunwayResult> {
  const db = ctx.db;
  const accountIds = base.accounts
    .filter((b) => (scope.kind === 'personal' ? b.row.economicOwnerEntityId && scopeEntityIds.includes(b.row.economicOwnerEntityId) : b.row.legalEntityId && scopeEntityIds.includes(b.row.legalEntityId)))
    .map((b) => b.row.id);
  const from = shiftDays(base.today, -400);
  const rows = accountIds.length > 0 ? await loadClassifiedRows(db, { accountIds, from, to: base.today }, 50_000) : [];
  const counterparties = await counterpartyEntities(db, rows);
  const historyStart = await historyStartFor(db, accountIds);
  const currency = scope.kind === 'personal' ? base.settings.budgetCurrency : base.settings.reportingCurrency;
  return computeRunway({
    scope,
    scopeEntityIds,
    asOf: base.today,
    currency,
    entities: base.entityRows.map(planningEntity),
    accounts: base.accounts.map(planningAccount),
    thirdPartyHoldings: thirdPartyHoldings(base),
    includeNearCash: base.settings.includeNearCashInSafeToSpend,
    flows: toRunwayFlows(rows, counterparties),
    historyStart,
    minimumHistoryMonths: base.settings.runwayMinimumHistoryMonths,
    fx: base.fx,
  }).result;
}

export async function allRunways(ctx: AppContext, base: FinanceBase): Promise<RunwayResult[]> {
  const results: RunwayResult[] = [];
  const ownerId = base.primaryOwner?.id;
  if (ownerId) {
    results.push(await runwayFor(ctx, base, { kind: 'personal', entityId: ownerId, label: base.primaryOwner?.name ?? 'Personal' }, [ownerId]));
  }
  for (const id of businessEntityIds(base)) {
    const entity = base.entityRows.find((e) => e.id === id);
    results.push(await runwayFor(ctx, base, { kind: 'entity', entityId: id, label: entity?.name ?? 'Business' }, [id]));
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Wealth
// ---------------------------------------------------------------------------------------------

export function wealthFor(base: FinanceBase, scope: WealthScope): WealthSummary {
  return computeWealth({
    scope,
    entities: base.entities,
    accounts: base.accounts.map(wealthAccount),
    thirdParty: base.thirdParty,
    reportingCurrency: base.settings.reportingCurrency,
    fx: base.fx,
    asOf: base.today,
  });
}

// ---------------------------------------------------------------------------------------------
// Forecast (13 weeks)
// ---------------------------------------------------------------------------------------------

export async function forecastFor(
  ctx: AppContext,
  base: FinanceBase,
  options: { entityId: string | null; scenarioId?: string; weeks?: number },
): Promise<CashForecast> {
  const db = ctx.db;
  const entity = options.entityId ? base.entityRows.find((e) => e.id === options.entityId) : null;
  if (options.entityId && !entity) throw new Error('unknown entity');
  const scopeIds = options.entityId ? [options.entityId] : businessEntityIds(base);
  const currency = base.settings.reportingCurrency;
  const openings: OpeningBalance[] = base.accounts
    .filter((b) => b.row.legalEntityId !== null && scopeIds.includes(b.row.legalEntityId) && (b.row.liquidityClass === 'cash' || b.row.liquidityClass === 'near_cash'))
    .map((b) => ({
      id: b.row.id,
      label: b.row.name,
      balance:
        b.account.valuation.value.amount !== null && b.account.valuation.value.currency !== null
          ? { amount: b.account.valuation.value.amount, currency: b.account.valuation.value.currency }
          : null,
      links: [{ kind: 'account' as const, id: b.row.id, label: b.row.name }],
    }));
  const horizonTo = shiftDays(base.today, (options.weeks ?? 13) * 7 + 7);
  const [recurringRows, obligationRows, receivableRows, scenario] = await Promise.all([
    listRecurringRows(db, { entityIds: scopeIds }),
    listObligationRows(db, { entityIds: scopeIds, to: horizonTo }),
    listReceivableRows(db, { entityIds: scopeIds }),
    scenarioFor(db, options.scenarioId),
  ]);
  return cashForecast({
    entityId: options.entityId,
    label: entity?.name ?? 'All businesses',
    currency,
    startDate: base.today,
    weeks: options.weeks ?? 13,
    weekStartsOn: base.settings.weekStartsOn,
    openings,
    recurring: recurringFlowSources(recurringRows),
    receivablesPayables: receivableFlowSources(receivableRows),
    obligations: obligationFlowSources(obligationRows),
    scenario,
    fx: base.fx,
  });
}

// ---------------------------------------------------------------------------------------------
// Consolidated view, entity cash summaries and the support tracker
// ---------------------------------------------------------------------------------------------

async function scopedFlows(db: DbOrTx, base: FinanceBase, entityIds: readonly string[], from: IsoDate, to: IsoDate) {
  const accountIds = base.accounts.filter((b) => b.row.legalEntityId !== null && entityIds.includes(b.row.legalEntityId)).map((b) => b.row.id);
  const rows = accountIds.length > 0 ? await loadClassifiedRows(db, { accountIds, from, to }, 50_000) : [];
  const counterparties = await counterpartyEntities(db, rows);
  return { rows, flows: toConsolidationFlows(rows, counterparties), counterparties };
}

export async function consolidatedView(
  ctx: AppContext,
  base: FinanceBase,
  options: { entityIds?: readonly string[]; from: IsoDate; to: IsoDate },
): Promise<ConsolidatedView> {
  const scope = uniqueIds(options.entityIds && options.entityIds.length > 0 ? options.entityIds : [base.primaryOwner?.id, ...businessEntityIds(base)]);
  const { flows } = await scopedFlows(ctx.db, base, scope, options.from, options.to);
  const result = consolidateFlows(flows, scope, base.entities);
  const currency = base.settings.reportingCurrency;
  const cashAccounts = base.accounts.filter(
    (b) => b.row.legalEntityId !== null && scope.includes(b.row.legalEntityId) && (b.row.liquidityClass === 'cash' || b.row.liquidityClass === 'near_cash'),
  );
  const unknown = cashAccounts.some((b) => b.account.valuation.value.amount === null);
  const wealth = wealthFor(base, { kind: 'consolidated' });
  const cashSegment = wealth.segments.find((s) => s.liquidityClass === 'cash') ?? null;
  const status: ResultStatus = unknown ? 'provisional' : cashSegment?.total ? 'ok' : 'insufficient_data';
  const thirdPartyTotal = base.thirdParty.totals.find((t) => t.currency === currency) ?? null;
  return {
    entityIds: scope,
    currency,
    cash: cashSegment?.total ?? null,
    eliminated: toConsolidatedEliminations(result),
    thirdPartyExcluded: thirdPartyTotal,
    status,
    explanation: result.explanation,
  };
}

const CASH_DISCLAIMER =
  'Cash basis from recorded movements only. Incomplete categories are not audited profit and this is not a statutory financial statement.';

export async function entityCashSummaries(
  ctx: AppContext,
  base: FinanceBase,
  options: { entityIds?: readonly string[]; from: IsoDate; to: IsoDate },
): Promise<EntityCashSummary[]> {
  const ids = uniqueIds(options.entityIds && options.entityIds.length > 0 ? options.entityIds : businessEntityIds(base));
  const out: EntityCashSummary[] = [];
  for (const entityId of ids) {
    const entity = base.entityRows.find((e) => e.id === entityId);
    if (!entity) continue;
    const { rows, flows } = await scopedFlows(ctx.db, base, [entityId], options.from, options.to);
    const report = entityFlowReport(flows, entityId, base.entities);
    const currency = entity.baseCurrency ?? base.settings.reportingCurrency;
    const totals = report.totals.find((t) => t.currency === currency) ?? report.totals[0] ?? null;
    const cashAccounts = base.accounts.filter((b) => b.row.legalEntityId === entityId && (b.row.liquidityClass === 'cash' || b.row.liquidityClass === 'near_cash'));
    const knownCash = cashAccounts.filter((b) => b.account.valuation.value.amount !== null && b.account.valuation.value.currency === currency);
    const cash =
      cashAccounts.length === 0
        ? null
        : knownCash.length === cashAccounts.length
          ? makeMoney(knownCash.reduce((acc, b) => acc.plus(dec(b.account.valuation.value.amount as string)), dec('0')), currency)
          : null;
    const cashStatus: ResultStatus = cashAccounts.length === 0 ? 'insufficient_data' : cash ? 'ok' : 'provisional';
    const unclassifiedCount = rows.filter((r) => !r.classification || r.classification.nature === 'unknown' || r.classification.needsReview).length;
    const byNature = new Map(report.byNature.filter((n) => n.currency === currency).map((n) => [n.nature, n.total]));
    const receivables = await listReceivableRows(ctx.db, { entityIds: [entityId] });
    const openOf = (kind: 'receivable' | 'payable') => {
      const open = receivables.filter((r) => r.kind === kind && (r.status === 'open' || r.status === 'partial') && r.currency === currency);
      if (open.length === 0) return null;
      return makeMoney(open.reduce((acc, r) => acc.plus(dec(normalizeDecimal(r.outstanding))), dec('0')), currency);
    };
    out.push({
      entityId,
      name: entity.name,
      currency,
      cash,
      cashStatus,
      basis: 'cash',
      periodIn: totals ? totals.inflows : null,
      periodOut: totals ? totals.outflows : null,
      categories: report.byNature
        .filter((n) => n.currency === currency)
        .map((n) => ({ label: n.nature, amount: n.total, complete: unclassifiedCount === 0 })),
      unclassifiedCount,
      receivablesOpen: openOf('receivable'),
      payablesOpen: openOf('payable'),
      intercompanyIn: byNature.get('intercompany') ?? null,
      intercompanyOut: null,
      ownerContributions: byNature.get('owner_contribution') ?? null,
      ownerDrawings: byNature.get('owner_drawing') ?? null,
      disclaimer: CASH_DISCLAIMER,
    });
  }
  return out;
}

const SUPPORT_NATURES = new Set(['business_support', 'owner_contribution', 'owner_drawing', 'loan_repayment']);

export async function supportTracker(ctx: AppContext, base: FinanceBase, options: { from: IsoDate; to: IsoDate }): Promise<SupportTracker> {
  const scope = uniqueIds([base.primaryOwner?.id, ...businessEntityIds(base)]);
  const { rows, counterparties } = await scopedFlows(ctx.db, base, scope, options.from, options.to);
  const currency = base.settings.reportingCurrency;
  const entries: SupportTrackerEntry[] = [];
  for (const row of rows) {
    const nature = row.classification?.nature ?? 'unknown';
    if (!SUPPORT_NATURES.has(nature)) continue;
    const rowCurrency = row.record.currency ?? row.accountCurrency;
    if (row.record.amount === null || rowCurrency === null || !row.record.bookedOn || row.accountEntityId === null) continue;
    const amount = normalizeDecimal(row.record.amount);
    const other = counterparties.get(row.record.id) ?? null;
    const inflow = !amount.startsWith('-');
    entries.push({
      date: row.record.bookedOn,
      fromEntityId: inflow ? (other ?? row.accountEntityId) : row.accountEntityId,
      toEntityId: inflow ? row.accountEntityId : (other ?? row.accountEntityId),
      amount: { amount: amount.startsWith('-') ? amount.slice(1) : amount, currency: rowCurrency },
      nature: nature === 'loan_repayment' ? 'loan_repayment' : (nature as SupportTrackerEntry['nature']),
      transactionId: row.record.id,
      note: null,
    });
  }
  const totals = new Map<string, ReturnType<typeof dec>>();
  for (const entry of entries) {
    if (entry.amount.currency !== currency) continue;
    totals.set(entry.toEntityId, (totals.get(entry.toEntityId) ?? dec('0')).plus(dec(entry.amount.amount)));
    totals.set(entry.fromEntityId, (totals.get(entry.fromEntityId) ?? dec('0')).minus(dec(entry.amount.amount)));
  }
  return {
    currency,
    entries,
    totalsByEntity: [...totals.entries()].map(([entityId, total]) => ({
      entityId,
      name: base.entityRows.find((e) => e.id === entityId)?.name ?? 'Entity',
      netSupport: makeMoney(total, currency),
    })),
    asOf: base.now.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------------------------

function upcomingFrom(obligations: readonly ObligationRow[], recurring: readonly RecurringRow[], today: IsoDate, windowDays: number): UpcomingCommitment[] {
  const to = shiftDays(today, windowDays);
  const items: UpcomingCommitment[] = [];
  for (const o of obligations) {
    if (o.status !== 'upcoming' || o.dueOn < today || o.dueOn > to) continue;
    items.push({
      id: `obligation:${o.id}`,
      date: o.dueOn,
      label: o.label,
      amount: o.amount !== null && o.currency !== null ? { amount: normalizeDecimal(o.amount), currency: o.currency } : null,
      entityId: o.entityId,
      kind: o.kind,
      links: [{ kind: 'obligation', id: o.id, label: o.label }],
    });
  }
  for (const r of recurring) {
    if (r.status !== 'active' || r.direction !== 'out' || !r.nextDueOn || r.nextDueOn < today || r.nextDueOn > to) continue;
    items.push({
      id: `recurring:${r.id}`,
      date: r.nextDueOn,
      label: r.name,
      amount: r.amount !== null && r.currency !== null ? { amount: normalizeDecimal(r.amount), currency: r.currency } : null,
      entityId: r.entityId,
      kind: r.kind,
      links: [{ kind: 'recurring', id: r.id, label: r.name }],
    });
  }
  return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1)).slice(0, 20);
}

function nextActionsFrom(input: {
  openExceptions: number;
  unclassified: number;
  staleAccounts: number;
  safeToSpend: SafeToSpendResult;
  accounts: number;
}): NextAction[] {
  const actions: NextAction[] = [];
  if (input.accounts === 0) {
    actions.push({ id: 'connect', title: 'Add your first account', why: 'There is nothing to report on yet.', impact: 'high', href: '/connections', kind: 'connect' });
  }
  if (input.unclassified > 0) {
    actions.push({
      id: 'classify',
      title: `Classify ${input.unclassified} transaction${input.unclassified === 1 ? '' : 's'}`,
      why: 'Unclassified money keeps budgets and runway provisional.',
      impact: 'high',
      href: '/money/transactions?needsReview=true',
      kind: 'classify',
    });
  }
  if (input.safeToSpend.status !== 'ok') {
    actions.push({
      id: 'safe_to_spend',
      title: 'Complete the inputs for safe-to-spend',
      why: `Safe-to-spend is ${input.safeToSpend.status.replace('_', ' ')} because some inputs are missing.`,
      impact: 'high',
      href: '/inbox',
      kind: 'verify',
    });
  }
  if (input.staleAccounts > 0) {
    actions.push({
      id: 'refresh',
      title: `Refresh ${input.staleAccounts} stale account${input.staleAccounts === 1 ? '' : 's'}`,
      why: 'Balances older than your staleness setting are not used with confidence.',
      impact: 'medium',
      href: '/connections',
      kind: 'import',
    });
  }
  if (input.openExceptions > 0) {
    actions.push({
      id: 'inbox',
      title: `Clear ${input.openExceptions} item${input.openExceptions === 1 ? '' : 's'} in the inbox`,
      why: 'Open questions hold back reconciliation and reporting.',
      impact: 'medium',
      href: '/inbox',
      kind: 'review',
    });
  }
  return actions.slice(0, 3);
}

export async function buildToday(ctx: AppContext, base: FinanceBase, options: { scenarioId?: string } = {}): Promise<TodayResponse> {
  const db = ctx.db;
  const ownerId = base.primaryOwner?.id;
  const [safeToSpend, runways, openExceptionsRow] = await Promise.all([
    safeToSpendFor(ctx, base, options.scenarioId ? { scenarioId: options.scenarioId } : {}),
    allRunways(ctx, base),
    db.select({ n: sql<number>`count(*)::int` }).from(exceptionsTable).where(eq(exceptionsTable.status, 'open')),
  ]);
  const personalRunway =
    runways.find((r) => r.scope.kind === 'personal') ??
    ({
      scope: { kind: 'personal', entityId: ownerId ?? null, label: 'Personal' },
      status: 'insufficient_data',
      months: null,
      depletionDate: null,
      liquidBalance: null,
      averageMonthlyNetOutflow: null,
      historyMonths: 0,
      minimumHistoryMonths: base.settings.runwayMinimumHistoryMonths,
      explanation: emptyExplanation('Personal runway', 'liquid balance ÷ average monthly net outflow'),
    } satisfies RunwayResult);

  const scopeIds = ownerId ? [ownerId, ...businessEntityIds(base)] : businessEntityIds(base);
  const [obligationRows, recurringRows] = await Promise.all([
    listObligationRows(db, { entityIds: scopeIds, from: base.today, to: shiftDays(base.today, 30), status: 'upcoming' }),
    listRecurringRows(db, { entityIds: scopeIds, status: 'active' }),
  ]);

  const businessWarnings: BusinessCashWarning[] = [];
  for (const result of runways) {
    if (result.scope.kind !== 'entity' || !result.scope.entityId) continue;
    if (result.status === 'finite' && result.months !== null && dec(result.months).lessThan(3)) {
      businessWarnings.push({
        entityId: result.scope.entityId,
        entityName: result.scope.label,
        severity: dec(result.months).lessThan(1) ? 'critical' : 'warning',
        message: `${result.scope.label} has about ${result.months} months of runway at the recent net outflow.`,
        href: `/business?entityId=${result.scope.entityId}`,
      });
    } else if (result.status === 'insufficient_data' || result.status === 'insufficient_history') {
      businessWarnings.push({
        entityId: result.scope.entityId,
        entityName: result.scope.label,
        severity: 'info',
        message: `${result.scope.label} does not have enough recorded history to show a runway yet.`,
        href: `/business?entityId=${result.scope.entityId}`,
      });
    }
  }

  const freshness: Freshness[] = base.accounts
    .slice()
    .sort((a, b) => (a.account.freshness.lastUpdatedAt ?? '') < (b.account.freshness.lastUpdatedAt ?? '') ? -1 : 1)
    .slice(0, 8)
    .map((b) => ({ label: b.row.name, lastUpdatedAt: b.account.freshness.lastUpdatedAt, state: b.account.freshness.state }));

  const unclassified = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(exceptionsTable)
    .where(and(eq(exceptionsTable.status, 'open'), eq(exceptionsTable.kind, 'unclassified')));

  const wealth = wealthFor(base, { kind: 'personal' });
  const openExceptions = openExceptionsRow[0]?.n ?? 0;

  return {
    asOf: base.now.toISOString(),
    reportingCurrency: base.settings.reportingCurrency,
    budgetCurrency: base.settings.budgetCurrency,
    safeToSpend,
    personalRunway,
    upcoming: upcomingFrom(obligationRows, recurringRows, base.today, 30),
    businessWarnings,
    freshness,
    nextActions: nextActionsFrom({
      openExceptions,
      unclassified: unclassified[0]?.n ?? 0,
      staleAccounts: base.accounts.filter((b) => b.account.freshness.state === 'stale').length,
      safeToSpend,
      accounts: base.accounts.length,
    }),
    wealth,
    openExceptions,
    budgetProgress: null,
  };
}

export function emptyExplanation(summary: string, formula: string): Explanation {
  return { summary, formula, items: [], assumptions: [], missing: ['No inputs were available.'] };
}
