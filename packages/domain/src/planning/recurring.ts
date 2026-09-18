/**
 * Recurring-series detection from transaction history.
 *
 * Transactions are grouped by a normalised counterparty (or description), direction and currency. Within a
 * group the interval medians decide the cadence, and a series is only suggested when it has enough
 * occurrences and enough regularity:
 *
 *   intervals       = days between consecutive occurrence dates
 *   cadence         = the band containing the median interval (weekly 5–9, fortnightly 12–17, monthly 25–35,
 *                     quarterly 80–100, annually 330–400 days)
 *   regularity      = share of intervals inside that band
 *   amount spread   = (max − min) / median amount
 *   next expected   = last occurrence + one cadence step (month-end clamped)
 *
 * Nothing here is ever auto-confirmed: every suggestion carries `status: 'suggested'`, `detected: true` and
 * `confirmed: false`. The owner confirms. Amounts are estimates unless every occurrence was identical, and an
 * unknown amount stays unknown rather than becoming zero (a series with no usable amount is not suggested).
 *
 * Two more findings come out of the same grouping: a subscription price change (the latest occurrence differs
 * from the median of the earlier ones beyond a threshold) and a missed expected occurrence (the next expected
 * date passed by more than the cadence's grace period).
 */
import type { Cadence, Confidence, Money, RecurringItem, SourceLink } from '@financialos/contracts';
import { addDays, addMonths, diffDays, parseIsoDate, type IsoDate } from '../dates';
import { D, dec, type Dec } from '../money';
import { compareStrings, decString, median, normaliseLabel, PlanningError, roundedMoney, stableId } from './shared';

/** A transaction as the detector needs it. Signed amount: negative = money left the account. */
export interface RecurringTransaction {
  id: string;
  accountId: string;
  entityId?: string | null;
  date: IsoDate;
  amount: Money;
  description: string;
  counterparty?: string | null;
  status?: 'pending' | 'posted' | 'reversed' | 'superseded';
}

/** A recurring item the owner already tracks, used only to avoid suggesting the same series twice. */
export interface ExistingRecurring {
  id: string;
  name: string;
  counterparty?: string | null;
  direction: 'in' | 'out';
  currency: string | null;
}

export interface RecurringDetectionOptions {
  /** Occurrences required before a series is suggested (default 3). */
  minOccurrences?: number;
  /** Occurrences required for an annual series (default 2). */
  minAnnualOccurrences?: number;
  /** Minimum share of intervals inside the cadence band (default 0.6). */
  minRegularity?: string;
  /** Amount spread at or below which the amount counts as stable (default 0.02). */
  stableAmountSpread?: string;
  /** Relative change of the latest amount that counts as a price change (default 0.05). */
  priceChangeThreshold?: string;
  /** Most recent transaction links attached to a suggestion (default 12). */
  maxLinks?: number;
}

export interface RecurringOccurrence {
  date: IsoDate;
  /** Positive magnitude. Several transactions on the same date are one occurrence and their amounts are added. */
  amount: Money;
  transactionIds: string[];
  links: SourceLink[];
}

export interface RecurringSeries {
  /** Stable grouping key: normalised label, direction and currency. */
  key: string;
  label: string;
  counterparty: string | null;
  direction: 'in' | 'out';
  currency: string;
  accountId: string | null;
  entityId: string | null;
  occurrences: RecurringOccurrence[];
  intervalDays: number[];
  cadence: Cadence;
  medianIntervalDays: string;
  regularity: string;
  medianAmount: Money;
  latestAmount: Money;
  amountSpread: string;
  dayOfMonth: number | null;
  nextExpectedOn: IsoDate | null;
  confidence: Confidence;
  /** Why the series was or was not suggested. */
  reason: string;
  suggested: boolean;
}

export interface RecurringSuggestion {
  item: RecurringItem;
  confidence: Confidence;
  occurrenceCount: number;
  firstSeenOn: IsoDate;
  lastSeenOn: IsoDate;
  medianIntervalDays: string;
  regularity: string;
  medianAmount: Money;
  amountSpread: string;
  reason: string;
}

