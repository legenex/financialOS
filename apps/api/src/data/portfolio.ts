/**
 * Read model for investments: portfolio summary, restrictions, sale schedules and fixed-income
 * interest projections. Every figure comes from @financialos/domain; price × shares is only ever
 * presented through the engine, which labels it indicative rather than proceeds.
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FixedIncomeTerms, InterestProjection, PortfolioSummary, Restriction } from '@financialos/contracts';
import {
  accounts as accountsTable,
  corporateActions,
  counterparties,
  fixedIncomeTerms as fixedIncomeTable,
  instruments as instrumentsTable,
  restrictions as restrictionsTable,
  watchEvents,
  type DbOrTx,
} from '@financialos/db';
import {
  computePortfolio,
  dec,
  planRestrictedSale,
  portfolioSummary,
  projectInterest,
  type FxTable,
  type IsoDate,
  type PortfolioHoldingLine,
  type PortfolioHoldingsSnapshot,
  type PortfolioComputation,
  type PortfolioIncomeEntry,
  type PortfolioInput,
  toDecimalString,
  type SaleScheduleOptions,
} from '@financialos/domain';
import { normalizeDecimal } from './common';
import { loadHoldings, type AccountBundle } from './accounts';
import { loadClassifiedRows } from './transactions';

export type RestrictionRow = typeof restrictionsTable.$inferSelect;

export function restrictionView(row: RestrictionRow): Restriction {
  return {
    id: row.id,
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    kind: row.kind,
    status: row.status,
    terms: row.terms,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    documentId: row.documentId,
    notes: row.notes,
  };
}

export async function listRestrictions(db: DbOrTx, accountId?: string): Promise<Restriction[]> {
  const rows = await db
    .select()
    .from(restrictionsTable)
    .where(accountId ? eq(restrictionsTable.accountId, accountId) : undefined)
    .orderBy(desc(restrictionsTable.createdAt))
    .limit(500);
  return rows.map(restrictionView);
}

const INVESTMENT_CLASSES = new Set(['marketable', 'restricted']);
const INCOME_NATURES = ['dividend', 'interest', 'fee'] as const;

/**
 * Portfolio across every marketable or restricted account. Income is `null` (unknown) when no
 * investment account has any recorded movement, rather than an invented zero.
 */
export interface PortfolioLoadOptions {
  accounts: readonly AccountBundle[];
  currency: string;
  asOf: IsoDate;
  fx: FxTable;
  from: IsoDate;
}

export async function buildPortfolioInput(db: DbOrTx, options: PortfolioLoadOptions): Promise<PortfolioInput> {
  const investmentAccounts = options.accounts.filter((b) => INVESTMENT_CLASSES.has(b.row.liquidityClass));
  const accountIds = investmentAccounts.map((b) => b.row.id);
  const holdings = await loadHoldings(db, accountIds, 1);
  const snapshots: PortfolioHoldingsSnapshot[] = [];
  for (const [accountId, bundles] of holdings) {
    const bundle = bundles[0];
    if (!bundle) continue;
    const lines: PortfolioHoldingLine[] = bundle.lines.map((line) => ({
      instrument: {
        id: line.instrumentId,
        symbol: line.symbol,
        name: line.instrumentName,
        kind: line.instrumentKind,
        currency: line.instrumentCurrency,
      },
      quantity: normalizeDecimal(line.quantity),
      price: line.price !== null && line.priceCurrency !== null ? { amount: normalizeDecimal(line.price), currency: line.priceCurrency } : null,
      priceAsOf: line.priceAsOf ? line.priceAsOf.toISOString() : null,
      value: line.value !== null && line.valueCurrency !== null ? { amount: normalizeDecimal(line.value), currency: line.valueCurrency } : null,
      costBasis: line.costBasis !== null && line.costBasisCurrency !== null ? { amount: normalizeDecimal(line.costBasis), currency: line.costBasisCurrency } : null,
      costBasisComplete: line.costBasisComplete,
      restricted: line.restricted,
    }));
    snapshots.push({
      accountId,
      asOf: (bundle.snapshot.sourceAsOf ?? bundle.snapshot.reportedAt).toISOString().slice(0, 10),
      completeness: bundle.snapshot.completeness,
      lines,
    });
  }

  const restrictionRows = accountIds.length > 0 ? await db.select().from(restrictionsTable).where(inArray(restrictionsTable.accountId, accountIds)) : [];
  const actionRows = await db
    .select({ action: corporateActions, symbol: instrumentsTable.symbol })
    .from(corporateActions)
    .innerJoin(instrumentsTable, eq(corporateActions.instrumentId, instrumentsTable.id))
    .where(inArray(corporateActions.kind, ['split', 'reverse_split']))
    .limit(500);

  const movementRows = accountIds.length > 0 ? await loadClassifiedRows(db, { accountIds, from: options.from, to: options.asOf }, 20_000) : [];
  const income: PortfolioIncomeEntry[] = [];
  for (const row of movementRows) {
    const nature = row.classification?.nature;
    if (!nature || !(INCOME_NATURES as readonly string[]).includes(nature)) continue;
    const currency = row.record.currency ?? row.accountCurrency;
    if (row.record.amount === null || currency === null || !row.record.bookedOn) continue;
    income.push({
      date: row.record.bookedOn,
      kind: nature as PortfolioIncomeEntry['kind'],
      amount: { amount: normalizeDecimal(row.record.amount), currency },
    });
  }

  return {
    currency: options.currency,
    asOf: options.asOf,
    snapshots,
    restrictions: restrictionRows.map((r) => ({ accountId: r.accountId, instrumentId: r.instrumentId, status: r.status })),
    restrictedAccountIds: investmentAccounts.filter((b) => b.row.liquidityClass === 'restricted').map((b) => b.row.id),
    corporateActions: actionRows
      .filter((r) => r.action.ratioFrom !== null && r.action.ratioTo !== null && r.action.effectiveDate !== null && dec(r.action.ratioFrom).greaterThan(0))
      .map((r) => ({
        id: r.action.id,
        symbol: r.symbol,
        kind: r.action.kind === 'reverse_split' ? ('reverse_split' as const) : ('split' as const),
        // New shares per old share, computed with Decimal (never binary floating point).
        ratio: toDecimalString(dec(r.action.ratioTo as string).dividedBy(dec(r.action.ratioFrom as string))),
        effectiveOn: r.action.effectiveDate as string,
      })),
    // No recorded movement at all means the history is unknown, not that income was zero.
    income: movementRows.length === 0 ? null : income,
    performance: null,
    fx: options.fx,
  };
}

