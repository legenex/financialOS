/**
 * Unusual-transaction detection.
 *
 * Everything here compares a transaction with the owner's own history, using robust statistics that a few
 * large payments cannot drag around:
 *
 *   median      = middle value of the comparison group
 *   MAD         = median(|x − median|)
 *   scale       = MAD / 0.6745, or (when MAD is zero) 1.2533 × mean(|x − median|)
 *   z           = (x − median) / scale        flagged when z > threshold (default 3.5)
 *
 * Groups are (category, direction) and (counterparty, direction); amounts are converted to the home currency
 * first so they are comparable. Three further checks need no distribution: a counterparty never seen before
 * above an amount threshold, a charge that looks like a repeat of a recent identical one, and a
 * foreign-currency transaction that is an outlier for that currency or the first ever in it.
 *
 * Wording rule: a statistical outlier is "unusual" and "worth a look". It is never evidence of wrongdoing, and
 * this module never says or implies that. A transaction that cannot be converted is reported as unassessed,
 * never as normal.
 */
import type { Money, SourceLink } from '@financialos/contracts';
import { diffDays, type IsoDate } from '../dates';
import type { FxTable } from '../fx';
import { D, dec, money, type Dec } from '../money';
import { exceptionDescriptor } from '../core/explain';
import type { ExceptionDescriptor } from '../core/types';
import { compareStrings, convertOrNull, decString, median, normaliseLabel, roundedMoney, stableId } from './shared';

/** Wording attached to every finding. An outlier is a prompt to look, never a claim about anyone's conduct. */
export const ANOMALY_NOTE = 'Unusual compared with your own history. It may be entirely expected; it is only worth a look.';

export interface AnomalyTransaction {
  id: string;
  accountId: string;
  accountName?: string | null;
  date: IsoDate;
  /** Signed: negative = money left the account. */
  amount: Money;
  description: string;
  counterparty?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  entityId?: string | null;
  status?: 'pending' | 'posted' | 'reversed' | 'superseded';
}

export type AnomalyKind =
  | 'amount_outlier_category'
  | 'amount_outlier_counterparty'
  | 'first_seen_counterparty'
  | 'possible_duplicate_charge'
  | 'foreign_currency_outlier';

export type SpreadBasis = 'mad' | 'mean_abs_dev' | 'none';

export interface AnomalyNumbers {
  /** The transaction magnitude in the home currency. */
  value: string;
  median: string | null;
  scale: string | null;
  zScore: string | null;
  sampleSize: number;
  threshold: string;
  currency: string;
  /** The group the value was compared with, in words. */
  comparedTo: string;
  basis: SpreadBasis | 'count' | 'exact_match';
}

export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  severity: 'info' | 'warning';
  transactionId: string;
  accountId: string;
  date: IsoDate;
  /** The transaction's own signed amount. */
  amount: Money;
  /** Magnitude converted to the home currency, or null when no rate was available. */
  amountInHome: Money | null;
  reason: string;
  note: string;
  numbers: AnomalyNumbers;
  relatedTransactionIds: string[];
  links: SourceLink[];
  exception: ExceptionDescriptor;
}

export interface AnomalyOptions {
  /** Robust z above which a value is flagged (default 3.5, Iglewicz–Hoaglin). */
  zThreshold?: string;
  minCategorySample?: number;
  minCounterpartySample?: number;
  minForeignSample?: number;
  /** Magnitudes at or below this (home currency) are never flagged. Null = no floor. */
  minimumAmount?: Money | null;
  /** A counterparty with no earlier transaction is flagged at or above this (home currency). Null = never. */
  firstSeenThreshold?: Money | null;
  /** Days within which an identical amount at the same counterparty looks like a repeat (default 3). */
  duplicateWindowDays?: number;
}

export interface AnomalySkip {
  transactionId: string | null;
  group: string;
  reason: string;
}

export interface AnomalyResult {
  anomalies: Anomaly[];
  /** Groups or transactions that could not be assessed. Unassessed is not the same as normal. */
  skipped: AnomalySkip[];
  assessedCount: number;
}

export interface AnomalyInput {
  asOf: IsoDate;
  homeCurrency: string;
  fx: FxTable;
  /** Full history: it both defines what is typical and supplies the rows to assess. */
  transactions: readonly AnomalyTransaction[];
  /** Only transactions dated inside this window are reported. Default: every transaction. */
  window?: { from: IsoDate; to: IsoDate };
  options?: AnomalyOptions;
}

export interface RobustSpread {
  median: Dec;
  mad: Dec;
  meanAbsoluteDeviation: Dec;
  /** Denominator of the z-score. Zero when the sample has no spread at all. */
  scale: Dec;
  basis: SpreadBasis;
  sampleSize: number;
}