export interface SubscriptionPriceChange {
  seriesKey: string;
  name: string;
  counterparty: string | null;
  previousTypical: Money;
  latest: Money;
  /** Signed relative change: (latest − previousTypical) / previousTypical. */
  changeShare: string;
  direction: 'increase' | 'decrease';
  changedOn: IsoDate;
  detail: string;
  links: SourceLink[];
}

export interface MissedOccurrence {
  seriesKey: string;
  name: string;
  counterparty: string | null;
  expectedOn: IsoDate;
  daysOverdue: number;
  graceDays: number;
  lastSeenOn: IsoDate;
  typicalAmount: Money;
  detail: string;
  links: SourceLink[];
}

export interface RecurringDetectionResult {
  suggestions: RecurringSuggestion[];
  priceChanges: SubscriptionPriceChange[];
  missed: MissedOccurrence[];
  /** Every group that was examined, suggested or not, with the numbers behind the decision. */
  series: RecurringSeries[];
  /** Series matching a recurring item the owner already tracks. */
  alreadyTracked: Array<{ seriesKey: string; existingId: string; name: string }>;
}

export interface RecurringDetectionInput {
  asOf: IsoDate;
  transactions: readonly RecurringTransaction[];
  /** Entity the suggestions belong to when a transaction does not name one. */
  entityId: string;
  existing?: readonly ExistingRecurring[];
  options?: RecurringDetectionOptions;
}

interface CadenceBand {
  cadence: Exclude<Cadence, 'irregular' | 'unknown'>;
  days: number;
  min: number;
  max: number;
  months: number;
  graceDays: number;
}

/** Interval bands, widest-apart first match wins by median containment. Grace = 20 % of the step, 2–14 days. */
export const CADENCE_BANDS: readonly CadenceBand[] = [
  { cadence: 'weekly', days: 7, min: 5, max: 9, months: 0, graceDays: 2 },
  { cadence: 'fortnightly', days: 14, min: 12, max: 17, months: 0, graceDays: 3 },
  { cadence: 'monthly', days: 30, min: 25, max: 35, months: 1, graceDays: 6 },
  { cadence: 'quarterly', days: 91, min: 80, max: 100, months: 3, graceDays: 14 },
  { cadence: 'annually', days: 365, min: 330, max: 400, months: 12, graceDays: 14 },
];

export function cadenceBand(cadence: Cadence): CadenceBand | null {
  return CADENCE_BANDS.find((b) => b.cadence === cadence) ?? null;
}

export interface CadenceInference {
  cadence: Cadence;
  medianIntervalDays: Dec;
  /** Share of intervals inside the matched band. Zero when no band matches. */
  regularity: Dec;
}

/** Infers the cadence from the intervals between consecutive occurrences. */
export function inferCadence(intervalDays: readonly number[]): CadenceInference {
  if (intervalDays.length === 0) return { cadence: 'unknown', medianIntervalDays: new D(0), regularity: new D(0) };
  const med = median(intervalDays.map((d) => new D(d)));
  const band = CADENCE_BANDS.find((b) => med.greaterThanOrEqualTo(b.min) && med.lessThanOrEqualTo(b.max));
  if (!band) return { cadence: 'irregular', medianIntervalDays: med, regularity: new D(0) };
  const inside = intervalDays.filter((d) => d >= band.min && d <= band.max).length;
  return { cadence: band.cadence, medianIntervalDays: med, regularity: new D(inside).dividedBy(intervalDays.length) };
}

/** One cadence step after `from`. Monthly-style cadences keep `dayOfMonth`, clamped to the month's length. */
export function nextExpectedDate(from: IsoDate, cadence: Cadence, dayOfMonth: number | null): IsoDate | null {
  const band = cadenceBand(cadence);
  if (!band) return null;
  if (band.months === 0) return addDays(from, band.days);
  return addMonths(from, band.months, dayOfMonth ?? undefined);
}

