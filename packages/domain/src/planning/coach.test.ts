import { CoachMessage, NextAction, Review, type Explanation, type RunwayResult, type SafeToSpendResult, type WealthSummary } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import {
  answerDeterministic,
  buildReview,
  COACH_GENERATED_BY,
  nextActions,
  routeQuestion,
  SUPPORTED_QUESTIONS,
  toCoachMessage,
  type CoachFacts,
} from './coach';
import { deepFreeze, uid, zar } from './testing';

const ACCOUNT = uid(100);
const CONNECTION = uid(101);
const ARRANGEMENT = uid(102);
const GOAL = uid(103);
const GROCERIES = uid(104);
const DINING = uid(105);
const TRANSACTION = uid(106);

const emptyExplanation = (summary: string): Explanation => ({ summary, formula: 'n/a', items: [], assumptions: [], missing: [] });

const SAFE_TO_SPEND: SafeToSpendResult = {
  status: 'provisional',
  amount: zar('4200'),
  shortfall: null,
  currency: 'ZAR',
  horizon: { from: '2026-03-10', to: '2026-04-09', days: 30, basis: 'fixed_days' },
  eligibleCash: zar('18000'),
  lowestProjectedBalance: zar('9200'),
  lowestProjectedOn: '2026-03-28',
  protectedReserves: zar('5000'),
  obligationsInHorizon: zar('8800'),
  expectedInflowsInHorizon: zar('0'),
  unknownAmountObligations: 1,
  confidence: 'medium',
  timeline: [],
  explanation: { ...emptyExplanation('Provisional'), missing: ['Everyday account: balance is 70 hours old'] },
  computedAt: '2026-03-10T08:00:00Z',
};

const RUNWAY: RunwayResult = {
  scope: { kind: 'personal', entityId: null, label: 'Personal' },
  status: 'finite',
  months: '4.25',
  depletionDate: '2026-07-18',
  liquidBalance: zar('51000'),
  averageMonthlyNetOutflow: zar('12000'),
  historyMonths: 6,
  minimumHistoryMonths: 3,
  explanation: emptyExplanation('Runway'),
};

const WEALTH: WealthSummary = {
  scope: 'personal',
  entityIds: [uid(1)],
  currency: 'ZAR',
  segments: [
    { liquidityClass: 'cash', label: 'Cash', total: zar('18000'), accountsCounted: 2, accountsUnknown: 1, unconvertedCount: 0, links: [{ kind: 'account', id: ACCOUNT, label: 'Everyday account' }] },
    { liquidityClass: 'liability', label: 'Liabilities', total: zar('-6000'), accountsCounted: 1, accountsUnknown: 0, unconvertedCount: 0, links: [] },
  ],
  netWorthKnown: zar('12000'),
  status: 'provisional',
  excludedThirdParty: zar('3000'),
  explanation: emptyExplanation('Provisional net worth for the personal scope'),
};