/** median(|x − median|). */
export function medianAbsoluteDeviation(values: readonly Dec[]): Dec {
  const med = median(values);
  return median(values.map((v) => v.minus(med).abs()));
}

/** mean(|x − median|). Used only when the MAD is zero. */
export function meanAbsoluteDeviation(values: readonly Dec[]): Dec {
  const med = median(values);
  return values.reduce((acc, v) => acc.plus(v.minus(med).abs()), new D(0)).dividedBy(values.length);
}

/** Median, MAD and the z-score denominator for a sample. */
export function robustSpread(values: readonly Dec[]): RobustSpread {
  const med = median(values);
  const mad = medianAbsoluteDeviation(values);
  const meanAd = meanAbsoluteDeviation(values);
  if (mad.greaterThan(0)) {
    return { median: med, mad, meanAbsoluteDeviation: meanAd, scale: mad.dividedBy('0.6745'), basis: 'mad', sampleSize: values.length };
  }
  if (meanAd.greaterThan(0)) {
    return { median: med, mad, meanAbsoluteDeviation: meanAd, scale: meanAd.times('1.2533'), basis: 'mean_abs_dev', sampleSize: values.length };
  }
  return { median: med, mad, meanAbsoluteDeviation: meanAd, scale: new D(0), basis: 'none', sampleSize: values.length };
}

/** (value − median) / scale, or null when the sample has no spread. */
export function robustZScore(value: Dec, spread: RobustSpread): Dec | null {
  if (!spread.scale.greaterThan(0)) return null;
  return value.minus(spread.median).dividedBy(spread.scale);
}

interface Assessed {
  tx: AnomalyTransaction;
  direction: 'in' | 'out';
  magnitude: Dec;
  /** Magnitude in the home currency, or null when no rate was available. */
  home: Dec | null;
  counterpartyKey: string;
  counterpartyLabel: string;
  inWindow: boolean;
}

function directionWord(direction: 'in' | 'out'): string {
  return direction === 'out' ? 'money out' : 'money in';
}

