/**
 * Achievements, awarded only on verified evidence of work the owner actually did:
 *
 *   review_completed            a review with status 'completed' and a completion timestamp
 *   reconciled_account          an account period whose reconciliation status is 'balanced'
 *   goal_contribution_verified  a contribution with status 'verified' and a real transaction behind it
 *   verified_saving             a month whose verified net saving is positive AND is backed by a real,
 *                               verified balance change attributed to contributions
 *   exceptions_cleared          the exception inbox actually reaching zero open items
 *   streak                      consecutive completed weekly reviews
 *
 * Nothing is awarded for trading frequency, for spending, for credit utilisation, for market appreciation, or
 * for actions that were only planned or suggested. Those are either luck, or the opposite of what this tool is
 * for, and rewarding them would push behaviour in the wrong direction. Every rejection is reported in
 * `skipped` with its reason, so the exclusions are visible rather than silent.
 */
import type { Achievement, Money, Reconciliation, Review, SourceLink } from '@financialos/contracts';
import { diffDays, type IsoDate } from '../dates';
import { dec } from '../money';
import { compareStrings, stableId } from './shared';

/** Documented, enforced exclusions. */
export const NEVER_AWARDED_FOR = [
  'trading frequency or the number of trades placed',
  'how much or how little was spent',
  'credit utilisation or a credit score',
  'market appreciation or investment gains',
  'planned or suggested actions that were never carried out',
] as const;

export interface CompletedReviewEvidence {
  id: string;
  kind: Review['kind'];
  periodStart: IsoDate;
  periodEnd: IsoDate;
  status: Review['status'];
  /** Null when the review was never finished. */
  completedAt: string | null;
}

export interface ReconciledPeriodEvidence {
  id: string;
  accountId: string;
  accountName: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  status: Reconciliation['status'];
  difference: Money | null;
  completedAt: string | null;
}

export interface GoalContributionEvidence {
  id: string;
  goalId: string;
  goalName: string;
  amount: Money;
  date: IsoDate;
  status: 'planned' | 'verified';
  /** The transaction that proves the money moved. Required for an award. */
  transactionId: string | null;
  verifiedAt: string | null;
}

export interface MonthlySavingEvidence {
  /** Calendar month, `YYYY-MM`. */
  month: string;
  accountId: string;
  accountName: string;
  openingBalance: Money | null;
  closingBalance: Money | null;
  /** Verified net saving for the month (real inflows less real outflows). Null = unknown. */
  netVerified: Money | null;
  /** True only when both balances come from verified statements or provider balances. */
  balanceChangeVerified: boolean;
  /** Only 'contributions' can earn an award: market movement is not saving. */
  attributedTo: 'contributions' | 'market_movement' | 'unknown';
  verifiedAt: string | null;
}

export interface ExceptionClearanceEvidence {
  id: string;
  at: string;
  clearedCount: number;
  /** Items still open after the clearance. The award needs this to be zero. */
  remainingOpen: number;
}

export interface SkippedAward {
  kind: Achievement['kind'];
  subjectId: string;
  reason: string;
}

export interface StreakSummary {
  /** Length of the run that ends with the most recent completed weekly review. */
  current: number;
  longest: number;
  longestEndedOn: IsoDate | null;
}

export interface AchievementResult {
  achievements: Achievement[];
  skipped: SkippedAward[];
  streak: StreakSummary;
}

export interface AchievementInput {
  /** Evidence dated after this instant is ignored. */
  asOf: string;
  reviews?: readonly CompletedReviewEvidence[];
  reconciliations?: readonly ReconciledPeriodEvidence[];
  goalContributions?: readonly GoalContributionEvidence[];
  monthlySavings?: readonly MonthlySavingEvidence[];
  exceptionClearances?: readonly ExceptionClearanceEvidence[];
  /** Consecutive weekly reviews needed for a streak award (default 4). */
  minStreak?: number;
}

function inFuture(at: string, asOf: string): boolean {
  const t = Date.parse(at);
  const limit = Date.parse(asOf);
  return Number.isNaN(t) || Number.isNaN(limit) ? true : t > limit;
}

function settingLink(id: string, label: string): SourceLink {
  return { kind: 'setting', id, label };
}