function facts(overrides: Partial<CoachFacts> = {}): CoachFacts {
  return {
    now: '2026-03-10T08:00:00Z',
    today: '2026-03-10',
    currency: 'ZAR',
    period: { start: '2026-03-02', end: '2026-03-08', label: 'week of 2 March 2026' },
    previousPeriod: { start: '2026-02-23', end: '2026-03-01', label: 'week of 23 February 2026' },
    safeToSpend: SAFE_TO_SPEND,
    runway: RUNWAY,
    wealth: WEALTH,
    upcoming: [
      { id: uid(110), date: '2026-03-13', label: 'Example Insurance Ltd premium', amount: zar('1250'), entityId: null, kind: 'bill', links: [{ kind: 'recurring', id: uid(110), label: 'Premium' }] },
      { id: uid(111), date: '2026-03-20', label: 'Sample Utility account', amount: null, entityId: null, kind: 'bill', links: [] },
    ],
    exceptions: [
      { id: uid(120), kind: 'reconciliation_discrepancy', severity: 'critical', status: 'open', title: 'Everyday account does not balance', detail: 'Opening plus movements is 240 ZAR away from the closing balance.' },
      { id: uid(121), kind: 'unclassified', severity: 'warning', status: 'open', title: '12 transactions are unclassified', detail: 'Category figures are incomplete until they are classified.' },
      { id: uid(122), kind: 'missing_information', severity: 'info', status: 'open', title: 'Property valuation has no date', detail: 'The valuation cannot be aged without one.' },
      { id: uid(123), kind: 'possible_duplicate', severity: 'warning', status: 'resolved', title: 'Resolved duplicate', detail: 'Already handled.' },
    ],
    exceptionsClosedInPeriod: [{ id: uid(123), kind: 'possible_duplicate', severity: 'warning', status: 'resolved', title: 'Resolved duplicate', detail: 'Already handled.' }],
    connections: [
      { id: CONNECTION, name: 'Sample Bank connection', status: 'needs_authorization', lastSuccessAt: '2026-03-01T06:00:00Z', accountsWithUnknownBalance: 2 },
      { id: uid(130), name: 'Sample Broker connection', status: 'stale', lastSuccessAt: '2026-03-05T06:00:00Z', accountsWithUnknownBalance: 0 },
      { id: uid(131), name: 'Sample Wallet connection', status: 'connected', lastSuccessAt: '2026-03-10T06:00:00Z', accountsWithUnknownBalance: 0 },
    ],
    thirdParty: [{ arrangementId: ARRANGEMENT, label: 'Third Party A', feeMode: 'unconfirmed', owed: zar('14500') }],
    reconciliation: [
      { accountId: ACCOUNT, accountName: 'Everyday account', periodStart: '2026-02-01', periodEnd: '2026-02-28', status: 'discrepancy' },
      { accountId: uid(140), accountName: 'Savings account', periodStart: '2026-02-01', periodEnd: '2026-02-28', status: 'balanced' },
    ],
    reserves: [{ goalId: GOAL, name: 'Emergency reserve', target: zar('30000'), fundedVerified: zar('22000'), protected: true, heldIn: 'eligible_cash_accounts' }],
    reviews: [{ kind: 'weekly', dueOn: '2026-03-09', lastCompletedPeriodEnd: '2026-03-01' }],
    spendingByCategory: [
      { categoryId: GROCERIES, name: 'Groceries', current: zar('4300'), previous: zar('3900'), links: [{ kind: 'transaction', id: TRANSACTION, label: '2026-03-04 Sample Grocer' }] },
      { categoryId: DINING, name: 'Dining out', current: zar('2100'), previous: zar('1200'), links: [] },
    ],
    budgetLines: [
      { categoryId: DINING, name: 'Dining out', planned: zar('1500'), actual: zar('2100'), links: [{ kind: 'transaction', id: TRANSACTION, label: 'Dining' }] },
      { categoryId: GROCERIES, name: 'Groceries', planned: zar('4500'), actual: zar('4300') },
    ],
    cashPosition: { current: zar('18000'), previous: zar('21000') },
    newRecurring: [{ id: uid(150), name: 'Sample Software Co', amount: zar('120'), cadence: 'monthly' }],
    ...overrides,
  };
}

function quietFacts(): CoachFacts {
  return facts({
    exceptions: [],
    exceptionsClosedInPeriod: [],
    connections: [{ id: uid(131), name: 'Sample Wallet connection', status: 'connected', lastSuccessAt: '2026-03-10T06:00:00Z', accountsWithUnknownBalance: 0 }],
    thirdParty: [],
    reconciliation: [{ accountId: ACCOUNT, accountName: 'Everyday account', periodStart: '2026-02-01', periodEnd: '2026-02-28', status: 'balanced' }],
    reserves: [{ goalId: GOAL, name: 'Emergency reserve', target: zar('30000'), fundedVerified: zar('30000'), protected: true, heldIn: 'eligible_cash_accounts' }],
    reviews: [{ kind: 'weekly', dueOn: '2026-03-16', lastCompletedPeriodEnd: '2026-03-08' }],
  });
}

const FORBIDDEN_WORDS = [
  'fraud',
  'irresponsible',
  'shame',
  'amazing',
  'well done',
  'great job',
  'fantastic',
  'excellent',
  'impressive',
  'congratulations',
  'proud of you',
  'stupid',
  'lazy',
  'guilty',
];

