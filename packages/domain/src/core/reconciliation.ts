/**
 * Reconciliation checks. These functions only report: they never create a balancing transaction. A difference
 * is surfaced (with an exception descriptor) for the owner to investigate.
 */
import type { CoverageGap, Explanation, Money, Reconciliation } from '@financialos/contracts';
import { addDays, compareDates, daysInMonth, diffDays, isValidIsoDate, makeDate, maxDate, minDate, parseIsoDate, startOfMonth, addMonths, type IsoDate } from '../dates';
import { CurrencyMismatchError, D, dec, money, type Dec } from '../money';
import { ExplanationBuilder, exceptionDescriptor } from './explain';
import type { ExceptionDescriptor } from './types';

export class ReconciliationError extends Error {
  override name = 'ReconciliationError';
}

// ---------------------------------------------------------------------------------------------------------
// Statement check
// ---------------------------------------------------------------------------------------------------------

export interface StatementMovement {
  amount: Money;
  pending?: boolean;
  bookedOn?: IsoDate | null;
  rowNumber?: number;
}

export interface StatementCheckInput {
  accountId: string;
  accountLabel?: string;
  currency: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  opening: Money | null;
  closing: Money | null;
  movements: readonly StatementMovement[];
  entityId?: string | null;
}

export interface StatementCheckResult {
  accountId: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  status: 'balanced' | 'discrepancy' | 'incomplete';
  openingBalance: Money | null;
  movements: Money;
  expectedClosing: Money | null;
  actualClosing: Money | null;
  /** actual closing − expected closing. Null when either side is unknown. */
  difference: Money | null;
  movementCount: number;
  excludedPending: number;
  excludedOutOfPeriod: number;
  excludedOtherCurrency: number;
  explanation: Explanation;
  exception: ExceptionDescriptor | null;
}

/** Checks opening + Σ(posted movements in period) = closing. Never produces a balancing entry. */
export function checkStatement(input: StatementCheckInput): StatementCheckResult {
  if (!isValidIsoDate(input.periodStart) || !isValidIsoDate(input.periodEnd) || input.periodEnd < input.periodStart) {
    throw new ReconciliationError(`Invalid statement period ${input.periodStart} – ${input.periodEnd}`);
  }
  const { currency } = input;
  for (const balance of [input.opening, input.closing]) {
    if (balance && balance.currency !== currency) throw new CurrencyMismatchError(currency, balance.currency);
  }
  const label = input.accountLabel ?? input.accountId;
  const explain = new ExplanationBuilder(`Statement check for ${label}, ${input.periodStart} to ${input.periodEnd}`, 'opening + movements = closing');

  let total: Dec = new D(0);
  let counted = 0;
  let pending = 0;
  let outOfPeriod = 0;
  let otherCurrency = 0;
  for (const m of input.movements) {
    if (m.amount.currency !== currency) {
      otherCurrency += 1;
      continue;
    }
    if (m.pending) {
      pending += 1;
      continue;
    }
    if (m.bookedOn && (m.bookedOn < input.periodStart || m.bookedOn > input.periodEnd)) {
      outOfPeriod += 1;
      continue;
    }
    total = total.plus(dec(m.amount.amount));
    counted += 1;
  }
  const movements = money(total, currency);
  explain.input('Opening balance', input.opening).input(`Posted movements (${counted})`, movements).input('Closing balance', input.closing);
  if (pending > 0) explain.assume(`${pending} pending row(s) excluded; statements balance on posted movements`, true);
  if (outOfPeriod > 0) explain.assume(`${outOfPeriod} row(s) dated outside the statement period excluded`, true);
  if (otherCurrency > 0) explain.missing(`${otherCurrency} row(s) in another currency cannot be checked against a ${currency} statement`, true);
  if (!input.opening) explain.missing('Opening balance is unknown', true);
  if (!input.closing) explain.missing('Closing balance is unknown', true);

  const expected = input.opening ? money(dec(input.opening.amount).plus(total), currency) : null;
  const difference = expected && input.closing ? money(dec(input.closing.amount).minus(dec(expected.amount)), currency) : null;
  let status: StatementCheckResult['status'];
  if (!difference || otherCurrency > 0) status = 'incomplete';
  else status = dec(difference.amount).isZero() ? 'balanced' : 'discrepancy';

  explain.result('Expected closing', expected).result('Difference (actual − expected)', difference);
  explain.setSummary(
    status === 'balanced'
      ? `Statement balances for ${label}`
      : status === 'discrepancy'
        ? `Statement for ${label} is off by ${difference!.amount} ${currency}; no balancing entry was created`
        : `Statement for ${label} cannot be fully checked`,
  );

  const subject = { type: 'account', id: input.accountId, label };
  let exception: ExceptionDescriptor | null = null;
  if (status === 'discrepancy') {
    exception = exceptionDescriptor({
      kind: 'reconciliation_discrepancy',
      severity: 'warning',
      title: `Statement difference of ${difference!.amount} ${currency}`,
      detail: `Opening ${input.opening!.amount} + movements ${movements.amount} = ${expected!.amount}, but the statement closes at ${input.closing!.amount}. Check for missing, duplicated or pending rows. Nothing was posted to force a balance.`,
      subject,
      entityId: input.entityId ?? null,
      discriminator: `${input.periodStart}..${input.periodEnd}`,
    });
  } else if (status === 'incomplete') {
    exception = exceptionDescriptor({
      kind: 'reconciliation_question',
      severity: 'info',
      title: 'Statement could not be fully reconciled',
      detail: explain.build().missing.join('; ') || 'Rows in another currency were present',
      subject,
      entityId: input.entityId ?? null,
      discriminator: `${input.periodStart}..${input.periodEnd}`,
    });
  }

  return {
    accountId: input.accountId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    status,
    openingBalance: input.opening,
    movements,
    expectedClosing: expected,
    actualClosing: input.closing,
    difference,
    movementCount: counted,
    excludedPending: pending,
    excludedOutOfPeriod: outOfPeriod,
    excludedOtherCurrency: otherCurrency,
    explanation: explain.build(),
    exception,
  };
}