/** Longest and current runs of consecutive completed weekly reviews (period starts exactly 7 days apart). */
export function weeklyStreak(reviews: readonly CompletedReviewEvidence[]): { runs: CompletedReviewEvidence[][]; summary: StreakSummary } {
  const weekly = reviews
    .filter((r) => r.kind === 'weekly' && r.status === 'completed' && r.completedAt !== null)
    .sort((a, b) => compareStrings(a.periodStart, b.periodStart) || compareStrings(a.id, b.id));
  const runs: CompletedReviewEvidence[][] = [];
  for (const review of weekly) {
    const currentRun = runs[runs.length - 1];
    const previous = currentRun?.[currentRun.length - 1];
    if (currentRun && previous && diffDays(previous.periodStart, review.periodStart) === 7) currentRun.push(review);
    else if (currentRun && previous && previous.periodStart === review.periodStart) continue;
    else runs.push([review]);
  }
  const longestRun = runs.reduce<CompletedReviewEvidence[] | null>((best, run) => (best === null || run.length > best.length ? run : best), null);
  const lastRun = runs[runs.length - 1] ?? null;
  return {
    runs,
    summary: {
      current: lastRun?.length ?? 0,
      longest: longestRun?.length ?? 0,
      longestEndedOn: longestRun ? longestRun[longestRun.length - 1]!.periodEnd : null,
    },
  };
}