describe('nextActions', () => {
  it('ranks by impact and returns at most three', () => {
    const actions = nextActions(deepFreeze(facts()));
    expect(actions).toHaveLength(3);
    expect(actions.map((a) => a.id)).toEqual([`exception:${uid(120)}`, `connection:${CONNECTION}`, `fee-policy:${ARRANGEMENT}`]);
    expect(actions.map((a) => a.impact)).toEqual(['high', 'high', 'high']);
    expect(actions.map((a) => a.kind)).toEqual(['reconcile', 'connect', 'confirm_policy']);
    for (const action of actions) expect(() => NextAction.parse(action)).not.toThrow();
  });

  it('continues down the ranking when more are asked for', () => {
    const actions = nextActions(facts(), 9);
    expect(actions.map((a) => a.id)).toEqual([
      `exception:${uid(120)}`,
      `connection:${CONNECTION}`,
      `fee-policy:${ARRANGEMENT}`,
      `connection:${uid(130)}`,
      `exception:${uid(121)}`,
      `reconcile:${ACCOUNT}:2026-02-01`,
      `reserve:${GOAL}`,
      'review:weekly:2026-03-09',
      `exception:${uid(122)}`,
    ]);
  });

  it('explains why each action matters, in the owner numbers', () => {
    const actions = nextActions(facts(), 9);
    expect(actions[1]!.why).toContain('2 account balance(s) are unknown');
    expect(actions[2]!.why).toContain('14500 ZAR');
    expect(actions.find((a) => a.id === `reserve:${GOAL}`)!.title).toBe('Fund Emergency reserve: 8000 ZAR short');
    expect(actions.find((a) => a.id === 'review:weekly:2026-03-09')!.why).toBe('The weekly review became due on 2026-03-09, 1 day(s) ago.');
  });

  it('returns nothing when the records need nothing', () => {
    expect(nextActions(quietFacts())).toEqual([]);
  });

  it('ignores resolved exceptions, healthy connections, balanced periods and covered reserves', () => {
    const only = facts({
      exceptions: [{ id: uid(123), kind: 'possible_duplicate', severity: 'critical', status: 'resolved', title: 'Resolved', detail: 'Done.' }],
      connections: [{ id: uid(131), name: 'Sample Wallet connection', status: 'connected', lastSuccessAt: '2026-03-10T06:00:00Z', accountsWithUnknownBalance: 0 }],
      thirdParty: [{ arrangementId: ARRANGEMENT, label: 'Third Party A', feeMode: 'deducted_from_receipt', owed: zar('14500') }],
      reconciliation: [{ accountId: ACCOUNT, accountName: 'Everyday account', periodStart: '2026-02-01', periodEnd: '2026-02-28', status: 'balanced' }],
      reserves: [{ goalId: GOAL, name: 'Emergency reserve', target: zar('30000'), fundedVerified: zar('30000'), protected: true, heldIn: 'eligible_cash_accounts' }],
      reviews: [{ kind: 'weekly', dueOn: '2026-03-16', lastCompletedPeriodEnd: null }],
    });
    expect(nextActions(only)).toEqual([]);
  });

  it('never suggests funding a reserve that is not protected', () => {
    const unprotected = facts({ reserves: [{ goalId: GOAL, name: 'Travel fund', target: zar('30000'), fundedVerified: zar('0'), protected: false, heldIn: 'not_yet_funded' }] });
    expect(nextActions(unprotected, 9).some((a) => a.id.startsWith('reserve:'))).toBe(false);
  });
});

