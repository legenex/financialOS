/**
 * The deterministic coach. Everything here is computed from the facts passed in and is always labelled
 * `generatedBy: 'deterministic'`: canned text is never presented as model output, and no number is ever
 * invented. When a figure is unknown the answer says so instead of estimating.
 *
 * Three entry points:
 *   nextActions(facts)          the three highest-impact things to do now, ranked
 *   buildReview(kind, facts)    a weekly or monthly review: what changed, why it matters, ONE next action,
 *                               a checklist, and source links on every section
 *   answerDeterministic(q, f)   keyword-routed answers to the questions the records can actually answer
 *
 * Tone: direct, calm, non-shaming. No flattery, no exclamation marks, no moralising about enjoyable
 * purchases. Where spending pulls against a stated goal the coach names the trade-off in plain numbers and
 * leaves the judgement to the owner.
 */
import type {
  Cadence,
  CoachMessage,
  ConnectionStatus,
  ExceptionKind,
  Goal,
  Money,
  NextAction,
  Review,
  RunwayResult,
  SafeToSpendResult,
  SourceLink,
  ThirdPartyFeeMode,
  UpcomingCommitment,
  WealthSummary,
} from '@financialos/contracts';
import { diffDays, type IsoDate } from '../dates';
import { D, dec, type Dec } from '../money';
import { compareStrings, decString, roundedMoney, stableId } from './shared';

/** Never presented as model output. */
export const COACH_GENERATED_BY = 'deterministic';

export interface CoachException {
  id: string;
  kind: ExceptionKind;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'resolved' | 'dismissed' | 'snoozed';
  title: string;
  detail: string;
  href?: string | null;
}

export interface CoachConnection {
  id: string;
  name: string;
  status: ConnectionStatus;
  lastSuccessAt: string | null;
  /** Accounts left with an unknown balance because this connection is not delivering. */
  accountsWithUnknownBalance: number;
}

export interface CoachThirdParty {
  arrangementId: string;
  label: string;
  feeMode: ThirdPartyFeeMode;
  /** Amount owed to the third party, or null when it cannot be computed. */
  owed: Money | null;
}

export interface CoachReconciliationPeriod {
  accountId: string;
  accountName: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  status: 'balanced' | 'discrepancy' | 'incomplete' | 'not_started';
}

export interface CoachReserve {
  goalId: string;
  name: string;
  target: Money;
  fundedVerified: Money;
  protected: boolean;
  heldIn: Goal['heldIn'];
}

export interface CoachCategorySpend {
  categoryId: string;
  name: string;
  /** Spending in the current period, as a positive magnitude. */
  current: Money;
  /** The same category in the previous period, or null when there is no comparable period. */
  previous: Money | null;
  links?: readonly SourceLink[];
}

export interface CoachBudgetLine {
  categoryId: string;
  name: string;
  planned: Money;
  actual: Money | null;
  links?: readonly SourceLink[];
}

export interface CoachReviewState {
  kind: 'weekly' | 'monthly';
  dueOn: IsoDate;
  lastCompletedPeriodEnd: IsoDate | null;
}

export interface CoachNewRecurring {
  id: string;
  name: string;
  amount: Money | null;
  cadence: Cadence;
}

export interface CoachPeriod {
  start: IsoDate;
  end: IsoDate;
  label: string;
}

/** Everything the coach is allowed to use. It never reaches past this object. */
export interface CoachFacts {
  now: string;
  today: IsoDate;
  currency: string;
  period: CoachPeriod;
  previousPeriod: CoachPeriod | null;
  safeToSpend: SafeToSpendResult | null;
  runway: RunwayResult | null;
  wealth: WealthSummary | null;
  upcoming: readonly UpcomingCommitment[];
  exceptions: readonly CoachException[];
  /** Exceptions resolved or dismissed inside the period, for the "what changed" section. */
  exceptionsClosedInPeriod: readonly CoachException[];
  connections: readonly CoachConnection[];
  thirdParty: readonly CoachThirdParty[];
  reconciliation: readonly CoachReconciliationPeriod[];
  reserves: readonly CoachReserve[];
  reviews: readonly CoachReviewState[];
  spendingByCategory: readonly CoachCategorySpend[];
  budgetLines: readonly CoachBudgetLine[];
  cashPosition: { current: Money | null; previous: Money | null };
  newRecurring: readonly CoachNewRecurring[];
}

function fmt(amount: Money): string {
  return `${amount.amount} ${amount.currency}`;
}

function fmtOrUnknown(amount: Money | null, unknown = 'not known'): string {
  return amount === null ? unknown : fmt(amount);
}

