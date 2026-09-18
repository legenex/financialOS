/**
 * Read model for entities, institutions, accounts, balance snapshots and holdings.
 *
 * Every valuation is chosen by `selectValuation` in @financialos/domain: this module only loads the
 * candidate sources (holdings, provider balances, statement closings, owner-reported totals) and maps
 * rows onto the contract shapes. It never picks a number itself and never sums two sources.
 */
import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type {
  Account,
  BalanceSnapshot,
  Entity,
  HoldingLine,
  Holdings,
  Institution,
  Instrument,
  Provenance,
} from '@financialos/contracts';
import {
  accounts as accountsTable,
  balanceSnapshots,
  entities as entitiesTable,
  exceptions,
  holdingLines,
  holdingsSnapshots,
  institutions as institutionsTable,
  instruments as instrumentsTable,
  type DbOrTx,
} from '@financialos/db';
import {
  selectValuation,
  type AccountInfo,
  type EntityInfo,
  type FxTable,
  type HoldingsSource,
  type PlanningAccount,
  type PlanningEntity,
  type ValuationSettings,
  type WealthAccount,
} from '@financialos/domain';
import { iso, maybeMoneyOf, moneyOf, normalizeDecimal } from './common';

export type EntityRow = typeof entitiesTable.$inferSelect;
export type AccountRow = typeof accountsTable.$inferSelect;
export type SnapshotRow = typeof balanceSnapshots.$inferSelect;

export function entityView(row: EntityRow): Entity {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    jurisdiction: row.jurisdiction,
    baseCurrency: row.baseCurrency,
    ownerControlled: row.ownerControlled,
    primaryOwner: row.primaryOwner,
    legalStatusConfirmed: row.legalStatusConfirmed,
    notes: row.notes,
  };
}

export function entityInfo(row: EntityRow): EntityInfo {
  return { id: row.id, name: row.name, kind: row.kind, ownerControlled: row.ownerControlled, primaryOwner: row.primaryOwner };
}

export function planningEntity(row: EntityRow): PlanningEntity {
  return { id: row.id, name: row.name, kind: row.kind, primaryOwner: row.primaryOwner };
}

export async function listEntityRows(db: DbOrTx): Promise<EntityRow[]> {
  return db.select().from(entitiesTable).where(isNull(entitiesTable.archivedAt)).orderBy(desc(entitiesTable.primaryOwner), entitiesTable.name);
}

export async function primaryOwnerEntity(db: DbOrTx): Promise<EntityRow | null> {
  const [row] = await db.select().from(entitiesTable).where(eq(entitiesTable.primaryOwner, true)).limit(1);
  return row ?? null;
}

export function institutionView(row: typeof institutionsTable.$inferSelect): Institution {
  return { id: row.id, name: row.name, country: row.country, kind: row.kind, providerKey: row.providerKey };
}

export async function listInstitutionRows(db: DbOrTx) {
  return db.select().from(institutionsTable).orderBy(institutionsTable.name);
}

// ---------------------------------------------------------------------------------------------
// Snapshots and holdings
// ---------------------------------------------------------------------------------------------

function provenanceOf(row: { provenance: Record<string, unknown>; source: string; reportedAt: Date; sourceAsOf: Date | null; documentId?: string | null }): Provenance {
  const stored = row.provenance ?? {};
  const kind = stored.sourceKind;
  return {
    source: typeof stored.source === 'string' ? stored.source : row.source,
    sourceKind:
      kind === 'owner_reported' || kind === 'import' || kind === 'provider_api' || kind === 'manual_entry' || kind === 'derived' || kind === 'bootstrap' || kind === 'system'
        ? kind
        : 'owner_reported',
    reportedAt: iso(row.reportedAt),
    sourceAsOf: iso(row.sourceAsOf),
    verified: stored.verified === true,
    documentId: row.documentId ?? null,
    note: typeof stored.note === 'string' ? stored.note : null,
  };
}