describe('buildReview', () => {
  it('produces a contract-valid weekly review with links on every section', () => {
    const review = buildReview('weekly', deepFreeze(facts()));
    expect(() => Review.parse(review)).not.toThrow();
    expect(review.generatedBy).toBe(COACH_GENERATED_BY);
    expect(review.kind).toBe('weekly');
    expect(review.periodStart).toBe('2026-03-02');
    expect(review.periodEnd).toBe('2026-03-08');
    expect(review.status).toBe('draft');
    expect(review.startedAt).toBe('2026-03-10T08:00:00Z');
    expect(review.completedAt).toBeNull();
    expect(review.whatChanged.map((s) => s.id)).toEqual(['spending-by-category', 'cash-position', 'new-recurring', 'exceptions']);
    expect(review.whyItMatters.map((s) => s.id)).toEqual(['runway', 'reserve-coverage', 'budget-variance']);
    for (const section of [...review.whatChanged, ...review.whyItMatters]) {
      expect(section.links.length).toBeGreaterThan(0);
      expect(section.body.length).toBeGreaterThan(0);
    }
  });

  it('reports what changed against the previous period', () => {
    const review = buildReview('weekly', facts());
    const spending = review.whatChanged[0]!;
    expect(spending.body).toContain('Groceries: 4300 ZAR (up 400 ZAR on week of 23 February 2026)');
    expect(spending.body).toContain('Dining out: 2100 ZAR (up 900 ZAR on week of 23 February 2026)');
    expect(review.whatChanged[1]!.body).toBe('Cash position is 18000 ZAR, down 3000 ZAR on week of 23 February 2026.');
    expect(review.whatChanged[2]!.body).toContain('Sample Software Co: 120 ZAR, monthly');
    expect(review.whatChanged[3]!.body).toBe('1 closed in this period, 3 still open (1 critical, 1 warning).');
  });

  it('leaves an unknown cash position unknown instead of zero', () => {
    const review = buildReview('weekly', facts({ cashPosition: { current: null, previous: zar('21000') } }));
    expect(review.whatChanged[1]!.body).toContain('is not known for this period');
    expect(review.whatChanged[1]!.body).toContain('rather than treated as zero');
  });

  it('carries exactly one next action, the highest-impact one', () => {
    const review = buildReview('weekly', facts());
    const top = nextActions(facts())[0]!;
    expect(review.nextAction).not.toBeNull();
    expect(review.nextAction!.id).toBe(top.id);
    expect(review.nextAction!.title).toBe(top.title);
    expect(review.nextAction!.links.length).toBeGreaterThan(0);
  });

  it('falls back to finishing the review when nothing needs attention', () => {
    const review = buildReview('weekly', quietFacts());
    expect(review.nextAction!.id).toBe('complete-review');
    expect(review.nextAction!.body).toContain('Nothing in the records needs attention right now');
  });

  it('names the trade-off between overspending and an underfunded goal without moralising', () => {
    const body = buildReview('weekly', facts()).whyItMatters[2]!.body;
    expect(body).toContain('Dining out came in 600 ZAR above plan this period');
    expect(body).toContain('Emergency reserve is 8000 ZAR short of its target');
    expect(body).toContain('Both can be true at once.');
    expect(body).not.toMatch(/should not|must not|bad habit/);
  });

  it('states runway and reserve cover with their own numbers', () => {
    const review = buildReview('weekly', facts());
    // 4.25 rounds half-even to 4.2 at one decimal place.
    expect(review.whyItMatters[0]!.body).toContain('Runway is 4.2 months, reaching zero around 2026-07-18');
    expect(review.whyItMatters[1]!.body).toContain('Emergency reserve: 22000 ZAR of 30000 ZAR verified, 8000 ZAR short, held inside eligible cash.');
  });

  it('reports an honest gap when runway cannot be given', () => {
    const short = buildReview('weekly', facts({ runway: { ...RUNWAY, status: 'insufficient_history', months: null, depletionDate: null, historyMonths: 1 } }));
    expect(short.whyItMatters[0]!.body).toBe('There are 1 month(s) of history and 3 are needed, so no runway figure is given rather than a misleading one.');
  });

  it('builds a checklist whose done flags follow the facts, with a monthly close step', () => {
    const weekly = buildReview('weekly', facts());
    expect(weekly.checklist.map((c) => c.id)).toEqual(['classify', 'connections', 'reconcile', 'reserves', 'exceptions', 'next-action']);
    expect(weekly.checklist.map((c) => c.done)).toEqual([false, false, false, false, false, false]);

    const monthly = buildReview('monthly', quietFacts());
    expect(monthly.checklist.map((c) => c.id)).toContain('close');
    expect(monthly.checklist.filter((c) => c.id !== 'next-action' && c.id !== 'close').every((c) => c.done)).toBe(true);
  });

  it('gives the same period the same review id every time', () => {
    expect(buildReview('weekly', facts()).id).toBe(buildReview('weekly', facts()).id);
    expect(buildReview('monthly', facts()).id).not.toBe(buildReview('weekly', facts()).id);
  });

  it('handles a period with no spending, no budget and no new recurring charges', () => {
    const bare = buildReview('weekly', facts({ spendingByCategory: [], budgetLines: [], newRecurring: [], previousPeriod: null }));
    expect(() => Review.parse(bare)).not.toThrow();
    expect(bare.whatChanged[0]!.body).toContain('No classified spending is recorded');
    expect(bare.whatChanged[2]!.body).toBe('No new recurring charge was detected in this period.');
    expect(bare.whyItMatters[2]!.body).toBe('No budget lines are set for this period, so there is no variance to report.');
  });
});

