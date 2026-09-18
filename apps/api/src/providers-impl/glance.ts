/**
 * The extension glance, built from real records.
 *
 * Privacy rules enforced here (the extension route masks again afterwards, so this is the inner of
 * two independent checks):
 * - an amount is included only when its field is listed in `revealedFields`;
 * - nothing transaction-level ever appears: no descriptions, counterparties, accounts or ids;
 * - unknown stays `unknown`. A missing figure is never shown as zero or as "on track".
 *
 * `buildGlance` is pure so the masking rule can be tested without a database.
 */
import { eq, sql } from 'drizzle-orm';
import type { GlanceResponse, Money, ResultStatus, RevealableField } from '@financialos/contracts';
import { exceptions as exceptionsTable } from '@financialos/db';
import { D, dec, sum } from '@financialos/domain';
import type { AppContext } from '../context';
import type { GlanceInput, GlanceProvider } from '../providers';
import { shiftDays } from '../data/common';
import { loadFinanceBase, safeToSpendFor, type FinanceBase } from '../data/finance';
import { budgetPeriod, listBudgetRows, listObligationRows, listRecurringRows, loadBudget, loadGoals } from '../data/planning';
import { loadClassifiedRows, toBudgetTransactions } from '../data/transactions';

export const DUE_WINDOW_DAYS = 7;
export const GLANCE_TTL_MS = 5 * 60_000;

/** Everything the glance is allowed to use. Deliberately small: no transaction ever reaches it. */
export interface GlanceFacts {
  safeToSpend: { amount: Money | null; status: ResultStatus };
  /** Null when no budget exists: the period is then only labelled, never scored. */
  budget: { periodLabel: string; percentOfPlanUsed: number | null; percentOfPeriodElapsed: number; remaining: Money | null } | null;
  goals: Array<{ label: string; percent: number; fundedVerified: Money }>;
  due: { count: number; nextLabel: string | null; total: Money | null };
  freshness: { state: GlanceResponse['freshness']['state']; lastDataAt: string | null };
  openExceptions: number;
}

/** Integer percentage from two decimal strings. Percentages are indicators, never money. */
export function percentOf(part: string, whole: string): number | null {
  const total = dec(whole);
  if (!total.greaterThan(0)) return null;
  const value = dec(part).dividedBy(total).times(100);
  const clamped = value.lessThan(0) ? new D(0) : value.greaterThan(999) ? new D(999) : value;
  return Number.parseInt(clamped.toFixed(0), 10);
}

function moneyOrNull(revealed: readonly RevealableField[], field: RevealableField, amount: Money | null): { amount: string; currency: string } | null {
  if (!revealed.includes(field) || amount === null) return null;
  return { amount: amount.amount, currency: amount.currency };
}

function elapsedPercent(start: string, end: string, today: string): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.max(0, Math.min(100, Math.round(((todayMs - startMs) / (endMs - startMs)) * 100)));
}

function spendingStatusOf(percentUsed: number | null, percentElapsed: number): GlanceResponse['spending']['status'] {
  if (percentUsed === null) return 'unknown';
  if (percentUsed > 100) return 'over';
  return percentUsed > percentElapsed + 10 ? 'watch' : 'on_track';
}

function buildNudge(input: { openExceptions: number; spending: GlanceResponse['spending']['status']; safeToSpendStatus: ResultStatus; dueCount: number }): GlanceResponse['nudge'] {
  if (input.safeToSpendStatus === 'insufficient_data') {
    return { text: 'Some inputs are missing, so there is no spending figure yet. Open FinancialOS to fill them in.', kind: 'reconcile' };
  }
  if (input.openExceptions > 0) return { text: `${input.openExceptions} item${input.openExceptions === 1 ? '' : 's'} in the inbox need a decision.`, kind: 'review' };
  if (input.spending === 'over') return { text: 'Spending is past the plan for this period.', kind: 'review' };
  if (input.dueCount > 0) return { text: `${input.dueCount} commitment${input.dueCount === 1 ? '' : 's'} due in the next week.`, kind: 'review' };
  return { text: 'Nothing needs a decision right now.', kind: 'calm' };
}

/** Pure: the same facts and the same revealed fields always produce the same glance. */
export function buildGlance(facts: GlanceFacts, revealedFields: readonly RevealableField[], now: Date): GlanceResponse {
  const revealed = [...new Set(revealedFields)];
  const spending = spendingStatusOf(facts.budget?.percentOfPlanUsed ?? null, facts.budget?.percentOfPeriodElapsed ?? 0);
  return {
    generatedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + GLANCE_TTL_MS).toISOString(),
    privacy: { masked: revealed.length === 0, revealedFields: revealed },
    spending: {
      status: spending,
      periodLabel: facts.budget?.periodLabel ?? 'This period',
      percentOfPlanUsed: facts.budget?.percentOfPlanUsed ?? null,
      percentOfPeriodElapsed: facts.budget?.percentOfPeriodElapsed ?? 0,
      safeToSpend: moneyOrNull(revealed, 'safe_to_spend', facts.safeToSpend.amount),
      safeToSpendStatus: facts.safeToSpend.status,
      budgetRemaining: moneyOrNull(revealed, 'budget_remaining', facts.budget?.remaining ?? null),
    },
    goals: facts.goals.slice(0, 3).map((goal) => ({
      label: goal.label,
      percent: goal.percent,
      amount: moneyOrNull(revealed, 'goal_amounts', goal.fundedVerified),
    })),
    dueSoon: {
      count: facts.due.count,
      windowDays: DUE_WINDOW_DAYS,
      nextLabel: facts.due.nextLabel,
      total: moneyOrNull(revealed, 'due_amounts', facts.due.total),
    },
    nudge: buildNudge({ openExceptions: facts.openExceptions, spending, safeToSpendStatus: facts.safeToSpend.status, dueCount: facts.due.count }),
    freshness: facts.freshness,
    attention: { openExceptions: facts.openExceptions },
  };
}