export function snapshotView(row: SnapshotRow): BalanceSnapshot {
  return {
    id: row.id,
    accountId: row.accountId,
    kind: row.kind,
    balance: { amount: normalizeDecimal(row.amount), currency: row.currency },
    approximate: row.approximate,
    completeness: row.completeness,
    reportedAt: iso(row.reportedAt),
    sourceAsOf: iso(row.sourceAsOf),
    provenance: provenanceOf(row),
    composition: row.composition
      ? row.composition.map((c) => ({
          instrumentSymbol: String(c.instrumentSymbol ?? ''),
          quantity: typeof c.quantity === 'string' ? normalizeDecimal(c.quantity) : null,
          approximate: c.approximate === true,
        }))
      : null,
    supersededBy: row.supersededBy,
  };
}

export async function listSnapshotRows(db: DbOrTx, accountIds: readonly string[], limitPerAccount = 40): Promise<SnapshotRow[]> {
  if (accountIds.length === 0) return [];
  return db
    .select()
    .from(balanceSnapshots)
    .where(inArray(balanceSnapshots.accountId, [...accountIds]))
    .orderBy(desc(balanceSnapshots.reportedAt))
    .limit(limitPerAccount * accountIds.length);
}

export interface HoldingsBundle {
  snapshot: typeof holdingsSnapshots.$inferSelect;
  lines: Array<typeof holdingLines.$inferSelect & { symbol: string; instrumentName: string; instrumentKind: Instrument['kind']; instrumentCurrency: string | null; instrumentId: string; exchange: string | null; isin: string | null }>;
}

export async function loadHoldings(db: DbOrTx, accountIds: readonly string[], perAccount = 4): Promise<Map<string, HoldingsBundle[]>> {
  const out = new Map<string, HoldingsBundle[]>();
  if (accountIds.length === 0) return out;
  const snapshots = await db
    .select()
    .from(holdingsSnapshots)
    .where(inArray(holdingsSnapshots.accountId, [...accountIds]))
    .orderBy(desc(holdingsSnapshots.reportedAt))
    .limit(perAccount * accountIds.length);
  if (snapshots.length === 0) return out;
  const lines = await db
    .select({
      line: holdingLines,
      instrument: instrumentsTable,
    })
    .from(holdingLines)
    .innerJoin(instrumentsTable, eq(holdingLines.instrumentId, instrumentsTable.id))
    .where(inArray(holdingLines.snapshotId, snapshots.map((s) => s.id)));
  const bySnapshot = new Map<string, HoldingsBundle['lines']>();
  for (const row of lines) {
    const list = bySnapshot.get(row.line.snapshotId) ?? [];
    list.push({
      ...row.line,
      instrumentId: row.instrument.id,
      symbol: row.instrument.symbol,
      instrumentName: row.instrument.name,
      instrumentKind: row.instrument.kind,
      instrumentCurrency: row.instrument.currency,
      exchange: row.instrument.exchange,
      isin: row.instrument.isin,
    });
    bySnapshot.set(row.line.snapshotId, list);
  }
  for (const snapshot of snapshots) {
    const list = out.get(snapshot.accountId) ?? [];
    list.push({ snapshot, lines: bySnapshot.get(snapshot.id) ?? [] });
    out.set(snapshot.accountId, list);
  }
  return out;
}

function holdingsSources(bundles: readonly HoldingsBundle[]): HoldingsSource[] {
  return bundles.map((bundle) => ({
    id: bundle.snapshot.id,
    asOf: iso(bundle.snapshot.sourceAsOf),
    reportedAt: iso(bundle.snapshot.reportedAt),
    completeness: bundle.snapshot.completeness,
    verified: bundle.snapshot.verified,
    source: bundle.snapshot.source,
    sourceKind: bundle.snapshot.connectionId ? 'provider_api' : bundle.snapshot.importBatchId ? 'import' : 'owner_reported',
    lines: bundle.lines.map((line) => ({
      instrumentSymbol: line.symbol,
      quantity: normalizeDecimal(line.quantity),
      value: maybeMoneyOf(line.value, line.valueCurrency),
      approximate: false,
    })),
  }));
}

