/**
 * Dated cash-flow projection engine.
 *
 * Every item has a stable id and is applied at most once, on its date. Items sharing an id are treated as the
 * same real-world payment (for example a recurring bill occurrence that was also entered as a one-off
 * obligation) and only the most specific version is applied. Unknown amounts are never treated as zero: they
 * appear on the timeline as `unknown_amount` points that do not move the balance, are counted separately, and
 * downgrade the status.
 *
 * Conservative default (`committed_only`): every outflow in the horizon is counted in full, and only
 * committed/confirmed inflows are counted. `probability_weighted` weights expected items by probability.
 */
import type {
  Confidence,
  FxProvenance,
  Money,
  Obligation,
  ReceivablePayable,
  RecurringItem,
  ResultStatus,
  SourceLink,
  TimelinePoint,
} from '@financialos/contracts';
import { addDays, expandCadence, type IsoDate } from '../dates';
import type { FxTable } from '../fx';
import { D, dec, money, zero, type Dec } from '../money';
import { compareStrings, confidenceFromProbability, convertOrNull, decString, parseProbability, PlanningError, roundedMoney } from './shared';

export type CashFlowSource = 'recurring' | 'obligation' | 'receivable' | 'payable' | 'scenario' | 'goal' | 'purchase' | 'other';
export type CashFlowMode = 'committed_only' | 'probability_weighted';
export type CashFlowCertainty = 'committed' | 'expected';

export interface CashFlowItem {
  /** Stable identity. Two items with the same id are the same payment and are applied once. */
  id: string;
  date: IsoDate;
  label: string;
  direction: 'in' | 'out';
  /** Positive magnitude in the item's currency. Null = amount unknown. */
  amount: Money | null;
  certainty: CashFlowCertainty;
  /** Probability in [0, 1] for expected items (decimal string). Ignored for committed items. */
  probability?: string | null;
  source: CashFlowSource;
  /** Free-form kind used by scenarios and reports (e.g. 'salary', 'software', 'bill'). */
  kind?: string | null;
  entityId?: string | null;
  /** Set for occurrences of a recurring item (used by pause scenarios). */
  recurringItemId?: string | null;
  amountIsEstimate?: boolean;
  links: SourceLink[];
}

export interface OpeningBalance {
  id: string;
  label: string;
  /** Known balance, or null when unknown. */
  balance: Money | null;
  links: SourceLink[];
}

export interface CashFlowOptions {
  from: IsoDate;
  to: IsoDate;
  currency: string;
  mode?: CashFlowMode;
  fx?: FxTable;
  /** Date used to convert foreign-currency items (spot at valuation). Defaults to `from`. */
  fxDate?: IsoDate;
  fxMaxStalenessDays?: number;
  /** Outstanding outflows dated before `from` are applied on `from` (default true). */
  applyOverdueOutflows?: boolean;
}

export interface AppliedFlow {
  id: string;
  date: IsoDate;
  originalDate: IsoDate;
  label: string;
  direction: 'in' | 'out';
  source: CashFlowSource;
  kind: string | null;
  entityId: string | null;
  recurringItemId: string | null;
  /** Full amount in the item's own currency. */
  original: Money;
  /** Amount applied to the projection (converted, probability-weighted when that mode is used). */
  amount: Money;
  /** Probability weight applied ("1" for committed items and for outflows in committed_only mode). */
  weight: string;
  probability: string | null;
  certainty: CashFlowCertainty;
  estimate: boolean;
  overdue: boolean;
  fx: FxProvenance | null;
  links: SourceLink[];
}

export type SkipReason = 'outside_horizon' | 'duplicate' | 'not_committed' | 'zero_probability' | 'unconverted' | 'overdue_inflow';

export interface SkippedFlow {
  id: string;
  label: string;
  date: IsoDate;
  direction: 'in' | 'out';
  source: CashFlowSource;
  reason: SkipReason;
  detail: string;
  links: SourceLink[];
}