describe('routeQuestion', () => {
  it('routes the questions the records can answer', () => {
    expect(routeQuestion('How much is safe to spend?')).toBe('safe_to_spend');
    expect(routeQuestion('can I afford a new laptop')).toBe('safe_to_spend');
    expect(routeQuestion('How long is my runway?')).toBe('runway');
    expect(routeQuestion('when will I run out of cash')).toBe('runway');
    expect(routeQuestion('What is my biggest spending category?')).toBe('biggest_spending_category');
    expect(routeQuestion('what bills are coming up')).toBe('upcoming_bills');
    expect(routeQuestion('What needs attention?')).toBe('needs_attention');
    expect(routeQuestion('what is my net worth')).toBe('net_worth');
    expect(routeQuestion('how much do I owe the third party')).toBe('third_party_owed');
  });

  it('routes anything else to the honest fallback', () => {
    for (const question of ['Should I buy a flat in another city', 'What is the capital of a country', 'Tell me a joke', '']) {
      expect(routeQuestion(question)).toBe('unsupported');
    }
  });
});

describe('answerDeterministic', () => {
  it('is always labelled deterministic and never claims to be model output', () => {
    for (const question of [...SUPPORTED_QUESTIONS, 'anything else']) {
      expect(answerDeterministic(question, facts()).generatedBy).toBe('deterministic');
    }
  });

  it('answers safe to spend from the computed result only', () => {
    const answer = answerDeterministic('how much is safe to spend', facts());
    expect(answer.topic).toBe('safe_to_spend');
    expect(answer.content).toContain('Safe to spend is 4200 ZAR over 2026-03-10 to 2026-04-09 (30 days, fixed_days)');
    expect(answer.content).toContain('eligible cash of 18000 ZAR less committed obligations of 8800 ZAR and protected reserves of 5000 ZAR');
    expect(answer.content).toContain('lowest projected balance on 2026-03-28');
    expect(answer.content).toContain('It is provisional');
    expect(answer.content).toContain('1 obligation(s) in the horizon have no known amount');
  });

  it('refuses to invent a safe-to-spend figure and lists what is missing', () => {
    const answer = answerDeterministic(
      'how much can i spend',
      facts({ safeToSpend: { ...SAFE_TO_SPEND, status: 'insufficient_data', amount: null, explanation: { ...SAFE_TO_SPEND.explanation, missing: ['No account balance is known'] } } }),
    );
    expect(answer.content).toBe('I cannot give a safe-to-spend figure from the records as they stand. What is missing: No account balance is known.');
    expect(answerDeterministic('how much can i spend', facts({ safeToSpend: null })).content).toContain('The inputs it needs are not there yet.');
  });

  it('answers runway in each of its states', () => {
    expect(answerDeterministic('runway', facts()).content).toBe(
      'Personal runway is 4.2 months, reaching zero around 2026-07-18, from a liquid balance of 51000 ZAR against an average monthly net outflow of 12000 ZAR.',
    );
    expect(answerDeterministic('runway', facts({ runway: { ...RUNWAY, status: 'not_depleting', months: null, depletionDate: null } })).content).toContain('is not depleting on the trailing figures');
    expect(answerDeterministic('runway', facts({ runway: { ...RUNWAY, status: 'insufficient_history', months: null, historyMonths: 2 } })).content).toContain(
      'There are 2 month(s) of history and 3 are needed',
    );
    expect(answerDeterministic('runway', facts({ runway: null })).content).toBe('Runway has not been computed, so I have no figure for it.');
  });

  it('names the biggest spending category and the goal it pulls against', () => {
    const answer = answerDeterministic('what is my biggest spending category', facts());
    expect(answer.content).toContain('Groceries is the largest category in week of 2 March 2026 at 4300 ZAR, up 400 ZAR');
    expect(answer.content).toContain('Emergency reserve is 8000 ZAR short of its target');
    expect(answer.links.length).toBeGreaterThan(0);
    expect(answerDeterministic('biggest category', facts({ spendingByCategory: [] })).content).toContain('No classified spending is recorded');
  });

  it('lists upcoming commitments and flags the ones with no amount', () => {
    const answer = answerDeterministic('what bills are coming up', facts());
    expect(answer.content).toContain('2026-03-13: Example Insurance Ltd premium, 1250 ZAR');
    expect(answer.content).toContain('2026-03-20: Sample Utility account, amount not known');
    expect(answer.content).toContain('1 of them have no known amount, so they are not subtracted from any figure.');
    expect(answerDeterministic('what is due', facts({ upcoming: [] })).content).toContain('Nothing is recorded as coming up.');
  });

  it('answers what needs attention with the same ranking as nextActions', () => {
    const answer = answerDeterministic('what needs attention', facts());
    expect(answer.content.split('\n')).toHaveLength(3);
    expect(answer.content).toContain('1. Everyday account does not balance');
    expect(answerDeterministic('what needs attention', quietFacts()).content).toContain('Nothing in the records needs attention right now');
  });

  it('answers net worth with its segments and its unknowns', () => {
    const answer = answerDeterministic('what is my net worth', facts());
    expect(answer.content).toContain('Net worth for the personal scope is 12000 ZAR and provisional');
    expect(answer.content).toContain('Cash 18000 ZAR, Liabilities -6000 ZAR');
    expect(answer.content).toContain('1 item(s) are unknown or could not be converted');
    expect(answer.content).toContain('3000 ZAR held for third parties is excluded');
    const none = answerDeterministic('net worth', facts({ wealth: { ...WEALTH, status: 'insufficient_data', netWorthKnown: null } }));
    expect(none.content).toContain('There are not enough known values');
  });

  it('answers the third-party balance and says when the fee policy is unconfirmed', () => {
    const answer = answerDeterministic('how much do I owe the third party', facts());
    expect(answer.content).toContain('Third Party A: 14500 ZAR');
    expect(answer.content).toContain('the fee policy is unconfirmed, so no fee is recognised');
    expect(answer.content).toContain('Total owed: 14500 ZAR.');

    const unknown = answerDeterministic('third party balance', facts({ thirdParty: [{ arrangementId: ARRANGEMENT, label: 'Third Party A', feeMode: 'deducted_from_receipt', owed: null }] }));
    expect(unknown.content).toContain('balance not known');
    expect(unknown.content).toContain('A total is not given because at least one balance is unknown.');
    expect(answerDeterministic('third party', facts({ thirdParty: [] })).content).toBe('No third-party arrangement is recorded, so nothing is owed through one.');
  });

  it('says honestly what it can answer when the question is outside its range', () => {
    const answer = answerDeterministic('Should I buy a flat in another city', facts());
    expect(answer.topic).toBe('unsupported');
    expect(answer.content).toContain('I cannot answer that from your records. Here is what I can answer from them:');
    for (const supported of SUPPORTED_QUESTIONS) expect(answer.content).toContain(supported);
    expect(answer.content).toContain('Anything outside that list I would be making up, so I do not.');
    expect(answer.links).toEqual([]);
  });

  it('maps onto the contract coach message', () => {
    const message = toCoachMessage(answerDeterministic('runway', facts()), { id: uid(160), createdAt: '2026-03-10T08:00:00Z' });
    expect(() => CoachMessage.parse(message)).not.toThrow();
    expect(message.generatedBy).toBe('deterministic');
    expect(message.role).toBe('coach');
    expect(message.status).toBe('complete');
  });
});