export function holdingsView(accountId: string, bundle: HoldingsBundle | undefined): Holdings {
  if (!bundle) return { accountId, asOf: null, completeness: 'unknown', source: 'none recorded', lines: [] };
  const lines: HoldingLine[] = bundle.lines.map((line) => {
    const price = moneyOf(line.price, line.priceCurrency);
    const costBasis = moneyOf(line.costBasis, line.costBasisCurrency);
    return {
      instrument: {
        id: line.instrumentId,
        symbol: line.symbol,
        name: line.instrumentName,
        kind: line.instrumentKind,
        currency: line.instrumentCurrency,
        exchange: line.exchange,
        isin: line.isin,
      },
      quantity: normalizeDecimal(line.quantity),
      price,
      priceAsOf: iso(line.priceAsOf),
      priceSource: line.priceSource,
      priceKind: (line.priceKind as HoldingLine['priceKind']) ?? null,
      value: maybeMoneyOf(line.value, line.valueCurrency),
      reporting: null,
      costBasis,
      costBasisComplete: line.costBasisComplete,
      // Unrealised gain needs a complete cost basis and a value; anything less stays unknown.
      unrealisedGain: null,
      restricted: line.restricted,
    };
  });
  return {
    accountId,
    asOf: iso(bundle.snapshot.sourceAsOf ?? bundle.snapshot.reportedAt),
    completeness: bundle.snapshot.completeness,
    source: bundle.snapshot.source,
    lines,
  };
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

export interface AccountBundle {
  row: AccountRow;
  institution: { id: string; name: string; kind: Institution['kind'] } | null;
  legalEntityName: string | null;
  economicOwnerName: string | null;
  account: Account;
}

export interface LoadAccountsOptions {
  accountIds?: readonly string[];
  legalEntityIds?: readonly string[];
  includeClosed?: boolean;
  fx: FxTable;
  now: Date;
  staleAfterHours: number;
  reportingCurrency: string;
}

export async function loadAccountBundles(db: DbOrTx, options: LoadAccountsOptions): Promise<AccountBundle[]> {
  const conditions = [];
  if (options.accountIds) {
    if (options.accountIds.length === 0) return [];
    conditions.push(inArray(accountsTable.id, [...options.accountIds]));
  }
  if (options.legalEntityIds) {
    if (options.legalEntityIds.length === 0) return [];
    conditions.push(inArray(accountsTable.legalEntityId, [...options.legalEntityIds]));
  }
  if (!options.includeClosed) conditions.push(eq(accountsTable.status, 'active'));
  const rows = await db
    .select()
    .from(accountsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(accountsTable.name)
    .limit(2000);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [snapshots, holdings, institutionRows, entityRows, exceptionCounts] = await Promise.all([
    listSnapshotRows(db, ids),
    loadHoldings(db, ids),
    db.select().from(institutionsTable),
    db.select().from(entitiesTable),
    db
      .select({ subjectId: exceptions.subjectId, n: count() })
      .from(exceptions)
      .where(and(eq(exceptions.status, 'open'), eq(exceptions.subjectType, 'account'), inArray(exceptions.subjectId, ids)))
      .groupBy(exceptions.subjectId),
  ]);

  const institutionById = new Map(institutionRows.map((i) => [i.id, i]));
  const entityById = new Map(entityRows.map((e) => [e.id, e]));
  const exceptionsById = new Map(exceptionCounts.map((r) => [r.subjectId ?? '', r.n]));
  const snapshotsByAccount = new Map<string, SnapshotRow[]>();
  for (const s of snapshots) {
    const list = snapshotsByAccount.get(s.accountId) ?? [];
    list.push(s);
    snapshotsByAccount.set(s.accountId, list);
  }

  const settings: ValuationSettings = {
    now: options.now.toISOString(),
    staleAfterHours: options.staleAfterHours,
    reportingCurrency: options.reportingCurrency,
    fx: options.fx,
  };

  return rows.map((row) => {
    const institution = row.institutionId ? institutionById.get(row.institutionId) : undefined;
    const legal = row.legalEntityId ? entityById.get(row.legalEntityId) : undefined;
    const owner = row.economicOwnerEntityId ? entityById.get(row.economicOwnerEntityId) : undefined;
    const result = selectValuation(
      {
        accountId: row.id,
        accountCurrency: row.currency,
        holdings: holdingsSources(holdings.get(row.id) ?? []),
        snapshots: (snapshotsByAccount.get(row.id) ?? []).map(snapshotView),
      },
      settings,
    );
    const account: Account = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      currency: row.currency,
      institution: institution ? { id: institution.id, name: institution.name, kind: institution.kind } : null,
      legalEntityId: row.legalEntityId,
      legalEntityName: legal?.name ?? null,
      economicOwnerEntityId: row.economicOwnerEntityId,
      economicOwnerName: owner?.name ?? null,
      ownershipConfirmed: row.ownershipConfirmed,
      liquidityClass: row.liquidityClass,
      includeInSafeToSpend: row.includeInSafeToSpend,
      status: row.status,
      maskedIdentifier: row.maskedIdentifier,
      connectionId: row.connectionId,
      valuation: result.valuation,
      freshness: result.freshness,
      notes: row.notes,
      openExceptions: exceptionsById.get(row.id) ?? 0,
    };
    return {
      row,
      institution: account.institution,
      legalEntityName: account.legalEntityName,
      economicOwnerName: account.economicOwnerName,
      account,
    };
  });
}

export function accountInfo(row: AccountRow): AccountInfo {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    currency: row.currency,
    legalEntityId: row.legalEntityId,
    economicOwnerEntityId: row.economicOwnerEntityId,
    ownershipConfirmed: row.ownershipConfirmed,
    liquidityClass: row.liquidityClass,
    includeInSafeToSpend: row.includeInSafeToSpend,
    status: row.status,
    maskedIdentifier: row.maskedIdentifier,
  };
}