function diff(current: Money, previous: Money | null): { delta: Dec; text: string } | null {
  if (previous === null || previous.currency !== current.currency) return null;
  const delta = dec(current.amount).minus(dec(previous.amount));
  if (delta.isZero()) return { delta, text: 'unchanged' };
  const direction = delta.greaterThan(0) ? 'up' : 'down';
  return { delta, text: `${direction} ${decString(delta.abs(), 2)} ${current.currency}` };
}

function ensureLinks(links: readonly SourceLink[], fallback: SourceLink): SourceLink[] {
  return links.length > 0 ? [...links] : [fallback];
}

function periodLink(facts: CoachFacts): SourceLink {
  return { kind: 'setting', id: 'reporting-period', label: `Period ${facts.period.label}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Next actions
// ---------------------------------------------------------------------------------------------------------------

const EXCEPTION_ACTION_KIND: Partial<Record<ExceptionKind, NextAction['kind']>> = {
  unclassified: 'classify',
  fee_policy_unconfirmed: 'confirm_policy',
  reconciliation_discrepancy: 'reconcile',
  reconciliation_question: 'reconcile',
  missing_period: 'reconcile',
  stale_connection: 'connect',
  sync_error: 'connect',
  import_error: 'import',
  ownership_uncertain: 'verify',
};

const SEVERITY_SCORE: Record<CoachException['severity'], number> = { critical: 100, warning: 55, info: 20 };

interface RankedAction {
  action: NextAction;
  score: number;
  /** Fixed source order, used only to break score ties deterministically. */
  order: number;
  links: SourceLink[];
}

function candidateActions(facts: CoachFacts): RankedAction[] {
  const out: RankedAction[] = [];

  // 1. Open exceptions, by severity.
  for (const exception of facts.exceptions.filter((e) => e.status === 'open')) {
    out.push({
      action: {
        id: `exception:${exception.id}`,
        title: exception.title,
        why: exception.detail,
        impact: exception.severity === 'critical' ? 'high' : exception.severity === 'warning' ? 'medium' : 'low',
        href: exception.href ?? `/inbox/${exception.id}`,
        kind: EXCEPTION_ACTION_KIND[exception.kind] ?? 'verify',
      },
      score: SEVERITY_SCORE[exception.severity],
      order: 1,
      links: [{ kind: 'exception', id: exception.id, label: exception.title }],
    });
  }

  // 2. Connections that are not delivering, worst first when balances are unknown because of them.
  for (const connection of facts.connections) {
    const bad = connection.status !== 'connected' && connection.status !== 'syncing' && connection.status !== 'import_only';
    if (!bad) continue;
    const unknown = connection.accountsWithUnknownBalance;
    out.push({
      action: {
        id: `connection:${connection.id}`,
        title: unknown > 0 ? `Reconnect ${connection.name}: ${unknown} balance(s) are unknown` : `Reconnect ${connection.name}`,
        why:
          unknown > 0
            ? `${connection.name} is ${connection.status.replace(/_/g, ' ')}, so ${unknown} account balance(s) are unknown and every figure that uses them is provisional.`
            : `${connection.name} is ${connection.status.replace(/_/g, ' ')}${connection.lastSuccessAt === null ? ' and has never completed a sync.' : `, last successful sync ${connection.lastSuccessAt}.`}`,
        impact: unknown > 0 ? 'high' : 'medium',
        href: `/connections/${connection.id}`,
        kind: connection.status === 'not_configured' ? 'connect' : 'connect',
      },
      score: unknown > 0 ? 90 : 60,
      order: 2,
      links: [{ kind: 'setting', id: connection.id, label: connection.name }],
    });
  }

  // 3. Third-party fee policy that has never been confirmed.
  for (const arrangement of facts.thirdParty.filter((a) => a.feeMode === 'unconfirmed')) {
    out.push({
      action: {
        id: `fee-policy:${arrangement.arrangementId}`,
        title: `Confirm the fee policy for ${arrangement.label}`,
        why: `The fee mode for ${arrangement.label} is unconfirmed, so no fee income is recognised and the balance owed (${fmtOrUnknown(arrangement.owed)}) can move once you confirm it.`,
        impact: 'high',
        href: `/business/third-party/${arrangement.arrangementId}`,
        kind: 'confirm_policy',
      },
      score: 85,
      order: 3,
      links: [{ kind: 'arrangement', id: arrangement.arrangementId, label: arrangement.label }],
    });
  }

  // 4. Periods that are not reconciled.
  for (const period of facts.reconciliation.filter((p) => p.status !== 'balanced')) {
    out.push({
      action: {
        id: `reconcile:${period.accountId}:${period.periodStart}`,
        title: `Reconcile ${period.accountName} for ${period.periodStart} to ${period.periodEnd}`,
        why: `The period ${period.periodStart} to ${period.periodEnd} on ${period.accountName} is ${period.status.replace(/_/g, ' ')}, so the balances that depend on it are not yet proven.`,
        impact: 'medium',
        href: `/money/accounts/${period.accountId}/reconcile`,
        kind: 'reconcile',
      },
      score: 50,
      order: 4,
      links: [{ kind: 'account', id: period.accountId, label: period.accountName }],
    });
  }

  // 5. Protected reserves that are short of their target.
  for (const reserve of facts.reserves.filter((r) => r.protected)) {
    if (reserve.target.currency !== reserve.fundedVerified.currency) continue;
    const shortfall = dec(reserve.target.amount).minus(dec(reserve.fundedVerified.amount));
    if (!shortfall.greaterThan(0)) continue;
    out.push({
      action: {
        id: `reserve:${reserve.goalId}`,
        title: `Fund ${reserve.name}: ${decString(shortfall, 2)} ${reserve.target.currency} short`,
        why: `${reserve.name} is a protected reserve with ${fmt(reserve.fundedVerified)} verified against a ${fmt(reserve.target)} target, so ${decString(shortfall, 2)} ${reserve.target.currency} of cover is missing.`,
        impact: 'medium',
        href: `/plan/goals/${reserve.goalId}`,
        kind: 'fund_goal',
      },
      score: 45,
      order: 5,
      links: [{ kind: 'goal', id: reserve.goalId, label: reserve.name }],
    });
  }

  // 6. A review that is due.
  for (const review of facts.reviews) {
    if (facts.today < review.dueOn) continue;
    if (review.lastCompletedPeriodEnd !== null && review.lastCompletedPeriodEnd >= review.dueOn) continue;
    out.push({
      action: {
        id: `review:${review.kind}:${review.dueOn}`,
        title: review.kind === 'weekly' ? 'Do the weekly review' : 'Do the monthly close',
        why: `The ${review.kind} review became due on ${review.dueOn}, ${diffDays(review.dueOn, facts.today)} day(s) ago.`,
        impact: 'low',
        href: '/coach/review',
        kind: 'review',
      },
      score: 40,
      order: 6,
      links: [{ kind: 'setting', id: `review-${review.kind}`, label: `${review.kind} review` }],
    });
  }

  return out.sort((a, b) => b.score - a.score || a.order - b.order || compareStrings(a.action.id, b.action.id));
}

/** The three highest-impact actions, ranked. Fewer when there is less to do. */
export function nextActions(facts: CoachFacts, limit = 3): NextAction[] {
  return candidateActions(facts)
    .slice(0, limit)
    .map((c) => c.action);
}

// ---------------------------------------------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------------------------------------------

function goalTension(facts: CoachFacts): { text: string; links: SourceLink[] } | null {
  const shortReserve = facts.reserves
    .filter((r) => r.protected && r.target.currency === r.fundedVerified.currency)
    .map((r) => ({ reserve: r, shortfall: dec(r.target.amount).minus(dec(r.fundedVerified.amount)) }))
    .filter((r) => r.shortfall.greaterThan(0))
    .sort((a, b) => b.shortfall.comparedTo(a.shortfall) || compareStrings(a.reserve.goalId, b.reserve.goalId))[0];
  if (!shortReserve) return null;
  const overspend = facts.budgetLines
    .filter((line) => line.actual !== null && line.actual.currency === line.planned.currency)
    .map((line) => ({ line, over: dec(line.actual!.amount).minus(dec(line.planned.amount)) }))
    .filter((l) => l.over.greaterThan(0))
    .sort((a, b) => b.over.comparedTo(a.over) || compareStrings(a.line.categoryId, b.line.categoryId))[0];
  if (!overspend) return null;
  return {
    text:
      `${overspend.line.name} came in ${decString(overspend.over, 2)} ${overspend.line.planned.currency} above plan this period, ` +
      `while ${shortReserve.reserve.name} is ${decString(shortReserve.shortfall, 2)} ${shortReserve.reserve.target.currency} short of its target. ` +
      'Both can be true at once. If the goal still matters, that is the gap to close; if it no longer matters, change the target rather than carrying it.',
    links: [
      { kind: 'goal', id: shortReserve.reserve.goalId, label: shortReserve.reserve.name },
      ...(overspend.line.links ?? []),
    ],
  };
}

function spendingSection(facts: CoachFacts): Review['whatChanged'][number] {
  const rows = [...facts.spendingByCategory].sort((a, b) => dec(b.current.amount).comparedTo(dec(a.current.amount)) || compareStrings(a.name, b.name));
  const links = rows.flatMap((r) => r.links ?? []);
  if (rows.length === 0) {
    return {
      id: 'spending-by-category',
      title: 'Spending by category',
      body: 'No classified spending is recorded for this period, so there is nothing to compare. Classifying the period would make this section usable.',
      links: ensureLinks(links, periodLink(facts)),
    };
  }
  const lines = rows.slice(0, 5).map((row) => {
    const change = diff(row.current, row.previous);
    return `${row.name}: ${fmt(row.current)}${change ? ` (${change.text} on ${facts.previousPeriod?.label ?? 'the previous period'})` : ' (no comparable previous period)'}`;
  });
  return {
    id: 'spending-by-category',
    title: 'Spending by category',
    body: lines.join('\n'),
    links: ensureLinks(links, periodLink(facts)),
  };
}

function cashSection(facts: CoachFacts): Review['whatChanged'][number] {
  const { current, previous } = facts.cashPosition;
  const change = current ? diff(current, previous) : null;
  const links = facts.wealth?.segments.find((s) => s.liquidityClass === 'cash')?.links ?? [];
  const body =
    current === null
      ? 'The cash position is not known for this period, because at least one balance is missing. It is left unknown rather than treated as zero.'
      : `Cash position is ${fmt(current)}${change ? `, ${change.text} on ${facts.previousPeriod?.label ?? 'the previous period'}` : ' (no comparable previous period)'}.`;
  return { id: 'cash-position', title: 'Cash position', body, links: ensureLinks(links, periodLink(facts)) };
}

function recurringSection(facts: CoachFacts): Review['whatChanged'][number] {
  if (facts.newRecurring.length === 0) {
    return {
      id: 'new-recurring',
      title: 'New recurring charges',
      body: 'No new recurring charge was detected in this period.',
      links: [periodLink(facts)],
    };
  }
  const lines = [...facts.newRecurring]
    .sort((a, b) => compareStrings(a.name, b.name))
    .map((item) => `${item.name}: ${fmtOrUnknown(item.amount, 'amount not known yet')}, ${item.cadence}`);
  return {
    id: 'new-recurring',
    title: 'New recurring charges',
    body: `${lines.length} detected and waiting for your confirmation:\n${lines.join('\n')}`,
    links: facts.newRecurring.map((item) => ({ kind: 'recurring' as const, id: item.id, label: item.name })),
  };
}

function exceptionsSection(facts: CoachFacts): Review['whatChanged'][number] {
  const open = facts.exceptions.filter((e) => e.status === 'open');
  const closed = facts.exceptionsClosedInPeriod;
  const links = [...open, ...closed].map((e) => ({ kind: 'exception' as const, id: e.id, label: e.title }));
  return {
    id: 'exceptions',
    title: 'Exceptions opened and closed',
    body: `${closed.length} closed in this period, ${open.length} still open${open.length > 0 ? ` (${open.filter((e) => e.severity === 'critical').length} critical, ${open.filter((e) => e.severity === 'warning').length} warning).` : '.'}`,
    links: ensureLinks(links, periodLink(facts)),
  };
}

function runwaySection(facts: CoachFacts): Review['whyItMatters'][number] {
  const runway = facts.runway;
  const links: SourceLink[] = [{ kind: 'setting', id: 'runway', label: 'Runway settings' }];
  if (!runway) return { id: 'runway', title: 'Runway', body: 'Runway has not been computed for this period.', links };
  const body =
    runway.status === 'finite' && runway.months !== null
      ? `Runway is ${decString(dec(runway.months), 1)} months${runway.depletionDate ? `, reaching zero around ${runway.depletionDate}` : ''}. That is the window any decision this period has to fit inside.`
      : runway.status === 'not_depleting'
        ? 'Cash is not depleting on the trailing figures, so there is no runway number to report. That can change quickly, so it is worth re-checking each period.'
        : runway.status === 'insufficient_history'
          ? `There are ${runway.historyMonths} month(s) of history and ${runway.minimumHistoryMonths} are needed, so no runway figure is given rather than a misleading one.`
          : 'Runway cannot be computed: the inputs it needs are missing.';
  return { id: 'runway', title: 'Runway', body, links };
}

function reserveSection(facts: CoachFacts): Review['whyItMatters'][number] {
  const protectedReserves = facts.reserves.filter((r) => r.protected);
  const links = protectedReserves.map((r) => ({ kind: 'goal' as const, id: r.goalId, label: r.name }));
  if (protectedReserves.length === 0) {
    return { id: 'reserve-coverage', title: 'Reserve coverage', body: 'No protected reserve is defined, so nothing is held back from safe-to-spend.', links: [periodLink(facts)] };
  }
  const lines = [...protectedReserves]
    .sort((a, b) => compareStrings(a.name, b.name))
    .map((r) => {
      if (r.target.currency !== r.fundedVerified.currency) return `${r.name}: target and funded amounts are in different currencies, so cover cannot be stated.`;
      const short = dec(r.target.amount).minus(dec(r.fundedVerified.amount));
      const held = r.heldIn === 'eligible_cash_accounts' ? 'held inside eligible cash' : r.heldIn === 'separate_accounts' ? 'held in separate accounts' : 'not yet funded anywhere';
      return short.greaterThan(0)
        ? `${r.name}: ${fmt(r.fundedVerified)} of ${fmt(r.target)} verified, ${decString(short, 2)} ${r.target.currency} short, ${held}.`
        : `${r.name}: fully covered at ${fmt(r.fundedVerified)}, ${held}.`;
    });
  return { id: 'reserve-coverage', title: 'Reserve coverage', body: lines.join('\n'), links: ensureLinks(links, periodLink(facts)) };
}

function budgetSection(facts: CoachFacts): Review['whyItMatters'][number] {
  const links = facts.budgetLines.flatMap((l) => l.links ?? []);
  if (facts.budgetLines.length === 0) {
    return { id: 'budget-variance', title: 'Budget variance', body: 'No budget lines are set for this period, so there is no variance to report.', links: [periodLink(facts)] };
  }
  const rows = facts.budgetLines
    .map((line) => ({
      line,
      variance: line.actual === null || line.actual.currency !== line.planned.currency ? null : dec(line.actual.amount).minus(dec(line.planned.amount)),
    }))
    .sort((a, b) => (b.variance ?? new D(0)).comparedTo(a.variance ?? new D(0)) || compareStrings(a.line.name, b.line.name));
  const lines = rows.map(({ line, variance }) =>
    variance === null
      ? `${line.name}: planned ${fmt(line.planned)}, actual not known.`
      : `${line.name}: planned ${fmt(line.planned)}, actual ${fmt(line.actual!)}, ${variance.greaterThan(0) ? 'over' : variance.isZero() ? 'on' : 'under'} plan by ${decString(variance.abs(), 2)} ${line.planned.currency}.`,
  );
  const tension = goalTension(facts);
  return {
    id: 'budget-variance',
    title: 'Budget variance',
    body: tension ? `${lines.join('\n')}\n\n${tension.text}` : lines.join('\n'),
    links: ensureLinks([...links, ...(tension?.links ?? [])], periodLink(facts)),
  };
}

function checklist(kind: Review['kind'], facts: CoachFacts): Review['checklist'] {
  const openExceptions = facts.exceptions.filter((e) => e.status === 'open');
  const items: Review['checklist'] = [
    {
      id: 'classify',
      label: 'Classify the transactions waiting in the inbox',
      done: !openExceptions.some((e) => e.kind === 'unclassified'),
      href: '/inbox',
    },
    {
      id: 'connections',
      label: 'Check every connection has synced',
      done: !facts.connections.some((c) => c.status !== 'connected' && c.status !== 'syncing' && c.status !== 'import_only'),
      href: '/connections',
    },
    {
      id: 'reconcile',
      label: 'Reconcile each account period',
      done: facts.reconciliation.length > 0 && facts.reconciliation.every((p) => p.status === 'balanced'),
      href: '/money',
    },
    {
      id: 'reserves',
      label: 'Check protected reserves are funded',
      done: facts.reserves
        .filter((r) => r.protected)
        .every((r) => r.target.currency === r.fundedVerified.currency && !dec(r.target.amount).minus(dec(r.fundedVerified.amount)).greaterThan(0)),
      href: '/plan/goals',
    },
    { id: 'exceptions', label: 'Clear or snooze the open exceptions', done: openExceptions.length === 0, href: '/inbox' },
    { id: 'next-action', label: 'Do the one next action in this review', done: false, href: null },
  ];
  if (kind === 'monthly') {
    items.push({ id: 'close', label: 'Close the month: statements matched and documents attached', done: false, href: '/money' });
  }
  return items;
}

/** A weekly or monthly review. Exactly one next action, and every section carries source links. */
export function buildReview(kind: Review['kind'], facts: CoachFacts): Review {
  const ranked = candidateActions(facts);
  const top = ranked[0];
  const nextAction: Review['nextAction'] = top
    ? { id: top.action.id, title: top.action.title, body: top.action.why, links: ensureLinks(top.links, periodLink(facts)) }
    : {
        id: 'complete-review',
        title: 'Finish this review and record it',
        body: 'Nothing in the records needs attention right now: no open exceptions, every connection is delivering, periods are reconciled and protected reserves are covered. Completing the review keeps the streak of checked periods intact.',
        links: [periodLink(facts)],
      };
  return {
    id: stableId('review', `${kind}:${facts.period.start}:${facts.period.end}`),
    kind,
    periodStart: facts.period.start,
    periodEnd: facts.period.end,
    status: 'draft',
    generatedBy: COACH_GENERATED_BY,
    whatChanged: [spendingSection(facts), cashSection(facts), recurringSection(facts), exceptionsSection(facts)],
    whyItMatters: [runwaySection(facts), reserveSection(facts), budgetSection(facts)],
    nextAction,
    checklist: checklist(kind, facts),
    notes: null,
    startedAt: facts.now,
    completedAt: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic answers
// ---------------------------------------------------------------------------------------------------------------

export type CoachTopic =
  | 'safe_to_spend'
  | 'runway'
  | 'biggest_spending_category'
  | 'upcoming_bills'
  | 'needs_attention'
  | 'net_worth'
  | 'third_party_owed'
  | 'unsupported';

export interface CoachAnswer {
  topic: CoachTopic;
  content: string;
  links: SourceLink[];
  generatedBy: typeof COACH_GENERATED_BY;
}

const ROUTES: ReadonlyArray<{ topic: Exclude<CoachTopic, 'unsupported'>; pattern: RegExp }> = [
  { topic: 'safe_to_spend', pattern: /safe[ -]to[ -]spend|safely spend|can i (afford|spend)|how much can i spend|spendable/ },
  { topic: 'runway', pattern: /runway|how long (will|do|does).*(last|cash)|months of cash|run out of (money|cash)/ },
  { topic: 'third_party_owed', pattern: /third[ -]party|clearing account|owe(d)? (to|them)|balance owed/ },
  { topic: 'net_worth', pattern: /net worth|networth|how much am i worth|total (assets|wealth)|wealth/ },
  { topic: 'biggest_spending_category', pattern: /biggest|largest|most (i )?(spent|spend)|top categor|where (is|does) my money/ },
  { topic: 'upcoming_bills', pattern: /upcoming|coming up|due soon|bills?|commitments?|what.*due/ },
  { topic: 'needs_attention', pattern: /needs? attention|what should i (do|look at)|exceptions?|inbox|next action|to ?do/ },
];

export const SUPPORTED_QUESTIONS = [
  'how much is safe to spend',
  'how long is my runway',
  'what is my biggest spending category',
  'what bills are coming up',
  'what needs attention',
  'what is my net worth',
  'how much is owed to a third party',
] as const;

/** Keyword routing. Deliberately narrow: anything unrecognised routes to the honest fallback. */
export function routeQuestion(question: string): CoachTopic {
  const text = question.toLowerCase().normalize('NFKC');
  for (const route of ROUTES) {
    if (route.pattern.test(text)) return route.topic;
  }
  return 'unsupported';
}

function safeToSpendAnswer(facts: CoachFacts): Omit<CoachAnswer, 'topic' | 'generatedBy'> {
  const result = facts.safeToSpend;
  if (!result || result.status === 'insufficient_data' || result.amount === null) {
    const missing = result?.explanation.missing ?? [];
    return {
      content:
        'I cannot give a safe-to-spend figure from the records as they stand.' +
        (missing.length > 0 ? ` What is missing: ${missing.join('; ')}.` : ' The inputs it needs are not there yet.'),
      links: [{ kind: 'setting', id: 'safe-to-spend', label: 'Safe-to-spend settings' }],
    };
  }
  const lines = [
    `Safe to spend is ${fmt(result.amount)} over ${result.horizon.from} to ${result.horizon.to} (${result.horizon.days} days, ${result.horizon.basis}).`,
    `That is eligible cash of ${fmtOrUnknown(result.eligibleCash)} less committed obligations of ${fmt(result.obligationsInHorizon)} and protected reserves of ${fmt(result.protectedReserves)}, taken at the lowest projected balance${result.lowestProjectedOn ? ` on ${result.lowestProjectedOn}` : ''}.`,
  ];
  if (result.status === 'provisional') lines.push('It is provisional: some inputs are unknown, so treat it as a ceiling rather than a promise.');
  if (result.unknownAmountObligations > 0) lines.push(`${result.unknownAmountObligations} obligation(s) in the horizon have no known amount and are not subtracted.`);
  return { content: lines.join(' '), links: [{ kind: 'setting', id: 'safe-to-spend', label: 'Safe-to-spend settings' }] };
}

function runwayAnswer(facts: CoachFacts): Omit<CoachAnswer, 'topic' | 'generatedBy'> {
  const runway = facts.runway;
  const links: SourceLink[] = [{ kind: 'setting', id: 'runway', label: 'Runway settings' }];
  if (!runway) return { content: 'Runway has not been computed, so I have no figure for it.', links };
  if (runway.status === 'finite' && runway.months !== null) {
    return {
      content:
        `${runway.scope.label} runway is ${decString(dec(runway.months), 1)} months` +
        `${runway.depletionDate ? `, reaching zero around ${runway.depletionDate}` : ''}, from a liquid balance of ${fmtOrUnknown(runway.liquidBalance)} against an average monthly net outflow of ${fmtOrUnknown(runway.averageMonthlyNetOutflow)}.`,
      links,
    };
  }
  if (runway.status === 'not_depleting') {
    return { content: `${runway.scope.label} cash is not depleting on the trailing figures, so there is no runway number to give.`, links };
  }
  if (runway.status === 'insufficient_history') {
    return {
      content: `There are ${runway.historyMonths} month(s) of history and ${runway.minimumHistoryMonths} are needed, so I am not giving a runway figure rather than a misleading one.`,
      links,
    };
  }
  return { content: 'Runway cannot be computed: the balances or flows it needs are missing.', links };
}

function biggestCategoryAnswer(facts: CoachFacts): Omit<CoachAnswer, 'topic' | 'generatedBy'> {
  const rows = [...facts.spendingByCategory].sort((a, b) => dec(b.current.amount).comparedTo(dec(a.current.amount)) || compareStrings(a.name, b.name));
  const top = rows[0];
  if (!top) {
    return { content: 'No classified spending is recorded for this period, so I cannot name a biggest category.', links: [periodLink(facts)] };
  }
  const change = diff(top.current, top.previous);
  const tension = goalTension(facts);
  const content =
    `${top.name} is the largest category in ${facts.period.label} at ${fmt(top.current)}` +
    `${change ? `, ${change.text} on ${facts.previousPeriod?.label ?? 'the previous period'}.` : ' (no comparable previous period).'}` +
    (tension ? ` ${tension.text}` : '');
  return { content, links: ensureLinks([...(top.links ?? []), ...(tension?.links ?? [])], periodLink(facts)) };
}

function upcomingAnswer(facts: CoachFacts): Omit<CoachAnswer, 'topic' | 'generatedBy'> {
  const rows = [...facts.upcoming].sort((a, b) => compareStrings(a.date, b.date) || compareStrings(a.label, b.label));
  if (rows.length === 0) return { content: 'Nothing is recorded as coming up. That only covers what is in the records.', links: [periodLink(facts)] };
  const shown = rows.slice(0, 5);
  const unknown = rows.filter((r) => r.amount === null).length;
  const lines = shown.map((row) => `${row.date}: ${row.label}, ${fmtOrUnknown(row.amount, 'amount not known')}`);
  return {
    content:
      `${rows.length} commitment(s) are recorded${rows.length > shown.length ? `, the next ${shown.length} are` : ''}:\n${lines.join('\n')}` +
      (unknown > 0 ? `\n${unknown} of them have no known amount, so they are not subtracted from any figure.` : ''),
    links: ensureLinks(shown.flatMap((row) => row.links), periodLink(facts)),
  };
}

function attentionAnswer(facts: CoachFacts): Omit<CoachAnswer, 'topic' | 'generatedBy'> {
  const ranked = candidateActions(facts).slice(0, 3);
  if (ranked.length === 0) {
    return { content: 'Nothing in the records needs attention right now: no open exceptions, connections are delivering, periods are reconciled and protected reserves are covered.', links: [periodLink(facts)] };
  }
  const lines = ranked.map((r, i) => `${i + 1}. ${r.action.title} — ${r.action.why}`);
  return { content: lines.join('\n'), links: ranked.flatMap((r) => r.links) };
}

function netWorthAnswer(facts: CoachFacts): Omit<CoachAnswer, 'topic' | 'generatedBy'> {
  const wealth = facts.wealth;
  if (!wealth) return { content: 'Net worth has not been computed, so I have no figure for it.', links: [periodLink(facts)] };
  const links = wealth.segments.flatMap((s) => s.links).slice(0, 20);
  if (wealth.status === 'insufficient_data' || wealth.netWorthKnown === null) {
    return { content: `There are not enough known values to give a net worth for the ${wealth.scope} scope. ${wealth.explanation.summary}`, links: ensureLinks(links, periodLink(facts)) };
  }
  const segments = wealth.segments
    .filter((s) => s.total !== null && !dec(s.total.amount).isZero())
    .map((s) => `${s.label} ${fmt(s.total!)}`)
    .join(', ');
  const unknown = wealth.segments.reduce((n, s) => n + s.accountsUnknown + s.unconvertedCount, 0);
  return {
    content:
      `Net worth for the ${wealth.scope} scope is ${fmt(wealth.netWorthKnown)}${wealth.status === 'provisional' ? ' and provisional' : ''}. Segments: ${segments}.` +
      (unknown > 0 ? ` ${unknown} item(s) are unknown or could not be converted and are not in that total.` : '') +
      (wealth.excludedThirdParty ? ` ${fmt(wealth.excludedThirdParty)} held for third parties is excluded and reported separately.` : ''),
    links: ensureLinks(links, periodLink(facts)),
  };
}

function thirdPartyAnswer(facts: CoachFacts): Omit<CoachAnswer, 'topic' | 'generatedBy'> {
  if (facts.thirdParty.length === 0) return { content: 'No third-party arrangement is recorded, so nothing is owed through one.', links: [periodLink(facts)] };
  const rows = [...facts.thirdParty].sort((a, b) => compareStrings(a.label, b.label));
  const lines = rows.map((row) => {
    const base = `${row.label}: ${fmtOrUnknown(row.owed, 'balance not known')}`;
    return row.feeMode === 'unconfirmed' ? `${base} — the fee policy is unconfirmed, so no fee is recognised and this figure can move once you confirm it.` : `${base} (fee mode ${row.feeMode.replace(/_/g, ' ')}).`;
  });
  const currencies = new Set(rows.filter((r) => r.owed !== null).map((r) => r.owed!.currency));
  let total = '';
  if (currencies.size === 1 && rows.every((r) => r.owed !== null)) {
    const currency = [...currencies][0]!;
    const sum = rows.reduce((acc, r) => acc.plus(dec(r.owed!.amount)), new D(0));
    total = `\nTotal owed: ${fmt(roundedMoney(sum, currency))}.`;
  } else if (rows.some((r) => r.owed === null)) {
    total = '\nA total is not given because at least one balance is unknown.';
  }
  return { content: `${lines.join('\n')}${total}`, links: rows.map((r) => ({ kind: 'arrangement' as const, id: r.arrangementId, label: r.label })) };
}

function unsupportedAnswer(): Omit<CoachAnswer, 'topic' | 'generatedBy'> {
  return {
    content:
      'I cannot answer that from your records. Here is what I can answer from them: ' +
      `${SUPPORTED_QUESTIONS.join('; ')}. ` +
      'Anything outside that list I would be making up, so I do not.',
    links: [],
  };
}

/** Answers a question using only `facts`. Never estimates, never fabricates a number. */
export function answerDeterministic(question: string, facts: CoachFacts): CoachAnswer {
  const topic = routeQuestion(question);
  const body =
    topic === 'safe_to_spend'
      ? safeToSpendAnswer(facts)
      : topic === 'runway'
        ? runwayAnswer(facts)
        : topic === 'biggest_spending_category'
          ? biggestCategoryAnswer(facts)
          : topic === 'upcoming_bills'
            ? upcomingAnswer(facts)
            : topic === 'needs_attention'
              ? attentionAnswer(facts)
              : topic === 'net_worth'
                ? netWorthAnswer(facts)
                : topic === 'third_party_owed'
                  ? thirdPartyAnswer(facts)
                  : unsupportedAnswer();
  return { topic, content: body.content, links: body.links, generatedBy: COACH_GENERATED_BY };
}

/** Wraps a deterministic answer as a coach message. `generatedBy` stays 'deterministic'. */
export function toCoachMessage(answer: CoachAnswer, options: { id: string; createdAt: string }): CoachMessage {
  return {
    id: options.id,
    role: 'coach',
    content: answer.content,
    generatedBy: answer.generatedBy,
    links: answer.links,
    createdAt: options.createdAt,
    status: 'complete',
  };
}