export class DbGlanceProvider implements GlanceProvider {
  readonly #ctx: AppContext;

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async loadFacts(): Promise<GlanceFacts> {
    const ctx = this.#ctx;
    const base: FinanceBase = await loadFinanceBase(ctx);
    const safeToSpend = await safeToSpendFor(ctx, base).catch(() => null);

    const budgetRows = base.primaryOwner ? await listBudgetRows(ctx.db, { entityIds: [base.primaryOwner.id] }) : [];
    const budgetRow = budgetRows[0];
    let budget: GlanceFacts['budget'] = null;
    if (budgetRow) {
      const period = budgetPeriod(budgetRow, base.today);
      const accountIds = base.accounts.filter((b) => b.row.economicOwnerEntityId === budgetRow.entityId).map((b) => b.row.id);
      const records = accountIds.length > 0 ? await loadClassifiedRows(ctx.db, { accountIds, from: period.start, to: period.end }, 20_000) : [];
      const loaded = await loadBudget(ctx.db, budgetRow, { asOf: base.today, fx: base.fx, transactions: toBudgetTransactions(records) });
      budget = {
        periodLabel: period.label,
        percentOfPlanUsed: loaded.totals.actual ? percentOf(loaded.totals.actual.amount, loaded.totals.planned.amount) : null,
        percentOfPeriodElapsed: elapsedPercent(period.start, period.end, base.today),
        remaining: loaded.totals.remaining,
      };
    }

    const goals = await loadGoals(ctx.db, { asOf: base.today, fx: base.fx });
    const goalItems = goals
      .filter((goal) => goal.status === 'active')
      .slice(0, 3)
      .map((goal) => ({
        label: goal.name,
        percent: Math.max(0, Math.min(100, Number.parseInt(dec(goal.progress).times(100).toFixed(0), 10))),
        fundedVerified: goal.fundedVerified,
      }));

    const scopeIds = base.entityRows.map((e) => e.id);
    const windowEnd = shiftDays(base.today, DUE_WINDOW_DAYS);
    const [obligations, recurring] = await Promise.all([
      listObligationRows(ctx.db, { entityIds: scopeIds, from: base.today, to: windowEnd, status: 'upcoming' }),
      listRecurringRows(ctx.db, { entityIds: scopeIds, status: 'active' }),
    ]);
    const dueItems: Array<{ date: string; label: string; amount: Money | null }> = [
      ...obligations.map((o) => ({ date: o.dueOn, label: o.label, amount: o.amount !== null && o.currency !== null ? { amount: o.amount, currency: o.currency } : null })),
      ...recurring
        .filter((r) => r.direction === 'out' && r.nextDueOn !== null && r.nextDueOn >= base.today && r.nextDueOn <= windowEnd)
        .map((r) => ({ date: r.nextDueOn as string, label: r.name, amount: r.amount !== null && r.currency !== null ? { amount: r.amount, currency: r.currency } : null })),
    ].sort((a, b) => (a.date < b.date ? -1 : 1));
    const dueCurrency = base.settings.budgetCurrency;
    const sameCurrency = dueItems.filter((item) => item.amount !== null && item.amount.currency === dueCurrency);
    // A total is only offered when every due item has a known amount in the same currency.
    const dueTotal = dueItems.length > 0 && sameCurrency.length === dueItems.length ? sum(sameCurrency.map((item) => item.amount as Money), dueCurrency) : null;

    const states = base.accounts.map((b) => b.account.freshness.state);
    const freshnessState: GlanceResponse['freshness']['state'] = states.includes('stale')
      ? 'stale'
      : states.includes('aging')
        ? 'aging'
        : states.length > 0 && states.every((s) => s === 'fresh')
          ? 'fresh'
          : 'unknown';
    const lastDataAt =
      base.accounts
        .map((b) => b.account.freshness.lastUpdatedAt)
        .filter((value): value is string => typeof value === 'string')
        .sort()
        .at(-1) ?? null;

    const openRows = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(exceptionsTable).where(eq(exceptionsTable.status, 'open'));

    return {
      safeToSpend: { amount: safeToSpend?.amount ?? null, status: safeToSpend?.status ?? 'insufficient_data' },
      budget,
      goals: goalItems,
      due: { count: dueItems.length, nextLabel: dueItems[0]?.label ?? null, total: dueTotal },
      freshness: { state: freshnessState, lastDataAt },
      openExceptions: openRows[0]?.n ?? 0,
    };
  }

  async getGlance(input: GlanceInput): Promise<GlanceResponse> {
    return buildGlance(await this.loadFacts(), input.revealedFields, input.now);
  }
}
