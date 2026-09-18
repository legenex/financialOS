/**
 * Data-completeness indicator.
 *
 * This is NOT a financial health score. It says nothing about whether the finances are good or bad; it says
 * how much of the picture FinancialOS actually has. The formula is part of the output, there is no hidden
 * weighting, and every component that cannot be measured is dropped from the formula and listed as a
 * limitation instead of being guessed at.
 *
 *   fresh balances   = active accounts with a known balance newer than the staleness limit / active accounts
 *   coverage         = min(months of transaction history / 24, 1)
 *   classified       = classified transactions / transactions
 *   reconciled       = reconciled account periods / account periods
 *
 *   indicator        = Σ (component × weight), where every known component carries the same weight 1 / n
 */
import type { Explanation, Money, ResultStatus } from '@financialos/contracts';
import type { IsoDate } from '../dates';
import { D, type Dec } from '../money';
import { ExplanationBuilder } from './explain-local';
import { ageInHours, decString, PlanningError } from './shared';

/** Said in the output, every time. */
export const NOT_A_HEALTH_SCORE =
  'This is a data-completeness indicator, not a financial health score. It measures how much of your financial picture FinancialOS holds, not how well you are doing.';

export type CompletenessComponentId = 'fresh_balances' | 'coverage_months' | 'classified_share' | 'reconciled_share';

export interface CompletenessAccount {
  id: string;
  name: string;
  status: 'active' | 'closed';
  /** Null = unknown. Unknown is never treated as zero. */
  balance: Money | null;
  /** ISO date or date-time the balance was true. Null = unknown age. */
  balanceAsOf: string | null;
}

export interface CompletenessComponent {
  id: CompletenessComponentId;
  label: string;
  /** 0–1, or null when the component could not be measured. */
  value: string | null;
  /** Share of the indicator this component carries. '0' when it is not measurable. */
  weight: string;
  numerator: string;
  denominator: string;
  /** The component's own arithmetic, in words. */
  formula: string;
  known: boolean;
}

export interface DataCompletenessResult {
  status: ResultStatus;
  /** 0–1, or null when too little is measurable. */
  score: string | null;
  percent: string | null;
  components: CompletenessComponent[];
  /** The whole formula, with the weights actually used. */
  formula: string;
  weighting: string;
  limitations: string[];
  disclaimer: string;
  okThreshold: string;
  explanation: Explanation;
}

export interface DataCompletenessInput {
  now: string;
  asOf: IsoDate;
  accounts: readonly CompletenessAccount[];
  /** Months of transaction history actually covered. Null = unknown. */
  coverageMonths: number | null;
  /** Transaction counts for the covered history. Null = unknown. */
  transactions: { total: number; classified: number } | null;
  /** Account-period counts. Null = unknown. */
  periods: { total: number; reconciled: number } | null;
  /** Hours after which a balance stops counting as fresh (default 48). */
  staleAfterHours?: number;
  /** Months of history treated as full coverage (default 24). */
  coverageTargetMonths?: number;
  /** Indicator at or above which the status is `ok` (default 0.8). */
  okThreshold?: string;
}

const LABEL: Record<CompletenessComponentId, string> = {
  fresh_balances: 'Accounts with a fresh, known balance',
  coverage_months: 'Months of transaction history',
  classified_share: 'Transactions classified',
  reconciled_share: 'Account periods reconciled',
};

function ratio(numerator: number, denominator: number): Dec {
  return denominator === 0 ? new D(0) : new D(numerator).dividedBy(denominator);
}

/** Ratio capped at 1: more than the target's worth of history is still full coverage, never more. */
function cappedRatio(numerator: number, denominator: number): Dec {
  const value = ratio(numerator, denominator);
  return value.greaterThan(1) ? new D(1) : value;
}

/**
 * The transparent completeness indicator. Components that cannot be measured are excluded from the formula
 * and reported; the remaining components keep equal weights.
 */