/** Contract-shaped summary. */
export async function loadPortfolio(db: DbOrTx, options: PortfolioLoadOptions): Promise<PortfolioSummary> {
  return portfolioSummary(await buildPortfolioInput(db, options));
}

/** Summary plus the positions the paper simulator needs. */
export async function loadPortfolioComputation(db: DbOrTx, options: PortfolioLoadOptions): Promise<PortfolioComputation> {
  return computePortfolio(await buildPortfolioInput(db, options));
}

export async function saleScheduleOptions(db: DbOrTx, accountId: string, asOf: IsoDate, instrumentId: string | null): Promise<SaleScheduleOptions> {
  const rows = await db.select().from(restrictionsTable).where(eq(restrictionsTable.accountId, accountId));
  return {
    asOf,
    restrictions: rows.map(restrictionView),
    instrumentId,
  };
}

export { planRestrictedSale };

// ---------------------------------------------------------------------------------------------
// Fixed income
// ---------------------------------------------------------------------------------------------

export type FixedIncomeRow = typeof fixedIncomeTable.$inferSelect;

export async function fixedIncomeFor(db: DbOrTx, accountId: string): Promise<{ row: FixedIncomeRow; terms: FixedIncomeTerms } | null> {
  const [row] = await db.select().from(fixedIncomeTable).where(eq(fixedIncomeTable.accountId, accountId)).limit(1);
  if (!row) return null;
  let counterpartyName = row.counterpartyName;
  if (!counterpartyName && row.counterpartyId) {
    const [cp] = await db.select({ name: counterparties.name }).from(counterparties).where(eq(counterparties.id, row.counterpartyId)).limit(1);
    counterpartyName = cp?.name ?? null;
  }
  return {
    row,
    terms: {
      accountId: row.accountId,
      principal: row.principal !== null && row.currency !== null ? { amount: normalizeDecimal(row.principal), currency: row.currency } : null,
      statedAnnualRate: normalizeDecimal(row.statedAnnualRate),
      rateBasis: row.rateBasis,
      compounding: row.compounding,
      fees: row.fees,
      withdrawalTerms: row.withdrawalTerms,
      counterparty: counterpartyName,
      startDate: row.startDate,
      maturityDate: row.maturityDate,
      verified: row.verified,
    },
  };
}

export async function interestProjectionFor(
  db: DbOrTx,
  options: { accountId: string; asOf: IsoDate; months: number; balance: { amount: string; currency: string } | null; from: IsoDate },
): Promise<InterestProjection | null> {
  const bundle = await fixedIncomeFor(db, options.accountId);
  if (!bundle) return null;
  const rows = await loadClassifiedRows(db, { accountIds: [options.accountId], from: options.from, to: options.asOf, nature: 'interest' }, 2000);
  const posted = rows
    .filter((r) => r.record.amount !== null && (r.record.currency ?? r.accountCurrency) !== null && r.record.bookedOn)
    .map((r) => ({
      date: r.record.bookedOn as string,
      amount: { amount: normalizeDecimal(r.record.amount as string), currency: (r.record.currency ?? r.accountCurrency) as string },
    }));
  return projectInterest(bundle.terms, {
    asOf: options.asOf,
    months: options.months,
    balance: options.balance,
    posted,
  });
}

// ---------------------------------------------------------------------------------------------
// Watch events
// ---------------------------------------------------------------------------------------------

export type WatchEventRow = typeof watchEvents.$inferSelect;

export async function listWatchEvents(db: DbOrTx): Promise<WatchEventRow[]> {
  return db.select().from(watchEvents).orderBy(asc(watchEvents.expectedDate), desc(watchEvents.createdAt)).limit(200);
}

export { accountsTable, and, asc, desc, eq, inArray, isNull, restrictionsTable, watchEvents };