export interface UnknownAmountFlow {
  id: string;
  label: string;
  date: IsoDate;
  direction: 'in' | 'out';
  source: CashFlowSource;
  links: SourceLink[];
}

/** One non-opening timeline point with a reference back to its flow (same order as `timeline.slice(1)`). */
export interface ProjectionEvent {
  flowId: string;
  date: IsoDate;
  label: string;
  direction: 'in' | 'out';
  source: CashFlowSource;
  /** Applied amount; null for unknown-amount items. */
  amount: Money | null;
  balanceAfter: Money;
  links: SourceLink[];
}

export interface CashFlowProjection {
  currency: string;
  from: IsoDate;
  to: IsoDate;
  mode: CashFlowMode;
  status: ResultStatus;
  opening: Money | null;
  openingUnknown: Array<{ id: string; label: string; reason: string; links: SourceLink[] }>;
  timeline: TimelinePoint[];
  events: ProjectionEvent[];
  lowest: Money | null;
  lowestOn: IsoDate | null;
  closing: Money | null;
  inflows: Money;
  outflows: Money;
  applied: AppliedFlow[];
  skipped: SkippedFlow[];
  unknownAmounts: UnknownAmountFlow[];
  unknownOutflowCount: number;
  unknownInflowCount: number;
  unconverted: Array<{ id: string; label: string; original: Money; reason: string }>;
}

const SOURCE_RANK: Record<CashFlowSource, number> = {
  obligation: 0,
  payable: 1,
  receivable: 1,
  goal: 2,
  purchase: 2,
  scenario: 2,
  recurring: 3,
  other: 4,
};

function specificity(item: CashFlowItem): number[] {
  return [item.amount === null ? 1 : 0, item.certainty === 'committed' ? 0 : 1, item.amountIsEstimate ? 1 : 0, SOURCE_RANK[item.source]];
}

function moreSpecific(a: CashFlowItem, b: CashFlowItem): boolean {
  const ra = specificity(a);
  const rb = specificity(b);
  for (let i = 0; i < ra.length; i += 1) {
    if (ra[i]! !== rb[i]!) return ra[i]! < rb[i]!;
  }
  return false;
}

function validateItem(item: CashFlowItem): void {
  if (!item.id) throw new PlanningError('Cash-flow item requires an id');
  if (item.amount && dec(item.amount.amount).isNegative()) {
    throw new PlanningError(`Cash-flow item ${item.id} must use a positive magnitude and a direction`);
  }
  parseProbability(item.probability ?? null);
}

/**
 * Keeps one item per id (the most specific: known amount, committed, not an estimate, one-off before
 * recurring). Returns the kept items in input order plus the discarded duplicates.
 */
export function dedupeCashFlowItems(items: readonly CashFlowItem[]): { kept: CashFlowItem[]; duplicates: CashFlowItem[] } {
  const best = new Map<string, CashFlowItem>();
  for (const item of items) {
    const current = best.get(item.id);
    if (!current || moreSpecific(item, current)) best.set(item.id, item);
  }
  const kept: CashFlowItem[] = [];
  const duplicates: CashFlowItem[] = [];
  for (const item of items) {
    if (best.get(item.id) === item) kept.push(item);
    else duplicates.push(item);
  }
  return { kept, duplicates };
}

function orderFlows(a: { date: IsoDate; direction: 'in' | 'out'; id: string }, b: { date: IsoDate; direction: 'in' | 'out'; id: string }): number {
  if (a.date !== b.date) return compareStrings(a.date, b.date);
  // Outflows before inflows on the same day: the lowest point never relies on same-day income.
  if (a.direction !== b.direction) return a.direction === 'out' ? -1 : 1;
  return compareStrings(a.id, b.id);
}