/** Maps a statement check to the contract `Reconciliation` record (unresolved). */
export function toReconciliationRecord(result: StatementCheckResult, ids: { id: string; batchId: string | null }): Reconciliation {
  return {
    id: ids.id,
    accountId: result.accountId,
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    openingBalance: result.openingBalance,
    movements: result.movements,
    expectedClosing: result.expectedClosing,
    actualClosing: result.actualClosing,
    difference: result.difference,
    status: result.status,
    batchId: ids.batchId,
    resolvedAt: null,
    resolution: null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Running balance continuity
// ---------------------------------------------------------------------------------------------------------

export interface BalanceRow {
  rowNumber: number;
  amount: Money;
  /** Balance after this row, when the file has a balance column. */
  balance: Money | null;
  bookedOn?: IsoDate | null;
}

export type RowOrder = 'oldest_first' | 'newest_first';

export interface BalanceBreak {
  rowNumber: number;
  /** Row whose balance the check started from (null when it started from the opening balance). */
  previousRowNumber: number | null;
  expected: Money;
  actual: Money;
  /** actual − expected */
  difference: Money;
}

export interface RunningBalanceResult {
  status: 'continuous' | 'broken' | 'not_applicable';
  order: RowOrder;
  orderDetectedFrom: 'option' | 'dates' | 'balances';
  checkedRows: number;
  rowsWithoutBalance: number;
  breaks: BalanceBreak[];
  /** Earliest break in chronological order. */
  firstBreak: BalanceBreak | null;
  explanation: string[];
}

function walk(rows: readonly BalanceRow[], order: RowOrder, opening: Money | null): { breaks: BalanceBreak[]; checked: number } {
  const chronological = order === 'oldest_first' ? rows : [...rows].reverse();
  const breaks: BalanceBreak[] = [];
  let checked = 0;
  let previous: { balance: Dec; rowNumber: number | null } | null = opening ? { balance: dec(opening.amount), rowNumber: null } : null;
  let accumulated: Dec = new D(0);
  for (const row of chronological) {
    accumulated = accumulated.plus(dec(row.amount.amount));
    if (!row.balance) continue;
    const actual = dec(row.balance.amount);
    if (previous) {
      const expected = previous.balance.plus(accumulated);
      checked += 1;
      if (!expected.equals(actual)) {
        const currency = row.balance.currency;
        breaks.push({
          rowNumber: row.rowNumber,
          previousRowNumber: previous.rowNumber,
          expected: money(expected, currency),
          actual: row.balance,
          difference: money(actual.minus(expected), currency),
        });
      }
    }
    previous = { balance: actual, rowNumber: row.rowNumber };
    accumulated = new D(0);
  }
  return { breaks, checked };
}

/**
 * Verifies that each row's balance equals the previous balance plus the movements in between. Rows without a
 * balance are carried forward. Files sorted newest-first are detected from dates, or failing that from which
 * order produces fewer breaks.
 */
export function checkRunningBalance(
  rows: readonly BalanceRow[],
  options: { order?: RowOrder | 'auto'; openingBalance?: Money | null } = {},
): RunningBalanceResult {
  const currencies = new Set<string>();
  for (const row of rows) {
    currencies.add(row.amount.currency);
    if (row.balance) currencies.add(row.balance.currency);
  }
  if (options.openingBalance) currencies.add(options.openingBalance.currency);
  if (currencies.size > 1) {
    const [a, b] = [...currencies];
    throw new CurrencyMismatchError(a!, b!);
  }
  const opening = options.openingBalance ?? null;
  const rowsWithoutBalance = rows.filter((r) => !r.balance).length;
  const explanation: string[] = [];

  let order: RowOrder;
  let orderDetectedFrom: RunningBalanceResult['orderDetectedFrom'];
  const requested = options.order ?? 'auto';
  if (requested !== 'auto') {
    order = requested;
    orderDetectedFrom = 'option';
  } else {
    const dated = rows.filter((r) => r.bookedOn && isValidIsoDate(r.bookedOn));
    const first = dated[0]?.bookedOn;
    const last = dated[dated.length - 1]?.bookedOn;
    if (first && last && first !== last) {
      order = compareDates(first, last) > 0 ? 'newest_first' : 'oldest_first';
      orderDetectedFrom = 'dates';
    } else {
      const oldest = walk(rows, 'oldest_first', opening);
      const newest = walk(rows, 'newest_first', opening);
      order = newest.breaks.length < oldest.breaks.length ? 'newest_first' : 'oldest_first';
      orderDetectedFrom = 'balances';
    }
  }
  explanation.push(`Rows treated as ${order.replace('_', ' ')} (from ${orderDetectedFrom})`);
  const { breaks, checked } = walk(rows, order, opening);
  if (rowsWithoutBalance > 0) explanation.push(`${rowsWithoutBalance} row(s) without a balance were carried into the next check`);

  if (checked === 0) {
    explanation.push('Not enough balance values to check continuity');
    return { status: 'not_applicable', order, orderDetectedFrom, checkedRows: 0, rowsWithoutBalance, breaks: [], firstBreak: null, explanation };
  }
  const firstBreak = breaks[0] ?? null;
  if (firstBreak) {
    explanation.push(
      `First break at row ${firstBreak.rowNumber}: expected ${firstBreak.expected.amount}, file shows ${firstBreak.actual.amount} (difference ${firstBreak.difference.amount})`,
    );
  } else {
    explanation.push(`All ${checked} balance checks passed`);
  }
  return { status: breaks.length > 0 ? 'broken' : 'continuous', order, orderDetectedFrom, checkedRows: checked, rowsWithoutBalance, breaks, firstBreak, explanation };
}

// ---------------------------------------------------------------------------------------------------------
// Coverage gaps
// ---------------------------------------------------------------------------------------------------------

export interface CoveragePeriod {
  from: IsoDate;
  to: IsoDate;
  source?: string | null;
}

export interface CoverageWindow {
  from: IsoDate;
  to: IsoDate;
}

export interface CoverageReport {
  accountId: string;
  window: CoverageWindow;
  gaps: CoverageGap[];
  windowDays: number;
  coveredDays: number;
  /** Months (YYYY-MM) in the window with no coverage at all. */
  missingMonths: string[];
  /** Months (YYYY-MM) in the window with some but not all days covered. */
  partialMonths: string[];
  complete: boolean;
  exceptions: ExceptionDescriptor[];
}

/** Window of `months` calendar months ending at `asOf` (inclusive), starting on the first of a month. */
export function coverageWindow(asOf: IsoDate, months: number): CoverageWindow {
  if (!Number.isInteger(months) || months < 1) throw new ReconciliationError('months must be a positive integer');
  return { from: startOfMonth(addMonths(asOf, -(months - 1))), to: asOf };
}

/** Merges overlapping or adjacent periods. */
export function mergeCoverage(periods: readonly CoveragePeriod[]): CoverageWindow[] {
  for (const p of periods) {
    if (!isValidIsoDate(p.from) || !isValidIsoDate(p.to) || p.to < p.from) throw new ReconciliationError(`Invalid coverage period ${p.from} – ${p.to}`);
  }
  const sorted = [...periods].sort((a, b) => compareDates(a.from, b.from) || compareDates(a.to, b.to));
  const merged: CoverageWindow[] = [];
  for (const p of sorted) {
    const last = merged[merged.length - 1];
    if (last && p.from <= addDays(last.to, 1)) last.to = maxDate(last.to, p.to);
    else merged.push({ from: p.from, to: p.to });
  }
  return merged;
}

/** Finds days in the window not covered by any period, plus missing and partial months. */
export function detectCoverageGaps(input: { accountId: string; accountLabel?: string; periods: readonly CoveragePeriod[]; window: CoverageWindow; entityId?: string | null }): CoverageReport {
  const { window } = input;
  if (!isValidIsoDate(window.from) || !isValidIsoDate(window.to) || window.to < window.from) {
    throw new ReconciliationError(`Invalid window ${window.from} – ${window.to}`);
  }
  const covered = mergeCoverage(input.periods)
    .filter((p) => p.to >= window.from && p.from <= window.to)
    .map((p) => ({ from: maxDate(p.from, window.from), to: minDate(p.to, window.to) }));

  const gaps: CoverageGap[] = [];
  let cursor = window.from;
  covered.forEach((p, index) => {
    if (p.from > cursor) {
      gaps.push({
        accountId: input.accountId,
        from: cursor,
        to: addDays(p.from, -1),
        reason: index === 0 ? 'No history before the first covered period in the requested window' : 'No statement or sync covers these dates',
      });
    }
    cursor = addDays(p.to, 1);
  });
  if (cursor <= window.to) {
    gaps.push({
      accountId: input.accountId,
      from: cursor,
      to: window.to,
      reason: covered.length === 0 ? 'No coverage at all in the requested window' : 'No coverage after the last covered period',
    });
  }

  const windowDays = diffDays(window.from, window.to) + 1;
  const coveredDays = covered.reduce((acc, p) => acc + diffDays(p.from, p.to) + 1, 0);

  const missingMonths: string[] = [];
  const partialMonths: string[] = [];
  let month = startOfMonth(window.from);
  while (month <= window.to) {
    const { y, m } = parseIsoDate(month);
    const from = maxDate(month, window.from);
    const to = minDate(makeDate(y, m, daysInMonth(y, m)), window.to);
    const days = diffDays(from, to) + 1;
    const coveredInMonth = covered.reduce((acc, p) => {
      const s = maxDate(p.from, from);
      const e = minDate(p.to, to);
      return e >= s ? acc + diffDays(s, e) + 1 : acc;
    }, 0);
    const key = month.slice(0, 7);
    if (coveredInMonth === 0) missingMonths.push(key);
    else if (coveredInMonth < days) partialMonths.push(key);
    month = addMonths(month, 1);
  }

  const label = input.accountLabel ?? input.accountId;
  const exceptions = gaps.map((gap) =>
    exceptionDescriptor({
      kind: 'missing_period',
      severity: 'warning',
      title: `Missing history ${gap.from} to ${gap.to}`,
      detail: `${gap.reason}. Import a statement or run a backfill for ${label} to cover these dates.`,
      subject: { type: 'account', id: input.accountId, label },
      entityId: input.entityId ?? null,
      discriminator: `${gap.from}..${gap.to}`,
    }),
  );

  return { accountId: input.accountId, window, gaps, windowDays, coveredDays, missingMonths, partialMonths, complete: gaps.length === 0, exceptions };
}
