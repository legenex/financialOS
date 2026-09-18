/**
 * 13-week business cash forecast per entity, built on the dated cash-flow engine.
 * Expected receivables and payables are probability-weighted by default (the usual convention for a rolling
 * cash forecast); pass `mode: 'committed_only'` for the conservative view.
 */
import type { CashForecast, ForecastWeek, Money, ScenarioAdjustment } from '@financialos/contracts';
import { addDays, isoWeekday, type IsoDate } from '../dates';
import type { FxTable } from '../fx';
import { D, dec, money, type Dec } from '../money';
import {
  expandRecurringFlows,
  obligationFlows,
  projectCashFlow,
  receivablePayableFlows,
  type AppliedFlow,
  type CashFlowItem,
  type CashFlowMode,
  type ObligationFlowSource,
  type OpeningBalance,
  type ReceivablePayableFlowSource,
  type RecurringFlowSource,
} from './cashflow';
import { ExplanationBuilder } from './explain-local';
import { applyScenario } from './scenarios';
import { convertOrNull, PlanningError } from './shared';

export type WeekStart = 'monday' | 'sunday' | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface CashForecastInput {
  entityId: string | null;
  label: string;
  currency: string;
  startDate: IsoDate;
  /** Number of weeks (default 13). */
  weeks?: number;
  /** Configured first day of the week ('monday', 'sunday', or ISO weekday 1–7). */
  weekStartsOn: WeekStart;
  openings: readonly OpeningBalance[];
  recurring?: readonly RecurringFlowSource[];
  receivablesPayables?: readonly ReceivablePayableFlowSource[];
  obligations?: readonly ObligationFlowSource[];
  extraFlows?: readonly CashFlowItem[];
  scenario?: { id: string; name?: string; adjustments: readonly ScenarioAdjustment[] } | null;
  mode?: CashFlowMode;
  lowCashThreshold?: Money | null;
  fx?: FxTable;
}

function isoStartDay(weekStartsOn: WeekStart): number {
  if (weekStartsOn === 'monday') return 1;
  if (weekStartsOn === 'sunday') return 7;
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 1 || weekStartsOn > 7) throw new PlanningError(`Invalid week start: ${String(weekStartsOn)}`);
  return weekStartsOn;
}

/** First day of the week containing `date`, for any configured start weekday. */
export function weekStartFor(date: IsoDate, weekStartsOn: WeekStart): IsoDate {
  const offset = (isoWeekday(date) - isoStartDay(weekStartsOn) + 7) % 7;
  return addDays(date, -offset);
}

function forecastSource(flow: AppliedFlow | { source: AppliedFlow['source']; direction: 'in' | 'out' }): ForecastWeek['items'][number]['source'] {
  switch (flow.source) {
    case 'recurring':
    case 'receivable':
    case 'payable':
    case 'obligation':
    case 'scenario':
      return flow.source;
    default:
      return flow.direction === 'out' ? 'obligation' : 'receivable';
  }
}

