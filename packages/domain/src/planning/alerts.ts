/**
 * Alert rules evaluated into notification descriptors.
 *
 * Every descriptor carries a stable `dedupeKey` of `kind:subject:period`, so the same condition in the same
 * period always produces the same key and the store can keep one notification instead of a stream of them.
 * Every descriptor also carries:
 *   • `why`     — the numbers that made it fire, required, never empty;
 *   • `shortBody` — a privacy-safe variant for destinations outside FinancialOS: no amounts, no names, no
 *     account identifiers and no figures of any kind, so a phone lock screen leaks nothing;
 *   • `deliverAt` — quiet hours in the reporting time zone push non-critical alerts to the next allowed time.
 *     Windows that cross midnight (22:00–07:00) are handled. Critical alerts are never deferred.
 *
 * An unusual-transaction alert repeats the anomaly's own wording: unusual and worth a look. This module never
 * claims wrongdoing on the strength of a statistical outlier.
 */
import type { BusinessCashWarning, ConnectionStatus, CoverageGap, Money, Notification, SourceLink } from '@financialos/contracts';
import { monthKey, startOfWeek, addDays, diffDays, makeDate, parseIsoDate, type IsoDate } from '../dates';
import { dec } from '../money';
import type { Anomaly } from './anomalies';
import type { SubscriptionPriceChange } from './recurring';
import { ageInHours, compareStrings, decString, PlanningError, stableId } from './shared';

export type AlertKind =
  | 'upcoming_bill'
  | 'runway_below_threshold'
  | 'subscription_price_change'
  | 'unusual_transaction'
  | 'coverage_gap'
  | 'stale_connection'
  | 'weekly_review_due'
  | 'monthly_close_due'
  | 'business_cash_warning';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface QuietHours {
  enabled: boolean;
  /** Local wall-clock time HH:MM in the reporting time zone. */
  start: string;
  end: string;
}

export interface AlertDescriptor {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  body: string;
  /** Why this fired, in the owner's own numbers. Never empty. */
  why: string;
  /** Privacy-safe wording for external channels: no amounts, names, account identifiers or digits. */
  shortBody: string;
  href: string | null;
  dedupeKey: string;
  periodKey: string;
  links: SourceLink[];
  /** Instant at which delivery is allowed (quiet hours defer non-critical alerts). */
  deliverAt: string;
  deferred: boolean;
  deferredReason: string | null;
}

export interface UpcomingBillSource {
  id: string;
  label: string;
  dueOn: IsoDate;
  amount: Money | null;
  entityId?: string | null;
  links?: readonly SourceLink[];
}

export interface RunwayAlertSource {
  /** 'personal' or an entity id. */
  scopeId: string;
  scopeLabel: string;
  status: 'finite' | 'not_depleting' | 'insufficient_history' | 'insufficient_data';
  /** Months of runway as a decimal string, or null when unknown. */
  months: string | null;
  thresholdMonths: string;
}

export interface ConnectionAlertSource {
  id: string;
  name: string;
  status: ConnectionStatus;
  lastSuccessAt: string | null;
  /** Accounts left with an unknown balance because this connection is not delivering. */
  accountsWithUnknownBalance?: number;
}

export interface CoverageGapAlertSource extends CoverageGap {
  accountName?: string | null;
}

export interface ReviewAlertSource {
  kind: 'weekly' | 'monthly';
  /** Local date on which the review becomes due. */
  dueOn: IsoDate;
  /** End of the last period the owner actually completed. Null = none completed. */
  lastCompletedPeriodEnd: IsoDate | null;
}

export interface AlertInput {
  /** Instant the evaluation runs at. */
  now: string;
  /** Local calendar date in the reporting time zone. */
  today: IsoDate;
  timezone: string;
  quietHours: QuietHours;
  /** Days before a bill's due date at which it is announced (default 5). */
  billLeadDays?: number;
  /** Hours after which a connection counts as stale (default 48). */
  staleAfterHours?: number;
  upcomingBills?: readonly UpcomingBillSource[];
  runway?: readonly RunwayAlertSource[];
  priceChanges?: readonly SubscriptionPriceChange[];
  anomalies?: readonly Anomaly[];
  coverageGaps?: readonly CoverageGapAlertSource[];
  connections?: readonly ConnectionAlertSource[];
  reviews?: readonly ReviewAlertSource[];
  businessWarnings?: readonly BusinessCashWarning[];
}