describe('tone', () => {
  const allText = (): string => {
    const f = facts();
    const review = buildReview('monthly', f);
    const answers = [...SUPPORTED_QUESTIONS, 'something else entirely'].map((q) => answerDeterministic(q, f).content);
    const quiet = buildReview('weekly', quietFacts());
    return [
      ...answers,
      ...[review, quiet].flatMap((r) => [
        ...r.whatChanged.map((s) => `${s.title} ${s.body}`),
        ...r.whyItMatters.map((s) => `${s.title} ${s.body}`),
        `${r.nextAction?.title} ${r.nextAction?.body}`,
        ...r.checklist.map((c) => c.label),
      ]),
      ...nextActions(f, 9).map((a) => `${a.title} ${a.why}`),
    ].join('\n');
  };

  it('never uses an accusing, shaming or flattering word', () => {
    const text = allText().toLowerCase();
    for (const word of FORBIDDEN_WORDS) expect(text).not.toContain(word);
  });

  it('never ends a sentence with an exclamation mark', () => {
    expect(allText()).not.toContain('!');
  });

  it('does not moralise about enjoyable spending', () => {
    const text = allText().toLowerCase();
    for (const phrase of ['you should not', 'cut back', 'treat yourself less', 'wasted', 'splurge']) expect(text).not.toContain(phrase);
  });
});