export function detectAnomalies(input: AnomalyInput): AnomalyResult {
  const options = input.options ?? {};
  const threshold = dec(options.zThreshold ?? '3.5');
  const minCategorySample = options.minCategorySample ?? 6;
  const minCounterpartySample = options.minCounterpartySample ?? 5;
  const minForeignSample = options.minForeignSample ?? 5;
  const duplicateWindowDays = options.duplicateWindowDays ?? 3;
  const floor = options.minimumAmount ? dec(options.minimumAmount.amount).abs() : null;
  const firstSeenThreshold = options.firstSeenThreshold ? dec(options.firstSeenThreshold.amount).abs() : null;
  const home = input.homeCurrency;
  const skipped: AnomalySkip[] = [];

  const rows: Assessed[] = [];
  for (const tx of [...input.transactions].sort((a, b) => compareStrings(a.date, b.date) || compareStrings(a.id, b.id))) {
    if (tx.status === 'reversed' || tx.status === 'superseded') continue;
    const signed = dec(tx.amount.amount);
    if (signed.isZero()) continue;
    const magnitude = signed.abs();
    const converted = convertOrNull(money(magnitude, tx.amount.currency), home, tx.date, input.fx, { method: 'historical' });
    const label = (tx.counterparty ?? tx.description).trim();
    const inWindow = input.window ? tx.date >= input.window.from && tx.date <= input.window.to : true;
    if (converted.value === null && inWindow) {
      skipped.push({ transactionId: tx.id, group: `currency ${tx.amount.currency}`, reason: converted.reason });
    }
    rows.push({
      tx,
      direction: signed.isNegative() ? 'out' : 'in',
      magnitude,
      home: converted.value === null ? null : dec(converted.value.amount),
      counterpartyKey: normaliseLabel(label),
      counterpartyLabel: label,
      inWindow,
    });
  }

  const anomalies: Anomaly[] = [];
  const seen = new Set<string>();
  const link = (row: Assessed): SourceLink => ({ kind: 'transaction', id: row.tx.id, label: `${row.tx.date} ${row.tx.description}` });

  const push = (
    row: Assessed,
    kind: AnomalyKind,
    severity: 'info' | 'warning',
    reason: string,
    numbers: AnomalyNumbers,
    related: readonly Assessed[] = [],
  ): void => {
    const key = `${row.tx.id}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    anomalies.push({
      id: stableId('anomaly', key),
      kind,
      severity,
      transactionId: row.tx.id,
      accountId: row.tx.accountId,
      date: row.tx.date,
      amount: row.tx.amount,
      amountInHome: row.home === null ? null : roundedMoney(row.home, home),
      reason,
      note: ANOMALY_NOTE,
      numbers,
      relatedTransactionIds: related.map((r) => r.tx.id),
      links: [link(row), ...related.map(link)],
      exception: exceptionDescriptor({
        kind: 'unusual_transaction',
        severity,
        title: `Unusual transaction: ${row.counterpartyLabel}`,
        detail: `${reason} ${ANOMALY_NOTE}`,
        subject: { type: 'transaction', id: row.tx.id, label: row.counterpartyLabel },
        entityId: row.tx.entityId ?? null,
        discriminator: kind,
      }),
    });
  };

  const aboveFloor = (row: Assessed): boolean => row.home !== null && (floor === null || row.home.greaterThan(floor));

  // ---- Distribution outliers per category and per counterparty -------------------------------------------
  interface Group {
    key: string;
    label: string;
    rows: Assessed[];
    minSample: number;
    kind: AnomalyKind;
  }
  const groups = new Map<string, Group>();
  const addToGroup = (key: string, label: string, minSample: number, kind: AnomalyKind, row: Assessed) => {
    const group = groups.get(key) ?? { key, label, rows: [], minSample, kind };
    group.rows.push(row);
    groups.set(key, group);
  };
  for (const row of rows) {
    if (row.home === null) continue;
    if (row.tx.categoryId) {
      addToGroup(
        `category:${row.tx.categoryId}:${row.direction}`,
        `${row.tx.categoryName ?? row.tx.categoryId} (${directionWord(row.direction)})`,
        minCategorySample,
        'amount_outlier_category',
        row,
      );
    }
    if (row.counterpartyKey.length > 0) {
      addToGroup(
        `counterparty:${row.counterpartyKey}:${row.direction}`,
        `${row.counterpartyLabel} (${directionWord(row.direction)})`,
        minCounterpartySample,
        'amount_outlier_counterparty',
        row,
      );
    }
    if (row.tx.amount.currency !== home) {
      addToGroup(
        `currency:${row.tx.amount.currency}:${row.direction}`,
        `${row.tx.amount.currency} spending (${directionWord(row.direction)})`,
        minForeignSample,
        'foreign_currency_outlier',
        row,
      );
    }
  }

  for (const group of [...groups.values()].sort((a, b) => compareStrings(a.key, b.key))) {
    const values = group.rows.map((r) => r.home!);
    if (values.length < group.minSample) {
      if (group.rows.some((r) => r.inWindow)) {
        skipped.push({ transactionId: null, group: group.label, reason: `Only ${values.length} transaction(s); ${group.minSample} are needed before an outlier means anything` });
      }
      continue;
    }
    const spread = robustSpread(values);
    if (spread.basis === 'none') {
      if (group.rows.some((r) => r.inWindow)) {
        skipped.push({ transactionId: null, group: group.label, reason: 'Every transaction in this group has the same amount, so there is no spread to compare against' });
      }
      continue;
    }
    for (const row of group.rows) {
      if (!row.inWindow || !aboveFloor(row)) continue;
      const z = robustZScore(row.home!, spread);
      if (z === null || z.lessThanOrEqualTo(threshold)) continue;
      const times = spread.median.greaterThan(0) ? decString(row.home!.dividedBy(spread.median), 1) : null;
      const reason =
        `${decString(row.home!, 2)} ${home} is unusual for ${group.label}: ` +
        (times ? `about ${times} times the usual ${decString(spread.median, 2)} ${home}` : `well above the usual ${decString(spread.median, 2)} ${home}`) +
        ` across ${spread.sampleSize} comparable transactions (robust z ${decString(z, 2)}, threshold ${decString(threshold, 2)}).`;
      push(row, group.kind, 'warning', reason, {
        value: decString(row.home!, 2),
        median: decString(spread.median, 2),
        scale: decString(spread.scale, 6),
        zScore: decString(z, 6),
        sampleSize: spread.sampleSize,
        threshold: decString(threshold, 4),
        currency: home,
        comparedTo: group.label,
        basis: spread.basis,
      });
    }
  }

  // ---- First-seen counterparty above a threshold ---------------------------------------------------------
  if (firstSeenThreshold !== null) {
    const firstDate = new Map<string, { date: IsoDate; id: string }>();
    for (const row of rows) {
      if (row.counterpartyKey.length === 0) continue;
      const current = firstDate.get(row.counterpartyKey);
      if (!current || row.tx.date < current.date || (row.tx.date === current.date && row.tx.id < current.id)) {
        firstDate.set(row.counterpartyKey, { date: row.tx.date, id: row.tx.id });
      }
    }
    for (const row of rows) {
      if (!row.inWindow || row.counterpartyKey.length === 0 || row.home === null) continue;
      const first = firstDate.get(row.counterpartyKey)!;
      if (first.id !== row.tx.id) continue;
      if (row.home.lessThan(firstSeenThreshold)) continue;
      const count = rows.filter((r) => r.counterpartyKey === row.counterpartyKey).length;
      push(
        row,
        'first_seen_counterparty',
        'info',
        `${decString(row.home, 2)} ${home} to ${row.counterpartyLabel} is the first payment recorded for this counterparty and is at or above your ${decString(firstSeenThreshold, 2)} ${home} review threshold.`,
        {
          value: decString(row.home, 2),
          median: null,
          scale: null,
          zScore: null,
          sampleSize: count,
          threshold: decString(firstSeenThreshold, 2),
          currency: home,
          comparedTo: `earlier transactions with ${row.counterpartyLabel}`,
          basis: 'count',
        },
      );
    }
  }

  // ---- Duplicate-looking charges ------------------------------------------------------------------------
  for (const row of rows) {
    if (!row.inWindow || row.counterpartyKey.length === 0) continue;
    const earlier = rows.filter(
      (other) =>
        other.tx.id !== row.tx.id &&
        other.counterpartyKey === row.counterpartyKey &&
        other.tx.amount.currency === row.tx.amount.currency &&
        other.magnitude.equals(row.magnitude) &&
        other.direction === row.direction &&
        (other.tx.date < row.tx.date || (other.tx.date === row.tx.date && other.tx.id < row.tx.id)) &&
        diffDays(other.tx.date, row.tx.date) <= duplicateWindowDays,
    );
    if (earlier.length === 0) continue;
    const previous = earlier[earlier.length - 1]!;
    const gap = diffDays(previous.tx.date, row.tx.date);
    push(
      row,
      'possible_duplicate_charge',
      'warning',
      `${decString(row.magnitude, 2)} ${row.tx.amount.currency} to ${row.counterpartyLabel} repeats an identical amount from ${previous.tx.date} (${gap} day(s) earlier). It may be a genuine second payment or the same charge recorded twice.`,
      {
        value: decString(row.magnitude, 2),
        median: null,
        scale: null,
        zScore: null,
        sampleSize: earlier.length + 1,
        threshold: String(duplicateWindowDays),
        currency: row.tx.amount.currency,
        comparedTo: `identical amounts at ${row.counterpartyLabel} within ${duplicateWindowDays} day(s)`,
        basis: 'exact_match',
      },
      [previous],
    );
  }

  // ---- First transaction ever in a foreign currency ------------------------------------------------------
  if (firstSeenThreshold !== null) {
    const firstInCurrency = new Map<string, { date: IsoDate; id: string }>();
    for (const row of rows) {
      if (row.tx.amount.currency === home) continue;
      const current = firstInCurrency.get(row.tx.amount.currency);
      if (!current || row.tx.date < current.date || (row.tx.date === current.date && row.tx.id < current.id)) {
        firstInCurrency.set(row.tx.amount.currency, { date: row.tx.date, id: row.tx.id });
      }
    }
    for (const row of rows) {
      if (!row.inWindow || row.tx.amount.currency === home || row.home === null) continue;
      if (firstInCurrency.get(row.tx.amount.currency)?.id !== row.tx.id) continue;
      if (row.home.lessThan(firstSeenThreshold)) continue;
      push(
        row,
        'foreign_currency_outlier',
        'info',
        `${decString(row.magnitude, 2)} ${row.tx.amount.currency} (${decString(row.home, 2)} ${home}) is the first transaction recorded in ${row.tx.amount.currency}.`,
        {
          value: decString(row.home, 2),
          median: null,
          scale: null,
          zScore: null,
          sampleSize: rows.filter((r) => r.tx.amount.currency === row.tx.amount.currency).length,
          threshold: decString(firstSeenThreshold, 2),
          currency: home,
          comparedTo: `earlier transactions in ${row.tx.amount.currency}`,
          basis: 'count',
        },
      );
    }
  }

  return {
    anomalies: anomalies.sort((a, b) => compareStrings(a.date, b.date) || compareStrings(a.transactionId, b.transactionId) || compareStrings(a.kind, b.kind)),
    skipped: skipped.sort((a, b) => compareStrings(a.group, b.group) || compareStrings(a.transactionId ?? '', b.transactionId ?? '')),
    assessedCount: rows.filter((r) => r.inWindow).length,
  };
}