export interface AlertEvaluation {
  alerts: AlertDescriptor[];
  /** Alerts held back until the end of quiet hours. */
  deferredCount: number;
}

/** Wording used on external channels. Deliberately free of amounts, names and digits. */
export const PRIVACY_SAFE_BODY: Record<AlertKind, string> = {
  upcoming_bill: 'A scheduled payment is coming up. Open FinancialOS to see which one.',
  runway_below_threshold: 'Your cash runway is below the level you set. Open FinancialOS for the detail.',
  subscription_price_change: 'A recurring charge changed price. Open FinancialOS for the detail.',
  unusual_transaction: 'A transaction is unusual and worth a look. Open FinancialOS for the detail.',
  coverage_gap: 'Some transaction history is missing. Open FinancialOS for the detail.',
  stale_connection: 'A connection has not updated recently. Open FinancialOS for the detail.',
  weekly_review_due: 'Your weekly review is ready to start. Open FinancialOS to begin.',
  monthly_close_due: 'Your monthly close is due. Open FinancialOS to begin.',
  business_cash_warning: 'A business entity needs a cash check. Open FinancialOS for the detail.',
};

const HREF: Record<AlertKind, string> = {
  upcoming_bill: '/plan/recurring',
  runway_below_threshold: '/today',
  subscription_price_change: '/plan/recurring',
  unusual_transaction: '/inbox',
  coverage_gap: '/money/coverage',
  stale_connection: '/connections',
  weekly_review_due: '/coach/review',
  monthly_close_due: '/coach/review',
  business_cash_warning: '/business',
};

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

