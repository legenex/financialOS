/**
 * Facts for the deterministic coach and the structured review.
 *
 * `CoachFacts` is the only thing the coach may use. Assembling it here keeps the coach itself pure:
 * the wording and the ranking live in @financialos/domain, the records live in PostgreSQL.
 */
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Money, SourceLink } from '@financialos/contracts';
import {
  connections as connectionsTable,
  exceptions as exceptionsTable,
  reconciliations,
  reviews as reviewsTable,
} from '@financialos/db';
import {
  add,
  answerDeterministic,
  buildReview,
  money as makeMoney,
  type CoachBudgetLine,
  type CoachCategorySpend,
  type CoachFacts,
  type CoachPeriod,
  type IsoDate,
} from '@financialos/domain';
import type { AppContext } from '../context';
import { normalizeDecimal, shiftDays } from './common';
import { allRunways, buildToday, safeToSpendFor, wealthFor, type FinanceBase } from './finance';
import { budgetPeriod, listBudgetRows, listRecurringRows, loadBudget, loadGoals } from './planning';
import { loadClassifiedRows, toBudgetTransactions, type TransactionRow } from './transactions';

export { answerDeterministic, buildReview };

function monthPeriod(date: IsoDate): CoachPeriod {
  const [year, month] = date.split('-');
  const start = `${year}-${month}-01`;
  const end = new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);
  return { start, end, label: `${year}-${month}` };
}

function previousMonthPeriod(period: CoachPeriod): CoachPeriod {
  return monthPeriod(shiftDays(period.start, -1));
}

/** Spending per category, summed by the domain's money helpers. Unknown currencies are skipped. */
function spendingByCategory(rows: readonly TransactionRow[], currency: string): CoachCategorySpend[] {
  const totals = new Map<string, { name: string; total: Money; links: SourceLink[] }>();
  for (const row of rows) {
    const rowCurrency = row.record.currency ?? row.accountCurrency;
    if (row.record.amount === null || rowCurrency !== currency) continue;
    const amount = normalizeDecimal(row.record.amount);
    if (!amount.startsWith('-')) continue;
    const nature = row.classification?.nature ?? 'unknown';
    if (nature !== 'consumption' && nature !== 'fee') continue;
    const categoryId = row.classification?.categoryId ?? 'uncategorised';
    const magnitude = makeMoney(amount.slice(1), currency);
    const existing = totals.get(categoryId);
    if (existing) existing.total = add(existing.total, magnitude);
    else totals.set(categoryId, { name: row.categoryName ?? 'Uncategorised', total: magnitude, links: [{ kind: 'transaction', id: row.record.id, label: row.record.description ?? 'Transaction' }] });
  }
  return [...totals.entries()].map(([categoryId, value]) => ({ categoryId, name: value.name, current: value.total, previous: null, links: value.links }));
}

export interface CoachFactsOptions {
  /** Calendar month to report on. Defaults to the month containing today. */
  period?: CoachPeriod;
}