export function dataCompleteness(input: DataCompletenessInput): DataCompletenessResult {
  const staleAfterHours = input.staleAfterHours ?? 48;
  const coverageTarget = input.coverageTargetMonths ?? 24;
  const okThreshold = new D(input.okThreshold ?? '0.8');
  if (coverageTarget <= 0) throw new PlanningError('coverageTargetMonths must be positive');
  const limitations: string[] = [];

  const activeAccounts = input.accounts.filter((a) => a.status === 'active');
  const staleOrUnknown: string[] = [];
  let fresh = 0;
  for (const account of activeAccounts) {
    if (account.balance === null) {
      staleOrUnknown.push(`${account.name} (balance unknown)`);
      continue;
    }
    if (account.balanceAsOf === null) {
      staleOrUnknown.push(`${account.name} (balance age unknown)`);
      continue;
    }
    const age = ageInHours(account.balanceAsOf, input.now);
    if (age > staleAfterHours) staleOrUnknown.push(`${account.name} (${Math.floor(age)} h old)`);
    else fresh += 1;
  }

  const raw: Array<{ id: CompletenessComponentId; value: Dec | null; numerator: string; denominator: string; formula: string }> = [
    {
      id: 'fresh_balances',
      value: activeAccounts.length === 0 ? null : ratio(fresh, activeAccounts.length),
      numerator: String(fresh),
      denominator: String(activeAccounts.length),
      formula: `${fresh} of ${activeAccounts.length} active account(s) have a known balance no older than ${staleAfterHours} h`,
    },
    {
      id: 'coverage_months',
      value: input.coverageMonths === null ? null : cappedRatio(input.coverageMonths, coverageTarget),
      numerator: input.coverageMonths === null ? 'unknown' : String(input.coverageMonths),
      denominator: String(coverageTarget),
      formula:
        input.coverageMonths === null
          ? `months of history are unknown, against a ${coverageTarget}-month target`
          : `${input.coverageMonths} of ${coverageTarget} target months of transaction history (capped at 1)`,
    },
    {
      id: 'classified_share',
      value: input.transactions === null || input.transactions.total === 0 ? null : ratio(input.transactions.classified, input.transactions.total),
      numerator: input.transactions === null ? 'unknown' : String(input.transactions.classified),
      denominator: input.transactions === null ? 'unknown' : String(input.transactions.total),
      formula:
        input.transactions === null
          ? 'transaction counts are unknown'
          : input.transactions.total === 0
            ? 'no transactions are recorded, so nothing can be classified'
            : `${input.transactions.classified} of ${input.transactions.total} transaction(s) are classified`,
    },
    {
      id: 'reconciled_share',
      value: input.periods === null || input.periods.total === 0 ? null : ratio(input.periods.reconciled, input.periods.total),
      numerator: input.periods === null ? 'unknown' : String(input.periods.reconciled),
      denominator: input.periods === null ? 'unknown' : String(input.periods.total),
      formula:
        input.periods === null
          ? 'account-period counts are unknown'
          : input.periods.total === 0
            ? 'no account period is recorded, so nothing can be reconciled'
            : `${input.periods.reconciled} of ${input.periods.total} account period(s) are reconciled`,
    },
  ];

  const knownCount = raw.filter((c) => c.value !== null).length;
  const weight = knownCount === 0 ? new D(0) : new D(1).dividedBy(knownCount);
  const components: CompletenessComponent[] = raw.map((c) => ({
    id: c.id,
    label: LABEL[c.id],
    value: c.value === null ? null : decString(c.value, 6),
    weight: c.value === null ? '0' : decString(weight, 6),
    numerator: c.numerator,
    denominator: c.denominator,
    formula: c.formula,
    known: c.value !== null,
  }));

  // One measurable component is not a picture of anything: below two, no aggregate is given at all.
  const score = knownCount < 2 ? null : raw.filter((c) => c.value !== null).reduce((acc, c) => acc.plus(c.value!.times(weight)), new D(0));

  // Limitations: what is missing, and what was left out of the formula.
  if (staleOrUnknown.length > 0) limitations.push(`No fresh balance for: ${staleOrUnknown.join(', ')}.`);
  if (activeAccounts.length === 0) limitations.push('No active account is recorded, so balance freshness is left out of the formula.');
  if (input.coverageMonths === null) limitations.push('Months of transaction history are unknown, so coverage is left out of the formula.');
  else if (input.coverageMonths < coverageTarget) limitations.push(`Transaction history covers ${input.coverageMonths} of the ${coverageTarget} months this indicator asks for.`);
  if (input.transactions === null) limitations.push('Transaction counts are unknown, so the classified share is left out of the formula.');
  else if (input.transactions.total === 0) limitations.push('No transactions are recorded, so the classified share is left out of the formula.');
  else if (input.transactions.classified < input.transactions.total) {
    limitations.push(`${input.transactions.total - input.transactions.classified} transaction(s) are unclassified, so category figures are incomplete.`);
  }
  if (input.periods === null) limitations.push('Account-period counts are unknown, so the reconciled share is left out of the formula.');
  else if (input.periods.total === 0) limitations.push('No account period is recorded, so the reconciled share is left out of the formula.');
  else if (input.periods.reconciled < input.periods.total) {
    limitations.push(`${input.periods.total - input.periods.reconciled} account period(s) are not reconciled, so the balances they cover are not yet proven.`);
  }
  if (knownCount > 0 && knownCount < raw.length) {
    limitations.push(`${raw.length - knownCount} of ${raw.length} components could not be measured; the rest carry equal weights of ${decString(weight, 6)}.`);
  }

  const status: ResultStatus =
    knownCount < 2 ? 'insufficient_data' : knownCount < raw.length || score === null || score.lessThan(okThreshold) ? 'provisional' : 'ok';

  const weighting = knownCount === 0 ? 'no component could be measured' : `every measurable component carries the same weight, ${decString(weight, 6)} (1 / ${knownCount})`;
  const formula = `completeness = ${raw
    .filter((c) => c.value !== null)
    .map((c) => `${decString(weight, 6)} × ${c.id}`)
    .join(' + ') || 'not computable'}`;

  const explain = new ExplanationBuilder(
    knownCount < 2
      ? 'Too little is measurable to give a completeness indicator'
      : `${decString((score ?? new D(0)).times(100), 1)}% of the data this indicator looks for is present`,
    `${formula}; ${weighting}`,
  );
  explain.assume(NOT_A_HEALTH_SCORE);
  explain.assume(`Components: ${raw.map((c) => c.id).join(', ')}. Weighting: ${weighting}.`);
  for (const component of components) {
    explain.add(`${component.label}: ${component.known ? decString(new D(component.value!).times(100), 1) + '%' : 'not measurable'}`, null, component.known ? 'input' : 'missing', {
      note: `${component.formula} (weight ${component.weight})`,
    });
  }
  for (const limitation of limitations) explain.missing(limitation);
  explain.result('Data completeness', null, {
    note: score === null ? 'Not computable' : `${decString(score.times(100), 1)}% — status ${status}; ok at or above ${decString(okThreshold.times(100), 0)}%`,
  });

  return {
    status,
    score: score === null ? null : decString(score, 6),
    percent: score === null ? null : decString(score.times(100), 2),
    components,
    formula,
    weighting,
    limitations,
    disclaimer: NOT_A_HEALTH_SCORE,
    okThreshold: decString(okThreshold, 4),
    explanation: explain.build(),
  };
}