/** Planning shape: the chosen valuation becomes the balance; unknown stays null. */
export function planningAccount(bundle: AccountBundle): PlanningAccount {
  const value = bundle.account.valuation.value;
  return {
    id: bundle.row.id,
    name: bundle.row.name,
    kind: bundle.row.kind,
    liquidityClass: bundle.row.liquidityClass,
    includeInSafeToSpend: bundle.row.includeInSafeToSpend,
    legalEntityId: bundle.row.legalEntityId,
    economicOwnerEntityId: bundle.row.economicOwnerEntityId,
    status: bundle.row.status,
    balance: value.amount !== null && value.currency !== null ? { amount: value.amount, currency: value.currency } : null,
    balanceAsOf: bundle.account.valuation.asOf ?? bundle.account.valuation.reportedAt,
  };
}

const DEBT_KINDS = new Set(['credit_card', 'loan', 'mortgage']);

/** Wealth shape. Liability accounts are signed negative so net worth is never overstated. */
export function wealthAccount(bundle: AccountBundle): WealthAccount {
  const v = bundle.account.valuation;
  return {
    id: bundle.row.id,
    name: bundle.row.name,
    kind: bundle.row.kind,
    legalEntityId: bundle.row.legalEntityId,
    economicOwnerEntityId: bundle.row.economicOwnerEntityId,
    ownershipConfirmed: bundle.row.ownershipConfirmed,
    liquidityClass: bundle.row.liquidityClass,
    status: bundle.row.status,
    valuation: {
      value: v.value,
      asOf: (v.asOf ?? v.reportedAt)?.slice(0, 10) ?? null,
      approximate: v.approximate,
      completeness: v.completeness,
    },
  };
}

export { DEBT_KINDS, or, sql };
