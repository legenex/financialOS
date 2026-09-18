import { Achievement } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import {
  awardAchievements,
  NEVER_AWARDED_FOR,
  weeklyStreak,
  type AchievementInput,
  type CompletedReviewEvidence,
  type ExceptionClearanceEvidence,
  type GoalContributionEvidence,
  type MonthlySavingEvidence,
  type ReconciledPeriodEvidence,
} from './achievements';
import { deepFreeze, uid, zar } from './testing';

const ACCOUNT = uid(200);
const GOAL = uid(201);
const NOW = '2026-03-10T08:00:00Z';

function review(overrides: Partial<CompletedReviewEvidence> = {}): CompletedReviewEvidence {
  return { id: uid(210), kind: 'weekly', periodStart: '2026-03-02', periodEnd: '2026-03-08', status: 'completed', completedAt: '2026-03-09T18:00:00Z', ...overrides };
}

function reconciliation(overrides: Partial<ReconciledPeriodEvidence> = {}): ReconciledPeriodEvidence {
  return {
    id: uid(220),
    accountId: ACCOUNT,
    accountName: 'Everyday account',
    periodStart: '2026-02-01',
    periodEnd: '2026-02-28',
    status: 'balanced',
    difference: zar('0'),
    completedAt: '2026-03-02T09:00:00Z',
    ...overrides,
  };
}

function contribution(overrides: Partial<GoalContributionEvidence> = {}): GoalContributionEvidence {
  return {
    id: uid(230),
    goalId: GOAL,
    goalName: 'Emergency reserve',
    amount: zar('2000'),
    date: '2026-03-01',
    status: 'verified',
    transactionId: uid(231),
    verifiedAt: '2026-03-01T12:00:00Z',
    ...overrides,
  };
}

function saving(overrides: Partial<MonthlySavingEvidence> = {}): MonthlySavingEvidence {
  return {
    month: '2026-02',
    accountId: ACCOUNT,
    accountName: 'Savings account',
    openingBalance: zar('40000'),
    closingBalance: zar('43000'),
    netVerified: zar('3000'),
    balanceChangeVerified: true,
    attributedTo: 'contributions',
    verifiedAt: '2026-03-01T06:00:00Z',
    ...overrides,
  };
}

function clearance(overrides: Partial<ExceptionClearanceEvidence> = {}): ExceptionClearanceEvidence {
  return { id: uid(240), at: '2026-03-08T16:00:00Z', clearedCount: 4, remainingOpen: 0, ...overrides };
}

function input(overrides: Partial<AchievementInput> = {}): AchievementInput {
  return { asOf: NOW, ...overrides };
}

/** Five weekly periods in a row. */
const WEEKS = ['2026-02-02', '2026-02-09', '2026-02-16', '2026-02-23', '2026-03-02'];
const streakReviews = WEEKS.map((start, i) =>
  review({ id: uid(300 + i), periodStart: start, periodEnd: `${start.slice(0, 8)}${String(Number(start.slice(8)) + 6).padStart(2, '0')}`, completedAt: `2026-03-0${i + 1}T10:00:00Z` }),
);

describe('awards on verified evidence', () => {
  it('awards a completed review', () => {
    const result = awardAchievements(input({ reviews: deepFreeze([review()]) }));
    expect(result.achievements).toHaveLength(1);
    const achievement = result.achievements[0]!;
    expect(() => Achievement.parse(achievement)).not.toThrow();
    expect(achievement.kind).toBe('review_completed');
    expect(achievement.title).toBe('Weekly review completed for 2026-03-02 to 2026-03-08');
    expect(achievement.earnedAt).toBe('2026-03-09T18:00:00Z');
    expect(achievement.evidence).toHaveLength(1);
  });

  it('awards a balanced account period, with the account and the reconciliation as evidence', () => {
    const result = awardAchievements(input({ reconciliations: [reconciliation()] }));
    expect(result.achievements[0]!.kind).toBe('reconciled_account');
    expect(result.achievements[0]!.title).toBe('Everyday account reconciled for 2026-02-01 to 2026-02-28');
    expect(result.achievements[0]!.evidence.map((e) => e.kind)).toEqual(['account', 'snapshot']);
  });

  it('awards a verified goal contribution backed by a transaction', () => {
    const result = awardAchievements(input({ goalContributions: [contribution()] }));
    expect(result.achievements[0]!.kind).toBe('goal_contribution_verified');
    expect(result.achievements[0]!.evidence.map((e) => e.kind)).toEqual(['goal', 'transaction']);
  });

  it('awards a verified saving backed by a real balance change', () => {
    const result = awardAchievements(input({ monthlySavings: [saving()] }));
    expect(result.achievements[0]!.kind).toBe('verified_saving');
    expect(result.achievements[0]!.title).toBe('Saved 3000 ZAR in 2026-02, backed by a real balance change');
  });

  it('awards a cleared exception inbox only when it actually reached zero', () => {
    const result = awardAchievements(input({ exceptionClearances: [clearance()] }));
    expect(result.achievements[0]!.kind).toBe('exceptions_cleared');
    expect(result.achievements[0]!.title).toBe('Exception inbox cleared: 4 item(s) resolved');
  });

  it('is deterministic: the same evidence gives the same ids in the same order', () => {
    const facts = input({ reviews: streakReviews, reconciliations: [reconciliation()], goalContributions: [contribution()], monthlySavings: [saving()], exceptionClearances: [clearance()] });
    expect(JSON.stringify(awardAchievements(facts))).toBe(JSON.stringify(awardAchievements(facts)));
    const result = awardAchievements(facts);
    expect(result.achievements.map((a) => a.earnedAt)).toEqual([...result.achievements.map((a) => a.earnedAt)].sort());
    expect(result.achievements.every((a) => /^[0-9a-f-]{36}$/.test(a.id))).toBe(true);
  });
});