function toOccurrences(transactions: readonly RecurringTransaction[], currency: string): RecurringOccurrence[] {
  const byDate = new Map<IsoDate, { total: Dec; ids: string[]; links: SourceLink[] }>();
  for (const tx of [...transactions].sort((a, b) => compareStrings(a.date, b.date) || compareStrings(a.id, b.id))) {
    const bucket = byDate.get(tx.date) ?? { total: new D(0), ids: [], links: [] };
    bucket.total = bucket.total.plus(dec(tx.amount.amount).abs());
    bucket.ids.push(tx.id);
    bucket.links.push({ kind: 'transaction', id: tx.id, label: `${tx.date} ${tx.description}` });
    byDate.set(tx.date, bucket);
  }
  return [...byDate.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([date, bucket]) => ({ date, amount: roundedMoney(bucket.total, currency), transactionIds: bucket.ids, links: bucket.links }));
}

/** Most frequent day of the month; ties go to the most recent occurrence's day. */
function modalDayOfMonth(occurrences: readonly RecurringOccurrence[]): number {
  const counts = new Map<number, number>();
  for (const occurrence of occurrences) {
    const day = parseIsoDate(occurrence.date).d;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const latestDay = parseIsoDate(occurrences[occurrences.length - 1]!.date).d;
  let best = latestDay;
  let bestCount = 0;
  for (const [day, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount || (count === bestCount && day === latestDay)) {
      best = day;
      bestCount = count;
    }
  }
  return best;
}

function seriesConfidence(occurrenceCount: number, regularity: Dec, amountSpread: Dec, cadence: Cadence): Confidence {
  let score = 0;
  if (regularity.greaterThanOrEqualTo('0.8')) score += 2;
  else if (regularity.greaterThanOrEqualTo('0.6')) score += 1;
  const many = cadence === 'annually' ? 3 : 5;
  const some = cadence === 'annually' ? 2 : 3;
  if (occurrenceCount >= many) score += 2;
  else if (occurrenceCount >= some) score += 1;
  if (amountSpread.lessThanOrEqualTo('0.02')) score += 2;
  else if (amountSpread.lessThanOrEqualTo('0.1')) score += 1;
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  if (score >= 1) return 'low';
  return 'none';
}

function suggestedKind(direction: 'in' | 'out', cadence: Cadence, amountStable: boolean): RecurringItem['kind'] {
  if (direction === 'in') return 'income';
  if (cadence === 'annually') return 'annual_bill';
  return amountStable ? 'subscription' : 'bill';
}

/**
 * Groups transactions into candidate series and returns suggestions, price changes and missed occurrences.
 * Reversed and superseded transactions, zero amounts and rows with no usable label are ignored.
 */
export function detectRecurring(input: RecurringDetectionInput): RecurringDetectionResult {
  const options = input.options ?? {};
  const minOccurrences = options.minOccurrences ?? 3;
  const minAnnualOccurrences = options.minAnnualOccurrences ?? 2;
  const minRegularity = dec(options.minRegularity ?? '0.6');
  const stableSpread = dec(options.stableAmountSpread ?? '0.02');
  const priceChangeThreshold = dec(options.priceChangeThreshold ?? '0.05');
  const maxLinks = options.maxLinks ?? 12;
  if (minOccurrences < 2 || minAnnualOccurrences < 2) throw new PlanningError('A recurring series needs at least two occurrences');

  const groups = new Map<string, { label: string; counterparty: string | null; direction: 'in' | 'out'; currency: string; rows: RecurringTransaction[] }>();
  for (const tx of input.transactions) {
    if (tx.status === 'reversed' || tx.status === 'superseded') continue;
    const amount = dec(tx.amount.amount);
    if (amount.isZero()) continue;
    if (tx.date > input.asOf) continue;
    const label = normaliseLabel(tx.counterparty ?? tx.description);
    if (label.length === 0) continue;
    const direction: 'in' | 'out' = amount.isNegative() ? 'out' : 'in';
    const key = `${label}|${direction}|${tx.amount.currency}`;
    const group = groups.get(key) ?? {
      label: (tx.counterparty ?? tx.description).trim(),
      counterparty: tx.counterparty?.trim() ?? null,
      direction,
      currency: tx.amount.currency,
      rows: [],
    };
    group.rows.push(tx);
    groups.set(key, group);
  }

  const series: RecurringSeries[] = [];
  const suggestions: RecurringSuggestion[] = [];
  const priceChanges: SubscriptionPriceChange[] = [];
  const missed: MissedOccurrence[] = [];
  const alreadyTracked: RecurringDetectionResult['alreadyTracked'] = [];
  const existingByKey = new Map<string, ExistingRecurring>();
  for (const item of input.existing ?? []) {
    const label = normaliseLabel(item.counterparty ?? item.name);
    if (label.length === 0) continue;
    existingByKey.set(`${label}|${item.direction}|${item.currency ?? ''}`, item);
  }

  for (const [key, group] of [...groups.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    const occurrences = toOccurrences(group.rows, group.currency);
    const dates = occurrences.map((o) => o.date);
    const intervalDays = dates.slice(1).map((date, i) => diffDays(dates[i]!, date));
    const { cadence, medianIntervalDays, regularity } = inferCadence(intervalDays);
    const amounts = occurrences.map((o) => dec(o.amount.amount));
    const medianAmountDec = median(amounts);
    const latestAmount = occurrences[occurrences.length - 1]!.amount;
    const spread = medianAmountDec.isZero()
      ? new D(0)
      : amounts.reduce((mx, a) => (a.greaterThan(mx) ? a : mx), amounts[0]!).minus(amounts.reduce((mn, a) => (a.lessThan(mn) ? a : mn), amounts[0]!)).dividedBy(medianAmountDec);
    const band = cadenceBand(cadence);
    const dayOfMonth = band && band.months > 0 ? modalDayOfMonth(occurrences) : null;
    const lastSeenOn = dates[dates.length - 1]!;
    const nextExpectedOn = nextExpectedDate(lastSeenOn, cadence, dayOfMonth);
    const required = cadence === 'annually' ? minAnnualOccurrences : minOccurrences;
    const confidence = seriesConfidence(occurrences.length, regularity, spread, cadence);
    const accountIds = [...new Set(group.rows.map((r) => r.accountId))];
    const entityIds = [...new Set(group.rows.map((r) => r.entityId ?? null).filter((e): e is string => e !== null))];
    const seriesEntityId = entityIds.length === 1 ? entityIds[0]! : null;
    const amountStable = spread.lessThanOrEqualTo(stableSpread);

    let reason: string;
    let suggested = false;
    if (band === null) {
      reason = occurrences.length < 2 ? 'Only one occurrence, so no interval can be measured' : `Intervals are irregular (median ${decString(medianIntervalDays, 2)} days)`;
    } else if (occurrences.length < required) {
      reason = `${occurrences.length} occurrence(s); ${required} are required for a ${cadence} series`;
    } else if (regularity.lessThan(minRegularity)) {
      reason = `Only ${decString(regularity.times(100), 0)}% of the intervals match a ${cadence} cadence`;
    } else {
      suggested = true;
      reason = `${occurrences.length} occurrences about ${decString(medianIntervalDays, 0)} days apart (${decString(regularity.times(100), 0)}% regular), amount spread ${decString(spread.times(100), 1)}%`;
    }

    // Price change: the latest occurrence against the median of the earlier ones.
    if (occurrences.length >= 3) {
      const earlier = amounts.slice(0, -1);
      const typical = median(earlier);
      const latest = amounts[amounts.length - 1]!;
      if (typical.greaterThan(0)) {
        const change = latest.minus(typical).dividedBy(typical);
        if (change.abs().greaterThan(priceChangeThreshold)) {
          priceChanges.push({
            seriesKey: key,
            name: group.label,
            counterparty: group.counterparty,
            previousTypical: roundedMoney(typical, group.currency),
            latest: roundedMoney(latest, group.currency),
            changeShare: decString(change, 6),
            direction: change.greaterThan(0) ? 'increase' : 'decrease',
            changedOn: lastSeenOn,
            detail: `${group.label} changed from about ${decString(typical, 2)} to ${decString(latest, 2)} ${group.currency} on ${lastSeenOn} (${decString(change.times(100), 1)}%).`,
            links: occurrences[occurrences.length - 1]!.links,
          });
        }
      }
    }

    // Missed occurrence: the next expected date passed by more than the cadence grace.
    if (suggested && band && nextExpectedOn) {
      const overdue = diffDays(nextExpectedOn, input.asOf);
      if (overdue > band.graceDays) {
        missed.push({
          seriesKey: key,
          name: group.label,
          counterparty: group.counterparty,
          expectedOn: nextExpectedOn,
          daysOverdue: overdue,
          graceDays: band.graceDays,
          lastSeenOn,
          typicalAmount: roundedMoney(medianAmountDec, group.currency),
          detail: `${group.label} was expected on ${nextExpectedOn} and has not been seen; the last one was ${lastSeenOn}.`,
          links: occurrences[occurrences.length - 1]!.links,
        });
      }
    }

    series.push({
      key,
      label: group.label,
      counterparty: group.counterparty,
      direction: group.direction,
      currency: group.currency,
      accountId: accountIds.length === 1 ? accountIds[0]! : null,
      entityId: seriesEntityId,
      occurrences,
      intervalDays,
      cadence,
      medianIntervalDays: decString(medianIntervalDays, 4),
      regularity: decString(regularity, 6),
      medianAmount: roundedMoney(medianAmountDec, group.currency),
      latestAmount,
      amountSpread: decString(spread, 6),
      dayOfMonth,
      nextExpectedOn,
      confidence,
      reason,
      suggested,
    });

    if (!suggested) continue;
    const existing = existingByKey.get(key);
    if (existing) {
      alreadyTracked.push({ seriesKey: key, existingId: existing.id, name: group.label });
      continue;
    }

    const changed = priceChanges.find((p) => p.seriesKey === key);
    const amount = changed ? latestAmount : roundedMoney(medianAmountDec, group.currency);
    const links = occurrences.flatMap((o) => o.links).slice(-maxLinks);
    const item: RecurringItem = {
      id: stableId('recurring-suggestion', key),
      name: group.label,
      entityId: seriesEntityId ?? input.entityId,
      accountId: accountIds.length === 1 ? accountIds[0]! : null,
      counterparty: group.counterparty,
      kind: suggestedKind(group.direction, cadence, amountStable),
      direction: group.direction,
      amount: { amount: amount.amount, currency: amount.currency },
      amountIsEstimate: !amountStable || changed !== undefined,
      cadence,
      dayOfMonth,
      nextDueOn: nextExpectedOn,
      status: 'suggested',
      detected: true,
      confirmed: false,
      internalCounterpartyEntityId: null,
      lastSeenOn,
      links,
    };
    suggestions.push({
      item,
      confidence,
      occurrenceCount: occurrences.length,
      firstSeenOn: dates[0]!,
      lastSeenOn,
      medianIntervalDays: decString(medianIntervalDays, 4),
      regularity: decString(regularity, 6),
      medianAmount: roundedMoney(medianAmountDec, group.currency),
      amountSpread: decString(spread, 6),
      reason,
    });
  }

  const byName = (a: { name: string }, b: { name: string }) => compareStrings(a.name, b.name);
  return {
    suggestions: suggestions.sort((a, b) => compareStrings(a.item.name, b.item.name) || compareStrings(a.item.id, b.item.id)),
    priceChanges: priceChanges.sort(byName),
    missed: missed.sort(byName),
    series,
    alreadyTracked,
  };
}

/** Convenience wrapper returning only the suggested items. */
export function recurringSuggestions(input: RecurringDetectionInput): RecurringItem[] {
  return detectRecurring(input).suggestions.map((s) => s.item);
}

/** The amount a series should contribute to a forecast, or null when it is not usable. */
export function suggestionAmount(suggestion: RecurringSuggestion): Money | null {
  const { amount, currency } = suggestion.item.amount;
  return amount === null || currency === null ? null : { amount, currency };
}