/** Awards achievements from verified evidence only. Every rejection is reported with its reason. */
export function awardAchievements(input: AchievementInput): AchievementResult {
  const minStreak = input.minStreak ?? 4;
  const achievements: Achievement[] = [];
  const skipped: SkippedAward[] = [];

  const award = (kind: Achievement['kind'], subjectId: string, title: string, earnedAt: string, evidence: SourceLink[]): void => {
    achievements.push({ id: stableId('achievement', `${kind}:${subjectId}`), kind, title, earnedAt, evidence });
  };
  const skip = (kind: Achievement['kind'], subjectId: string, reason: string): void => {
    skipped.push({ kind, subjectId, reason });
  };

  // Completed reviews.
  for (const review of input.reviews ?? []) {
    if (review.status !== 'completed') {
      skip('review_completed', review.id, `Review status is ${review.status}: only a completed review counts.`);
      continue;
    }
    if (review.completedAt === null) {
      skip('review_completed', review.id, 'The review has no completion timestamp, so there is no evidence it was finished.');
      continue;
    }
    if (inFuture(review.completedAt, input.asOf)) {
      skip('review_completed', review.id, 'The completion timestamp is in the future.');
      continue;
    }
    award('review_completed', review.id, `${review.kind === 'weekly' ? 'Weekly' : 'Monthly'} review completed for ${review.periodStart} to ${review.periodEnd}`, review.completedAt, [
      settingLink(review.id, `${review.kind} review ${review.periodStart} to ${review.periodEnd}`),
    ]);
  }

  // Reconciled account periods.
  for (const period of input.reconciliations ?? []) {
    if (period.status !== 'balanced') {
      skip('reconciled_account', period.id, `Reconciliation status is ${period.status}: only a balanced period counts.`);
      continue;
    }
    if (period.difference !== null && !dec(period.difference.amount).isZero()) {
      skip('reconciled_account', period.id, `The period is marked balanced but carries a difference of ${period.difference.amount} ${period.difference.currency}.`);
      continue;
    }
    if (period.completedAt === null || inFuture(period.completedAt, input.asOf)) {
      skip('reconciled_account', period.id, 'The reconciliation has no usable completion timestamp.');
      continue;
    }
    award('reconciled_account', period.id, `${period.accountName} reconciled for ${period.periodStart} to ${period.periodEnd}`, period.completedAt, [
      { kind: 'account', id: period.accountId, label: period.accountName },
      { kind: 'snapshot', id: period.id, label: `Reconciliation ${period.periodStart} to ${period.periodEnd}` },
    ]);
  }

  // Verified goal contributions.
  for (const contribution of input.goalContributions ?? []) {
    if (contribution.status !== 'verified') {
      skip('goal_contribution_verified', contribution.id, 'The contribution is planned, not verified. A plan is not a payment.');
      continue;
    }
    if (contribution.transactionId === null) {
      skip('goal_contribution_verified', contribution.id, 'No transaction backs the contribution, so the money cannot be shown to have moved.');
      continue;
    }
    if (!dec(contribution.amount.amount).greaterThan(0)) {
      skip('goal_contribution_verified', contribution.id, 'The contribution amount is not positive.');
      continue;
    }
    if (contribution.verifiedAt === null || inFuture(contribution.verifiedAt, input.asOf)) {
      skip('goal_contribution_verified', contribution.id, 'The contribution has no usable verification timestamp.');
      continue;
    }
    award('goal_contribution_verified', contribution.id, `Verified contribution to ${contribution.goalName}`, contribution.verifiedAt, [
      { kind: 'goal', id: contribution.goalId, label: contribution.goalName },
      { kind: 'transaction', id: contribution.transactionId, label: `Contribution ${contribution.date}` },
    ]);
  }

  // Verified savings.
  for (const saving of input.monthlySavings ?? []) {
    const subject = `${saving.accountId}:${saving.month}`;
    if (saving.netVerified === null || !dec(saving.netVerified.amount).greaterThan(0)) {
      skip('verified_saving', subject, 'Verified net saving for the month is not positive or is unknown.');
      continue;
    }
    if (!saving.balanceChangeVerified) {
      skip('verified_saving', subject, 'The balance change behind the saving is not verified, so the saving is not proven.');
      continue;
    }
    if (saving.openingBalance === null || saving.closingBalance === null) {
      skip('verified_saving', subject, 'An opening or closing balance is unknown, so the balance change cannot be checked.');
      continue;
    }
    if (saving.openingBalance.currency !== saving.closingBalance.currency) {
      skip('verified_saving', subject, 'Opening and closing balances are in different currencies, so the change cannot be checked.');
      continue;
    }
    if (!dec(saving.closingBalance.amount).minus(dec(saving.openingBalance.amount)).greaterThan(0)) {
      skip('verified_saving', subject, 'The real balance did not rise over the month, so there is no saving to recognise.');
      continue;
    }
    if (saving.attributedTo !== 'contributions') {
      skip(
        'verified_saving',
        subject,
        saving.attributedTo === 'market_movement'
          ? 'The balance rose through market movement, which is not saving and is never awarded.'
          : 'What drove the balance change is unknown, so it is not treated as saving.',
      );
      continue;
    }
    if (saving.verifiedAt === null || inFuture(saving.verifiedAt, input.asOf)) {
      skip('verified_saving', subject, 'The month has no usable verification timestamp.');
      continue;
    }
    award('verified_saving', subject, `Saved ${saving.netVerified.amount} ${saving.netVerified.currency} in ${saving.month}, backed by a real balance change`, saving.verifiedAt, [
      { kind: 'account', id: saving.accountId, label: saving.accountName },
      { kind: 'snapshot', id: `${saving.accountId}:${saving.month}`, label: `Balances for ${saving.month}` },
    ]);
  }

  // Exception inbox cleared.
  for (const clearance of input.exceptionClearances ?? []) {
    if (clearance.clearedCount <= 0) {
      skip('exceptions_cleared', clearance.id, 'No exception was actually cleared.');
      continue;
    }
    if (clearance.remainingOpen !== 0) {
      skip('exceptions_cleared', clearance.id, `${clearance.remainingOpen} exception(s) are still open, so the inbox was not cleared.`);
      continue;
    }
    if (inFuture(clearance.at, input.asOf)) {
      skip('exceptions_cleared', clearance.id, 'The clearance timestamp is in the future.');
      continue;
    }
    award('exceptions_cleared', clearance.id, `Exception inbox cleared: ${clearance.clearedCount} item(s) resolved`, clearance.at, [
      { kind: 'exception', id: clearance.id, label: `Cleared ${clearance.clearedCount} item(s)` },
    ]);
  }

  // Streak of consecutive weekly reviews.
  const { runs, summary } = weeklyStreak(input.reviews ?? []);
  const eligible = runs
    .filter((run) => run.length >= minStreak && !inFuture(run[run.length - 1]!.completedAt!, input.asOf))
    .sort((a, b) => b.length - a.length || compareStrings(a[0]!.periodStart, b[0]!.periodStart));
  const best = eligible[0];
  if (best) {
    award('streak', `weekly:${best[0]!.periodStart}:${best.length}`, `${best.length} weekly reviews in a row`, best[best.length - 1]!.completedAt!, [
      ...best.map((review) => settingLink(review.id, `Weekly review ${review.periodStart} to ${review.periodEnd}`)),
    ]);
  } else if (summary.longest > 0) {
    skip('streak', `weekly:${summary.longest}`, `The longest run of completed weekly reviews is ${summary.longest}; ${minStreak} in a row are needed.`);
  }

  return {
    achievements: achievements.sort((a, b) => compareStrings(a.earnedAt, b.earnedAt) || compareStrings(a.kind, b.kind) || compareStrings(a.id, b.id)),
    skipped: skipped.sort((a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.subjectId, b.subjectId)),
    streak: summary,
  };
}