describe('refuses unverified evidence', () => {
  it('refuses a review that was not completed or has no timestamp', () => {
    for (const [evidence, fragment] of [
      [review({ status: 'draft' }), 'Review status is draft'],
      [review({ status: 'in_progress' }), 'Review status is in_progress'],
      [review({ completedAt: null }), 'no completion timestamp'],
      [review({ completedAt: '2026-03-20T10:00:00Z' }), 'in the future'],
    ] as const) {
      const result = awardAchievements(input({ reviews: [evidence] }));
      expect(result.achievements).toEqual([]);
      expect(result.skipped[0]!.reason).toContain(fragment);
    }
  });

  it('refuses a period that is not balanced, or is balanced but carries a difference', () => {
    for (const [evidence, fragment] of [
      [reconciliation({ status: 'discrepancy' }), 'Reconciliation status is discrepancy'],
      [reconciliation({ status: 'incomplete' }), 'Reconciliation status is incomplete'],
      [reconciliation({ difference: zar('12.50') }), 'carries a difference of 12.5 ZAR'],
      [reconciliation({ completedAt: null }), 'no usable completion timestamp'],
    ] as const) {
      const result = awardAchievements(input({ reconciliations: [evidence] }));
      expect(result.achievements).toEqual([]);
      expect(result.skipped[0]!.reason).toContain(fragment);
    }
  });

  it('refuses a contribution that is only planned or has no transaction behind it', () => {
    const planned = awardAchievements(input({ goalContributions: [contribution({ status: 'planned' })] }));
    expect(planned.achievements).toEqual([]);
    expect(planned.skipped[0]!.reason).toBe('The contribution is planned, not verified. A plan is not a payment.');

    const untraced = awardAchievements(input({ goalContributions: [contribution({ transactionId: null })] }));
    expect(untraced.achievements).toEqual([]);
    expect(untraced.skipped[0]!.reason).toContain('No transaction backs the contribution');

    const zeroed = awardAchievements(input({ goalContributions: [contribution({ amount: zar('0') })] }));
    expect(zeroed.achievements).toEqual([]);
  });

  it('refuses a saving that is not proven by a verified balance change', () => {
    for (const [evidence, fragment] of [
      [saving({ netVerified: null }), 'not positive or is unknown'],
      [saving({ netVerified: zar('-500') }), 'not positive or is unknown'],
      [saving({ balanceChangeVerified: false }), 'not verified, so the saving is not proven'],
      [saving({ openingBalance: null }), 'opening or closing balance is unknown'],
      [saving({ closingBalance: zar('39000') }), 'balance did not rise over the month'],
      [saving({ openingBalance: { amount: '40000', currency: 'USD' } }), 'different currencies'],
      [saving({ verifiedAt: null }), 'no usable verification timestamp'],
    ] as const) {
      const result = awardAchievements(input({ monthlySavings: [evidence] }));
      expect(result.achievements).toEqual([]);
      expect(result.skipped[0]!.reason).toContain(fragment);
    }
  });

  it('refuses a clearance that left items open, or cleared nothing', () => {
    const partial = awardAchievements(input({ exceptionClearances: [clearance({ remainingOpen: 3 })] }));
    expect(partial.achievements).toEqual([]);
    expect(partial.skipped[0]!.reason).toBe('3 exception(s) are still open, so the inbox was not cleared.');
    expect(awardAchievements(input({ exceptionClearances: [clearance({ clearedCount: 0 })] })).achievements).toEqual([]);
  });
});