// ---------------------------------------------------------------------------------------------------------------
// Time-zone and quiet-hours arithmetic
// ---------------------------------------------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClock(value: string): number {
  const match = HHMM.exec(value);
  if (!match) throw new PlanningError(`Invalid time of day: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function offsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - instantMs;
}

/** Local calendar date and minute-of-day observed in `timeZone` at an instant. */
export function localClock(instant: string, timeZone: string): { date: IsoDate; minutes: number } {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new PlanningError(`Invalid instant: ${instant}`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { date: makeDate(get('year'), get('month'), get('day')), minutes: (get('hour') % 24) * 60 + get('minute') };
}

/** Instant at which a local wall-clock time occurs in `timeZone`. */
export function zonedTimeToInstant(date: IsoDate, minutes: number, timeZone: string): string {
  parseIsoDate(date);
  const naive = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  let ms = naive - offsetMs(naive, timeZone);
  ms = naive - offsetMs(ms, timeZone);
  return new Date(ms).toISOString();
}

/** True when a minute-of-day falls inside the quiet window (a window that crosses midnight is supported). */
export function inQuietHours(minutes: number, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * The first instant at or after `instant` that is outside quiet hours. Inside the window the result is the
 * window's end in the reporting time zone, on the next local day when the window crosses midnight.
 */
export function nextAllowedTime(instant: string, quiet: QuietHours, timeZone: string): string {
  if (!quiet.enabled) return instant;
  const { date, minutes } = localClock(instant, timeZone);
  if (!inQuietHours(minutes, quiet)) return instant;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  const crossesMidnight = start > end;
  const targetDate = crossesMidnight && minutes >= start ? addDays(date, 1) : date;
  return zonedTimeToInstant(targetDate, end, timeZone);
}

/** ISO week key such as `2026-W11`, using the ISO week-year. */
export function isoWeekKey(date: IsoDate): string {
  const monday = startOfWeek(date, 'monday');
  const thursday = addDays(monday, 3);
  const year = parseIsoDate(thursday).y;
  const week1Monday = startOfWeek(makeDate(year, 1, 4), 'monday');
  const week = Math.floor(diffDays(week1Monday, monday) / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------------------------

function amountWords(amount: Money | null): string {
  return amount === null ? 'an amount that is not known yet' : `${amount.amount} ${amount.currency}`;
}

export function evaluateAlerts(input: AlertInput): AlertEvaluation {
  const leadDays = input.billLeadDays ?? 5;
  const staleAfterHours = input.staleAfterHours ?? 48;
  const out: AlertDescriptor[] = [];

  const add = (
    kind: AlertKind,
    subjectId: string,
    periodKey: string,
    severity: AlertSeverity,
    title: string,
    body: string,
    why: string,
    links: readonly SourceLink[] = [],
  ): void => {
    const dedupeKey = `${kind}:${subjectId}:${periodKey}`;
    const deliverAt = severity === 'critical' ? input.now : nextAllowedTime(input.now, input.quietHours, input.timezone);
    const deferred = deliverAt !== input.now;
    out.push({
      id: stableId('alert', dedupeKey),
      kind,
      severity,
      title,
      body,
      why,
      shortBody: PRIVACY_SAFE_BODY[kind],
      href: HREF[kind],
      dedupeKey,
      periodKey,
      links: [...links],
      deliverAt,
      deferred,
      deferredReason: deferred ? `Held until ${input.quietHours.end} in ${input.timezone}: quiet hours` : null,
    });
  };

  // Upcoming bills.
  for (const bill of input.upcomingBills ?? []) {
    const days = diffDays(input.today, bill.dueOn);
    if (days > leadDays) continue;
    const overdue = days < 0;
    add(
      'upcoming_bill',
      bill.id,
      bill.dueOn,
      overdue ? 'warning' : 'info',
      overdue ? `${bill.label} was due on ${bill.dueOn}` : `${bill.label} is due on ${bill.dueOn}`,
      `${bill.label}: ${amountWords(bill.amount)} ${overdue ? 'was due' : 'is due'} on ${bill.dueOn}.`,
      overdue
        ? `The due date ${bill.dueOn} is ${Math.abs(days)} day(s) ago and the payment is not recorded as made.`
        : `The due date ${bill.dueOn} is ${days} day(s) away, inside your ${leadDays}-day reminder window.`,
      bill.links ?? [{ kind: 'recurring', id: bill.id, label: bill.label }],
    );
  }

  // Runway below the threshold.
  for (const runway of input.runway ?? []) {
    if (runway.status !== 'finite' || runway.months === null) continue;
    const months = dec(runway.months);
    const threshold = dec(runway.thresholdMonths);
    if (!months.lessThan(threshold)) continue;
    const severity: AlertSeverity = months.lessThan(1) ? 'critical' : 'warning';
    add(
      'runway_below_threshold',
      runway.scopeId,
      isoWeekKey(input.today),
      severity,
      `${runway.scopeLabel} runway is ${decString(months, 1)} months`,
      `${runway.scopeLabel} runway is ${decString(months, 1)} months, below your ${decString(threshold, 1)}-month threshold.`,
      `Liquid balance divided by the average monthly net outflow gives ${decString(months, 2)} months, and your threshold is ${decString(threshold, 2)}.`,
      [{ kind: 'setting', id: 'runway_threshold_months', label: 'Runway threshold' }],
    );
  }

  // Subscription price changes.
  for (const change of input.priceChanges ?? []) {
    const percent = decString(dec(change.changeShare).times(100), 1);
    add(
      'subscription_price_change',
      change.seriesKey,
      change.changedOn,
      'info',
      `${change.name} price ${change.direction === 'increase' ? 'went up' : 'went down'}`,
      change.detail,
      `The latest charge was ${change.latest.amount} ${change.latest.currency} against a typical ${change.previousTypical.amount} ${change.previousTypical.currency}: ${percent}%.`,
      change.links,
    );
  }

  // Unusual transactions.
  for (const anomaly of input.anomalies ?? []) {
    add(
      'unusual_transaction',
      anomaly.transactionId,
      anomaly.date,
      anomaly.severity,
      'A transaction is worth a look',
      `${anomaly.reason} ${anomaly.note}`,
      `Compared with ${anomaly.numbers.comparedTo} over ${anomaly.numbers.sampleSize} transaction(s): value ${anomaly.numbers.value} ${anomaly.numbers.currency}` +
        (anomaly.numbers.zScore ? `, robust z ${anomaly.numbers.zScore} against a threshold of ${anomaly.numbers.threshold}.` : `, threshold ${anomaly.numbers.threshold}.`),
      anomaly.links,
    );
  }

  // Coverage gaps / missing history.
  for (const gap of input.coverageGaps ?? []) {
    const label = gap.accountName ?? gap.accountId;
    add(
      'coverage_gap',
      `${gap.accountId}`,
      `${gap.from}..${gap.to}`,
      'warning',
      `History is missing for ${label}`,
      `${label} has no transaction history from ${gap.from} to ${gap.to}. Figures that cover that period are incomplete.`,
      `${gap.reason} The gap runs from ${gap.from} to ${gap.to}, which is ${diffDays(gap.from, gap.to) + 1} day(s).`,
      [{ kind: 'account', id: gap.accountId, label }],
    );
  }

  // Stale or broken connections.
  for (const connection of input.connections ?? []) {
    const unknown = connection.accountsWithUnknownBalance ?? 0;
    const hours = connection.lastSuccessAt === null ? null : ageInHours(connection.lastSuccessAt, input.now);
    const statusIsBad = connection.status !== 'connected' && connection.status !== 'syncing' && connection.status !== 'import_only';
    const tooOld = hours !== null && hours > staleAfterHours;
    const never = connection.lastSuccessAt === null;
    if (!statusIsBad && !tooOld) continue;
    add(
      'stale_connection',
      connection.id,
      isoWeekKey(input.today),
      unknown > 0 ? 'warning' : 'info',
      `${connection.name} has not updated`,
      `${connection.name} is ${connection.status.replace(/_/g, ' ')}${never ? ' and has never completed a sync' : `, last successful sync ${connection.lastSuccessAt}`}.` +
        (unknown > 0 ? ` ${unknown} account balance(s) are unknown as a result.` : ''),
      never
        ? `The connection status is ${connection.status} and no successful sync has been recorded.`
        : `The connection status is ${connection.status} and the last successful sync was ${Math.floor(hours ?? 0)} hour(s) ago, against a ${staleAfterHours}-hour limit.`,
      [{ kind: 'setting', id: connection.id, label: connection.name }],
    );
  }

  // Reviews.
  for (const review of input.reviews ?? []) {
    if (input.today < review.dueOn) continue;
    if (review.lastCompletedPeriodEnd !== null && review.lastCompletedPeriodEnd >= review.dueOn) continue;
    const overdueDays = diffDays(review.dueOn, input.today);
    if (review.kind === 'weekly') {
      add(
        'weekly_review_due',
        'weekly',
        isoWeekKey(review.dueOn),
        'info',
        'Your weekly review is ready',
        'The weekly review covers what changed, why it matters and one next action.',
        `The review became due on ${review.dueOn}, ${overdueDays} day(s) ago, and the last completed period ended ${review.lastCompletedPeriodEnd ?? 'never'}.`,
      );
    } else {
      add(
        'monthly_close_due',
        'monthly',
        monthKey(review.dueOn),
        'info',
        'Monthly close is due',
        'The monthly close reconciles the period and closes the exceptions it raised.',
        `The close became due on ${review.dueOn}, ${overdueDays} day(s) ago, and the last completed period ended ${review.lastCompletedPeriodEnd ?? 'never'}.`,
      );
    }
  }

  // Business cash warnings.
  for (const warning of input.businessWarnings ?? []) {
    add(
      'business_cash_warning',
      warning.entityId,
      monthKey(input.today),
      warning.severity,
      `${warning.entityName}: cash needs attention`,
      warning.message,
      `${warning.entityName} raised a ${warning.severity} cash warning: ${warning.message}`,
      [{ kind: 'account', id: warning.entityId, label: warning.entityName }],
    );
  }

  const alerts = out.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || compareStrings(a.kind, b.kind) || compareStrings(a.dedupeKey, b.dedupeKey),
  );
  return { alerts, deferredCount: alerts.filter((a) => a.deferred).length };
}

/** Maps a descriptor onto the contract notification record. */
export function toNotification(alert: AlertDescriptor, options: { id: string; createdAt: string; readAt?: string | null }): Notification {
  return {
    id: options.id,
    kind: alert.kind,
    severity: alert.severity,
    title: alert.title,
    body: alert.body,
    why: alert.why,
    href: alert.href,
    createdAt: options.createdAt,
    readAt: options.readAt ?? null,
  };
}