export async function loadCoachFacts(ctx: AppContext, base: FinanceBase, options: CoachFactsOptions = {}): Promise<CoachFacts> {
  const db = ctx.db;
  const currency = base.settings.reportingCurrency;
  const period = options.period ?? monthPeriod(base.today);
  const previousPeriod = previousMonthPeriod(period);

  const [safeToSpend, runways, today] = await Promise.all([
    safeToSpendFor(ctx, base).catch(() => null),
    allRunways(ctx, base),
    buildToday(ctx, base),
  ]);

  const [exceptionRows, closedRows, connectionRows, reconciliationRows, reviewRows] = await Promise.all([
    db.select().from(exceptionsTable).where(eq(exceptionsTable.status, 'open')).orderBy(desc(exceptionsTable.createdAt)).limit(200),
    db
      .select()
      .from(exceptionsTable)
      .where(and(inArray(exceptionsTable.status, ['resolved', 'dismissed']), gte(exceptionsTable.resolvedAt, new Date(`${period.start}T00:00:00Z`)), lte(exceptionsTable.resolvedAt, new Date(`${period.end}T23:59:59Z`))))
      .limit(200),
    db.select().from(connectionsTable).limit(200),
    db.select({ r: reconciliations, accountName: sql<string>`''` }).from(reconciliations).orderBy(desc(reconciliations.periodEnd)).limit(100),
    db.select().from(reviewsTable).orderBy(desc(reviewsTable.periodEnd)).limit(50),
  ]);

  const accountIds = base.accounts.map((b) => b.row.id);
  const periodRows = accountIds.length > 0 ? await loadClassifiedRows(db, { accountIds, from: period.start, to: period.end }, 20_000) : [];

  const goals = await loadGoals(db, { asOf: base.today, fx: base.fx });
  const budgetRows = base.primaryOwner ? await listBudgetRows(db, { entityIds: [base.primaryOwner.id] }) : [];
  const budgetLines: CoachBudgetLine[] = [];
  const firstBudget = budgetRows[0];
  if (firstBudget) {
    const bp = budgetPeriod(firstBudget, base.today);
    const budgetAccounts = base.accounts.filter((b) => b.row.economicOwnerEntityId === firstBudget.entityId).map((b) => b.row.id);
    const records = budgetAccounts.length > 0 ? await loadClassifiedRows(db, { accountIds: budgetAccounts, from: bp.start, to: bp.end }, 20_000) : [];
    const budget = await loadBudget(db, firstBudget, { asOf: base.today, fx: base.fx, transactions: toBudgetTransactions(records) });
    for (const line of budget.lines) budgetLines.push({ categoryId: line.categoryId, name: line.categoryName, planned: line.planned, actual: line.actual });
  }

  const recurringRows = await listRecurringRows(db, {});
  const accountNames = new Map(base.accounts.map((b) => [b.row.id, b.row.name]));
  const wealth = wealthFor(base, { kind: 'personal' });
  const cashSegment = wealth.segments.find((s) => s.liquidityClass === 'cash') ?? null;

  return {
    now: base.now.toISOString(),
    today: base.today,
    currency,
    period,
    previousPeriod,
    safeToSpend,
    runway: runways.find((r) => r.scope.kind === 'personal') ?? null,
    wealth,
    upcoming: today.upcoming,
    exceptions: exceptionRows.map((row) => ({ id: row.id, kind: row.kind, severity: row.severity, status: row.status, title: row.title, detail: row.body, href: null })),
    exceptionsClosedInPeriod: closedRows.map((row) => ({ id: row.id, kind: row.kind, severity: row.severity, status: row.status, title: row.title, detail: row.body, href: null })),
    connections: connectionRows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      lastSuccessAt: row.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
      accountsWithUnknownBalance: base.accounts.filter((b) => b.row.connectionId === row.id && b.account.valuation.value.amount === null).length,
    })),
    thirdParty: base.clearing.map((bundle) => ({
      arrangementId: bundle.row.id,
      label: bundle.summary.thirdPartyName,
      feeMode: bundle.summary.feeMode,
      owed: bundle.summary.amountOwed,
    })),
    reconciliation: reconciliationRows.map(({ r }) => ({
      accountId: r.accountId,
      accountName: accountNames.get(r.accountId) ?? 'Account',
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      status: r.status,
    })),
    reserves: goals
      .filter((g) => g.protected)
      .map((g) => ({ goalId: g.id, name: g.name, target: g.target, fundedVerified: g.fundedVerified, protected: g.protected, heldIn: g.heldIn })),
    reviews: (['weekly', 'monthly'] as const).map((kind) => {
      const completed = reviewRows.filter((r) => r.kind === kind && r.status === 'completed')[0];
      return {
        kind,
        dueOn: base.today,
        lastCompletedPeriodEnd: completed ? completed.periodEnd : null,
      };
    }),
    spendingByCategory: spendingByCategory(periodRows, currency),
    budgetLines,
    cashPosition: { current: cashSegment?.total ?? null, previous: null },
    newRecurring: recurringRows
      .filter((r) => r.detected && r.status === 'suggested')
      .map((r) => ({
        id: r.id,
        name: r.name,
        amount: r.amount !== null && r.currency !== null ? { amount: normalizeDecimal(r.amount), currency: r.currency } : null,
        cadence: r.cadence,
      })),
  };
}