describe('never awarded for', () => {
  it('names the exclusions in the module contract', () => {
    expect(NEVER_AWARDED_FOR.join(' ')).toContain('trading frequency');
    expect(NEVER_AWARDED_FOR.join(' ')).toContain('how much or how little was spent');
    expect(NEVER_AWARDED_FOR.join(' ')).toContain('credit utilisation');
    expect(NEVER_AWARDED_FOR.join(' ')).toContain('market appreciation');
    expect(NEVER_AWARDED_FOR.join(' ')).toContain('planned or suggested actions');
  });

  it('never awards a balance that grew through market appreciation', () => {
    const result = awardAchievements(input({ monthlySavings: [saving({ attributedTo: 'market_movement', closingBalance: zar('60000'), netVerified: zar('20000') })] }));
    expect(result.achievements).toEqual([]);
    expect(result.skipped[0]!.reason).toBe('The balance rose through market movement, which is not saving and is never awarded.');
  });

  it('never awards a balance change whose cause is unknown', () => {
    const result = awardAchievements(input({ monthlySavings: [saving({ attributedTo: 'unknown' })] }));
    expect(result.achievements).toEqual([]);
    expect(result.skipped[0]!.reason).toBe('What drove the balance change is unknown, so it is not treated as saving.');
  });

  it('never awards a planned action, only a carried-out one', () => {
    const result = awardAchievements(
      input({ goalContributions: [contribution({ status: 'planned', transactionId: null }), contribution({ id: uid(232), status: 'planned' })], reviews: [review({ status: 'draft' })] }),
    );
    expect(result.achievements).toEqual([]);
    expect(result.skipped).toHaveLength(3);
  });

  it('has no achievement kind for trading, spending, credit use or market gains', () => {
    const kinds = Achievement.shape.kind.options;
    expect(kinds).toEqual(['review_completed', 'reconciled_account', 'goal_contribution_verified', 'verified_saving', 'exceptions_cleared', 'streak']);
    for (const forbidden of ['trade', 'trading', 'spend', 'spending', 'credit', 'market', 'gain', 'profit', 'return']) {
      expect(kinds.some((k) => k.includes(forbidden))).toBe(false);
    }
  });

  it('awards nothing at all from an empty evidence set', () => {
    const result = awardAchievements(input());
    expect(result).toEqual({ achievements: [], skipped: [], streak: { current: 0, longest: 0, longestEndedOn: null } });
  });
});

describe('streaks', () => {
  it('counts consecutive completed weekly reviews', () => {
    const { summary } = weeklyStreak(streakReviews);
    expect(summary).toEqual({ current: 5, longest: 5, longestEndedOn: '2026-03-08' });
    const result = awardAchievements(input({ reviews: streakReviews }));
    const streak = result.achievements.find((a) => a.kind === 'streak')!;
    expect(streak.title).toBe('5 weekly reviews in a row');
    expect(streak.earnedAt).toBe('2026-03-05T10:00:00Z');
    expect(streak.evidence).toHaveLength(5);
    expect(result.streak).toEqual({ current: 5, longest: 5, longestEndedOn: '2026-03-08' });
  });

  it('breaks the run on a missed week', () => {
    const withGap = [streakReviews[0]!, streakReviews[1]!, streakReviews[3]!, streakReviews[4]!];
    const { summary } = weeklyStreak(withGap);
    // Two runs of two; the first one wins the tie, so the longest run ends on 2026-02-15.
    expect(summary).toEqual({ current: 2, longest: 2, longestEndedOn: '2026-02-15' });
    const result = awardAchievements(input({ reviews: withGap }));
    expect(result.achievements.some((a) => a.kind === 'streak')).toBe(false);
    expect(result.skipped.find((s) => s.kind === 'streak')!.reason).toBe('The longest run of completed weekly reviews is 2; 4 in a row are needed.');
  });

  it('respects a configured minimum', () => {
    const withGap = [streakReviews[0]!, streakReviews[1]!, streakReviews[3]!, streakReviews[4]!];
    const result = awardAchievements(input({ reviews: withGap, minStreak: 2 }));
    expect(result.achievements.find((a) => a.kind === 'streak')!.title).toBe('2 weekly reviews in a row');
  });

  it('ignores monthly and unfinished reviews in the run', () => {
    const mixed = [
      ...streakReviews.slice(0, 3),
      review({ id: uid(320), kind: 'monthly', periodStart: '2026-02-01', periodEnd: '2026-02-28', completedAt: '2026-03-01T10:00:00Z' }),
      review({ id: uid(321), periodStart: '2026-02-23', periodEnd: '2026-03-01', status: 'in_progress', completedAt: null }),
    ];
    expect(weeklyStreak(mixed).summary.longest).toBe(3);
  });

  it('never counts a review completed in the future', () => {
    const future = streakReviews.map((r, i) => (i === 4 ? review({ ...r, completedAt: '2026-04-01T10:00:00Z' }) : r));
    const result = awardAchievements(input({ reviews: future }));
    expect(result.achievements.some((a) => a.kind === 'streak')).toBe(false);
    expect(result.achievements.filter((a) => a.kind === 'review_completed')).toHaveLength(4);
  });
});