export function cashForecast(input: CashForecastInput): CashForecast {
  const weeks = input.weeks ?? 13;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104) throw new PlanningError(`Forecast weeks must be between 1 and 104: ${weeks}`);
  const { currency } = input;
  const firstWeek = weekStartFor(input.startDate, input.weekStartsOn);
  const end = addDays(firstWeek, weeks * 7 - 1);
  const mode = input.mode ?? 'probability_weighted';
  const ex = new ExplanationBuilder('', 'weekly closing = opening + inflows − outflows; each item applied once on its date');
  const warnings: string[] = [];

  const matchesEntity = (entityId: string | null | undefined) => input.entityId === null || entityId === input.entityId;
  const expansion = expandRecurringFlows((input.recurring ?? []).filter((r) => matchesEntity(r.entityId)), input.startDate, end);
  const rp = receivablePayableFlows((input.receivablesPayables ?? []).filter((r) => matchesEntity(r.entityId)));
  let flows: CashFlowItem[] = [
    ...expansion.flows,
    ...rp.flows,
    ...obligationFlows((input.obligations ?? []).filter((o) => matchesEntity(o.entityId))),
    ...(input.extraFlows ?? []),
  ];
  if (input.scenario && input.scenario.adjustments.length > 0) {
    const application = applyScenario(flows, input.scenario.adjustments, { scenarioId: input.scenario.id, scenarioName: input.scenario.name });
    flows = application.items;
    ex.assume(`Scenario applied with ${application.changes.length} change${application.changes.length === 1 ? '' : 's'}`, {
      links: [{ kind: 'scenario', id: input.scenario.id, label: input.scenario.name ?? 'Scenario' }],
    });
  }

  const projection = projectCashFlow(input.openings, flows, { from: input.startDate, to: end, currency, mode, fx: input.fx, fxDate: input.startDate });
  for (const opening of input.openings) {
    if (opening.balance) ex.input(`${opening.label} opening balance`, opening.balance, { links: opening.links });
  }
  for (const unknown of projection.openingUnknown) ex.missing(`${unknown.label}: ${unknown.reason}`, { links: unknown.links });
  for (const item of expansion.unscheduled) ex.missing(`${item.name}: recurring item has no next due date`, { links: [{ kind: 'recurring', id: item.id, label: item.name }] });
  for (const item of rp.undated) ex.missing(`${item.label}: no expected or due date`, { links: [{ kind: 'receivable', id: item.id, label: item.label }] });
  for (const u of projection.unknownAmounts) ex.missing(`${u.label} on ${u.date}: amount unknown`, { links: u.links });
  for (const u of projection.unconverted) ex.missing(`${u.label}: ${u.reason}`, { value: u.original });
  for (const s of projection.skipped) {
    if (s.reason !== 'outside_horizon') ex.excluded(`${s.label} on ${s.date}`, null, { note: s.detail, links: s.links });
  }
  ex.assume(mode === 'probability_weighted' ? 'Expected receivables and payables are weighted by their probability' : 'Only committed inflows are counted; all outflows count in full');

  let threshold: Money | null = null;
  if (input.lowCashThreshold) {
    if (input.lowCashThreshold.currency === currency) threshold = input.lowCashThreshold;
    else if (input.fx) {
      const converted = convertOrNull(input.lowCashThreshold, currency, input.startDate, input.fx);
      threshold = converted.value;
      if (!threshold) warnings.push(`The low-cash threshold could not be converted to ${currency}.`);
    } else warnings.push(`The low-cash threshold could not be converted to ${currency}.`);
  }

  if (projection.opening === null) {
    ex.summary(`${input.label}: the forecast needs a known opening cash balance.`);
    warnings.push('Opening cash is unknown, so weekly balances cannot be projected.');
    return {
      entityId: input.entityId,
      label: input.label,
      currency,
      status: 'insufficient_data',
      scenarioId: input.scenario?.id ?? null,
      weeks: [],
      lowestClosing: null,
      lowestClosingWeek: null,
      warnings,
      explanation: ex.build(),
    };
  }

  const result: ForecastWeek[] = [];
  let balance: Dec = dec(projection.opening.amount);
  let lowest: { value: Dec; week: IsoDate } | null = null;
  for (let i = 0; i < weeks; i += 1) {
    const weekStart = addDays(firstWeek, i * 7);
    const weekEnd = addDays(weekStart, 6);
    const inWeek = projection.applied.filter((f) => f.date >= weekStart && f.date <= weekEnd);
    const opening = balance;
    let inflows = new D(0);
    let outflows = new D(0);
    let intraLow: { value: Dec; date: IsoDate } | null = null;
    for (const flow of inWeek) {
      const amount = dec(flow.amount.amount);
      if (flow.direction === 'in') {
        inflows = inflows.plus(amount);
        balance = balance.plus(amount);
      } else {
        outflows = outflows.plus(amount);
        balance = balance.minus(amount);
      }
      if (intraLow === null || balance.lessThan(intraLow.value)) intraLow = { value: balance, date: flow.date };
    }
    const unknownItems = projection.unknownAmounts.filter((u) => u.date >= weekStart && u.date <= weekEnd).length;
    const closing = balance;
    result.push({
      weekStart,
      weekEnd,
      openingBalance: money(opening, currency),
      inflows: money(inflows, currency),
      outflows: money(outflows, currency),
      closingBalance: money(closing, currency),
      unknownItems,
      items: inWeek.map((flow) => ({
        date: flow.date,
        label: flow.label,
        amount: flow.amount,
        direction: flow.direction,
        source: forecastSource(flow),
        probability: flow.probability,
        links: flow.links,
      })),
    });
    if (lowest === null || closing.lessThan(lowest.value)) lowest = { value: closing, week: weekStart };
    if (closing.isNegative() && !closing.isZero()) {
      warnings.push(`Week of ${weekStart}: closing cash of ${money(closing, currency).amount} ${currency} is below zero.`);
    } else if (threshold && closing.lessThan(dec(threshold.amount))) {
      warnings.push(`Week of ${weekStart}: closing cash of ${money(closing, currency).amount} ${currency} is below the low-cash threshold of ${threshold.amount} ${currency}.`);
    } else if (intraLow && intraLow.value.isNegative() && !intraLow.value.isZero()) {
      warnings.push(`Week of ${weekStart}: cash dips below zero during the week (${money(intraLow.value, currency).amount} ${currency} on ${intraLow.date}).`);
    }
  }
  if (projection.unknownAmounts.length > 0) {
    warnings.push(`${projection.unknownAmounts.length} forecast item${projection.unknownAmounts.length === 1 ? ' has' : 's have'} an unknown amount and ${projection.unknownAmounts.length === 1 ? 'is' : 'are'} not included.`);
  }

  const lowestClosing = lowest ? money(lowest.value, currency) : null;
  ex.result('Lowest weekly closing', lowestClosing, { note: lowest ? `Week of ${lowest.week}` : null });
  ex.summary(
    `${input.label}: ${weeks}-week cash forecast from ${firstWeek}; lowest weekly closing ${lowestClosing?.amount ?? 'unknown'} ${currency}${projection.status === 'provisional' ? ' (provisional)' : ''}.`,
  );
  return {
    entityId: input.entityId,
    label: input.label,
    currency,
    status: projection.status,
    scenarioId: input.scenario?.id ?? null,
    weeks: result,
    lowestClosing,
    lowestClosingWeek: lowest?.week ?? null,
    warnings,
    explanation: ex.build(),
  };
}