export function projectCashFlow(openings: readonly OpeningBalance[], items: readonly CashFlowItem[], options: CashFlowOptions): CashFlowProjection {
  const { from, to, currency } = options;
  if (to < from) throw new PlanningError(`Horizon end ${to} is before start ${from}`);
  const mode: CashFlowMode = options.mode ?? 'committed_only';
  const fxDate = options.fxDate ?? from;
  const applyOverdue = options.applyOverdueOutflows ?? true;
  items.forEach(validateItem);

  const toCurrency = (value: Money): ReturnType<typeof convertOrNull> => {
    if (value.currency === currency) return { value, fx: null, reason: null };
    if (!options.fx) return { value: null, fx: null, reason: `No FX table supplied for ${value.currency}→${currency}` };
    return convertOrNull(value, currency, fxDate, options.fx, { maxStalenessDays: options.fxMaxStalenessDays ?? 7 });
  };

  // Opening balance.
  const openingUnknown: CashFlowProjection['openingUnknown'] = [];
  let openingTotal: Dec | null = null;
  const openingLinks: SourceLink[] = [];
  for (const opening of openings) {
    openingLinks.push(...opening.links);
    if (opening.balance === null) {
      openingUnknown.push({ id: opening.id, label: opening.label, reason: 'Balance unknown', links: opening.links });
      continue;
    }
    const converted = toCurrency(opening.balance);
    if (converted.value === null) {
      openingUnknown.push({ id: opening.id, label: opening.label, reason: converted.reason, links: opening.links });
      continue;
    }
    openingTotal = (openingTotal ?? new D(0)).plus(dec(converted.value.amount));
  }

  const { kept, duplicates } = dedupeCashFlowItems(items);
  const skipped: SkippedFlow[] = duplicates.map((item) => ({
    id: item.id,
    label: item.label,
    date: item.date,
    direction: item.direction,
    source: item.source,
    reason: 'duplicate',
    detail: 'Same id as another item in the horizon; applied once',
    links: item.links,
  }));
  const skip = (item: CashFlowItem, reason: SkipReason, detail: string) =>
    skipped.push({ id: item.id, label: item.label, date: item.date, direction: item.direction, source: item.source, reason, detail, links: item.links });

  const applied: AppliedFlow[] = [];
  const unknownAmounts: UnknownAmountFlow[] = [];
  const unconverted: CashFlowProjection['unconverted'] = [];

  for (const item of kept) {
    if (item.date > to) {
      skip(item, 'outside_horizon', `Dated after the horizon end ${to}`);
      continue;
    }
    let date = item.date;
    let overdue = false;
    if (item.date < from) {
      if (item.direction === 'in' || !applyOverdue) {
        skip(item, item.direction === 'in' ? 'overdue_inflow' : 'outside_horizon', item.direction === 'in' ? 'Expected date has passed; update it to include this inflow' : `Dated before the horizon start ${from}`);
        continue;
      }
      date = from;
      overdue = true;
    }
    const probability = item.probability === null || item.probability === undefined ? null : parseProbability(item.probability);
    let weight: Dec = new D(1);
    if (item.certainty === 'expected') {
      const p = probability ?? new D(1);
      if (mode === 'committed_only') {
        if (item.direction === 'in') {
          skip(item, 'not_committed', 'Expected (unconfirmed) inflows are not counted in the committed view');
          continue;
        }
      } else {
        if (p.isZero()) {
          skip(item, 'zero_probability', 'Probability is zero');
          continue;
        }
        weight = p;
      }
    }
    if (item.amount === null) {
      unknownAmounts.push({ id: item.id, label: item.label, date, direction: item.direction, source: item.source, links: item.links });
      continue;
    }
    const converted = toCurrency(item.amount);
    if (converted.value === null) {
      unconverted.push({ id: item.id, label: item.label, original: item.amount, reason: converted.reason });
      skip(item, 'unconverted', converted.reason);
      continue;
    }
    const amount = weight.equals(1) ? converted.value : roundedMoney(dec(converted.value.amount).times(weight), currency);
    applied.push({
      id: item.id,
      date,
      originalDate: item.date,
      label: overdue ? `${item.label} (overdue)` : item.label,
      direction: item.direction,
      source: item.source,
      kind: item.kind ?? null,
      entityId: item.entityId ?? null,
      recurringItemId: item.recurringItemId ?? null,
      original: item.amount,
      amount,
      weight: decString(weight),
      probability: probability === null ? null : decString(probability),
      certainty: item.certainty,
      estimate: item.amountIsEstimate ?? false,
      overdue,
      fx: converted.fx,
      links: item.links,
    });
  }

  applied.sort(orderFlows);
  unknownAmounts.sort(orderFlows);
  const unknownOutflowCount = unknownAmounts.filter((u) => u.direction === 'out').length;
  const unknownInflowCount = unknownAmounts.length - unknownOutflowCount;

  let inflows = new D(0);
  let outflows = new D(0);
  for (const flow of applied) {
    if (flow.direction === 'in') inflows = inflows.plus(dec(flow.amount.amount));
    else outflows = outflows.plus(dec(flow.amount.amount));
  }

  const timeline: TimelinePoint[] = [];
  const projectionEvents: ProjectionEvent[] = [];
  let lowest: Dec | null = null;
  let lowestOn: IsoDate | null = null;
  let balance: Dec | null = openingTotal;
  if (balance !== null) {
    const openingMoney = money(balance, currency);
    timeline.push({
      date: from,
      label: 'Opening balance',
      change: openingMoney,
      balanceAfter: openingMoney,
      kind: 'opening',
      confidence: openingUnknown.length > 0 ? 'low' : 'high',
      links: openingLinks,
    });
    lowest = balance;
    lowestOn = from;
    // Merge applied and unknown flows in date order for the timeline.
    const events: Array<{ date: IsoDate; direction: 'in' | 'out'; id: string; flow?: AppliedFlow; unknown?: UnknownAmountFlow }> = [
      ...applied.map((flow) => ({ date: flow.date, direction: flow.direction, id: flow.id, flow })),
      ...unknownAmounts.map((unknown) => ({ date: unknown.date, direction: unknown.direction, id: unknown.id, unknown })),
    ].sort(orderFlows);
    for (const event of events) {
      if (event.flow) {
        const flow = event.flow;
        const signed = flow.direction === 'in' ? dec(flow.amount.amount) : dec(flow.amount.amount).negated();
        balance = balance.plus(signed);
        const confidence: Confidence =
          flow.certainty === 'committed' ? (flow.estimate ? 'medium' : 'high') : confidenceFromProbability(flow.probability === null ? new D(1) : dec(flow.probability));
        timeline.push({
          date: flow.date,
          label: flow.label,
          change: money(signed, currency),
          balanceAfter: money(balance, currency),
          kind: flow.direction === 'in' ? 'inflow' : 'outflow',
          confidence,
          links: flow.links,
        });
        projectionEvents.push({
          flowId: flow.id,
          date: flow.date,
          label: flow.label,
          direction: flow.direction,
          source: flow.source,
          amount: flow.amount,
          balanceAfter: money(balance, currency),
          links: flow.links,
        });
        if (balance.lessThan(lowest)) {
          lowest = balance;
          lowestOn = flow.date;
        }
      } else if (event.unknown) {
        timeline.push({
          date: event.unknown.date,
          label: `${event.unknown.label} (amount unknown, not included)`,
          change: zero(currency),
          balanceAfter: money(balance, currency),
          kind: 'unknown_amount',
          confidence: 'none',
          links: event.unknown.links,
        });
        projectionEvents.push({
          flowId: event.unknown.id,
          date: event.unknown.date,
          label: event.unknown.label,
          direction: event.unknown.direction,
          source: event.unknown.source,
          amount: null,
          balanceAfter: money(balance, currency),
          links: event.unknown.links,
        });
      }
    }
  }

  const unconvertedCounted = unconverted.length > 0;
  let status: ResultStatus = 'ok';
  if (openingTotal === null) status = 'insufficient_data';
  else if (openingUnknown.length > 0 || unknownAmounts.length > 0 || unconvertedCounted) status = 'provisional';

  return {
    currency,
    from,
    to,
    mode,
    status,
    opening: openingTotal === null ? null : money(openingTotal, currency),
    openingUnknown,
    timeline,
    events: projectionEvents,
    lowest: lowest === null ? null : money(lowest, currency),
    lowestOn,
    closing: balance === null ? null : money(balance, currency),
    inflows: money(inflows, currency),
    outflows: money(outflows, currency),
    applied,
    skipped,
    unknownAmounts,
    unknownOutflowCount,
    unknownInflowCount,
    unconverted,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Adapters from planning records to cash-flow items.
// ---------------------------------------------------------------------------------------------------------------

/** Id of one occurrence of a recurring item. One-off obligations that settle an occurrence should reuse it. */
export function recurringOccurrenceId(recurringItemId: string, date: IsoDate): string {
  return `recurring:${recurringItemId}@${date}`;
}

export type RecurringFlowSource = Pick<
  RecurringItem,
  'id' | 'name' | 'entityId' | 'kind' | 'direction' | 'amount' | 'amountIsEstimate' | 'cadence' | 'dayOfMonth' | 'nextDueOn' | 'status' | 'confirmed' | 'links'
>;

export interface RecurringExpansion {
  flows: CashFlowItem[];
  /** Active items that cannot be scheduled (no next due date). */
  unscheduled: Array<{ id: string; name: string; reason: string }>;
  /** Items whose next due date is before the horizon: the payment may be outstanding. */
  pastDue: Array<{ id: string; name: string; nextDueOn: IsoDate }>;
}

/**
 * Expands recurring items into dated occurrences within [from, to]. Paused and cancelled items are skipped.
 * Suggested (detected, unconfirmed) items are included as expected flows: their outflows still count in the
 * conservative view, their inflows do not.
 */
export function expandRecurringFlows(items: readonly RecurringFlowSource[], from: IsoDate, to: IsoDate): RecurringExpansion {
  const flows: CashFlowItem[] = [];
  const unscheduled: RecurringExpansion['unscheduled'] = [];
  const pastDue: RecurringExpansion['pastDue'] = [];
  for (const item of items) {
    if (item.status !== 'active' && item.status !== 'suggested') continue;
    if (!item.nextDueOn) {
      unscheduled.push({ id: item.id, name: item.name, reason: 'No next due date' });
      continue;
    }
    if (item.nextDueOn < from) pastDue.push({ id: item.id, name: item.name, nextDueOn: item.nextDueOn });
    const dates = expandCadence(item.nextDueOn, item.cadence, from, to, item.dayOfMonth);
    const amount = item.amount.amount !== null && item.amount.currency !== null ? money(item.amount.amount, item.amount.currency) : null;
    const link: SourceLink = { kind: 'recurring', id: item.id, label: item.name };
    for (const date of dates) {
      flows.push({
        id: recurringOccurrenceId(item.id, date),
        date,
        label: item.name,
        direction: item.direction,
        amount: amount === null ? null : money(dec(amount.amount).abs(), amount.currency),
        certainty: item.status === 'active' && item.confirmed ? 'committed' : 'expected',
        probability: null,
        source: 'recurring',
        kind: item.kind,
        entityId: item.entityId,
        recurringItemId: item.id,
        amountIsEstimate: item.amountIsEstimate,
        links: [link, ...item.links.filter((l) => !(l.kind === 'recurring' && l.id === item.id))],
      });
    }
  }
  return { flows, unscheduled, pastDue };
}

export type ObligationFlowSource = Pick<Obligation, 'id' | 'entityId' | 'dueOn' | 'amount' | 'label' | 'kind' | 'status'> & {
  /** When the obligation settles an occurrence of a recurring item, it replaces that occurrence. */
  recurringItemId?: string | null;
};

/** Upcoming one-off obligations as committed outflows. Paid and cancelled obligations are ignored. */
export function obligationFlows(obligations: readonly ObligationFlowSource[]): CashFlowItem[] {
  return obligations
    .filter((o) => o.status === 'upcoming')
    .map((o) => ({
      id: o.recurringItemId ? recurringOccurrenceId(o.recurringItemId, o.dueOn) : o.id,
      date: o.dueOn,
      label: o.label,
      direction: 'out' as const,
      amount: o.amount.amount !== null && o.amount.currency !== null ? money(dec(o.amount.amount).abs(), o.amount.currency) : null,
      certainty: 'committed' as const,
      probability: null,
      source: 'obligation' as const,
      kind: o.kind,
      entityId: o.entityId,
      recurringItemId: o.recurringItemId ?? null,
      links: [{ kind: 'obligation' as const, id: o.id, label: o.label }],
    }));
}

export type ReceivablePayableFlowSource = Pick<
  ReceivablePayable,
  'id' | 'entityId' | 'kind' | 'counterparty' | 'outstanding' | 'dueOn' | 'expectedOn' | 'probability' | 'status' | 'category' | 'reference'
>;

/**
 * Open receivables (inflows) and payables (outflows) on their expected date (falling back to the due date).
 * Probability 1 marks an item as committed; anything lower is expected.
 */
export function receivablePayableFlows(items: readonly ReceivablePayableFlowSource[]): { flows: CashFlowItem[]; undated: Array<{ id: string; label: string }> } {
  const flows: CashFlowItem[] = [];
  const undated: Array<{ id: string; label: string }> = [];
  for (const item of items) {
    if (item.status !== 'open' && item.status !== 'partial') continue;
    if (!dec(item.outstanding.amount).greaterThan(0)) continue;
    const label = `${item.kind === 'receivable' ? 'Receivable from' : 'Payable to'} ${item.counterparty}${item.reference ? ` (${item.reference})` : ''}`;
    const date = item.expectedOn ?? item.dueOn;
    if (!date) {
      undated.push({ id: item.id, label });
      continue;
    }
    const probability = parseProbability(item.probability);
    flows.push({
      id: `${item.kind}:${item.id}`,
      date,
      label,
      direction: item.kind === 'receivable' ? 'in' : 'out',
      amount: item.outstanding,
      certainty: probability.equals(1) ? 'committed' : 'expected',
      probability: item.probability,
      source: item.kind,
      kind: item.category,
      entityId: item.entityId,
      recurringItemId: null,
      links: [{ kind: 'receivable', id: item.id, label }],
    });
  }
  return { flows, undated };
}

export interface GoalContributionPlan {
  id: string;
  goalId: string;
  goalName: string;
  date: IsoDate;
  amount: Money;
  /** Only commitments (money that will be moved out of spending cash) become outflows. */
  commitment: boolean;
}

export function goalCommitmentFlows(plans: readonly GoalContributionPlan[]): CashFlowItem[] {
  return plans
    .filter((p) => p.commitment)
    .map((p) => ({
      id: `goal:${p.id}`,
      date: p.date,
      label: `Planned contribution: ${p.goalName}`,
      direction: 'out' as const,
      amount: p.amount,
      certainty: 'committed' as const,
      probability: null,
      source: 'goal' as const,
      kind: 'goal_contribution',
      entityId: null,
      recurringItemId: null,
      links: [{ kind: 'goal' as const, id: p.goalId, label: p.goalName }],
    }));
}

/** Inclusive horizon end for a fixed number of days starting today. */
export function horizonEnd(from: IsoDate, days: number): IsoDate {
  if (!Number.isInteger(days) || days < 0) throw new PlanningError(`Horizon days must be a non-negative integer: ${days}`);
  return addDays(from, days);
}
