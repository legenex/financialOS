/**
 * Per-account valuation. Exactly one source is chosen, in this precedence:
 *   verified complete holdings > provider balance > statement closing > ledger balance > owner-reported total.
 * Sources are never summed.
 *
 * - An owner-reported total (or manual) snapshot whose composition overlaps imported holdings is SUPERSEDED:
 *   it is never used or added, even when the holdings are incomplete (the account is then unknown rather than
 *   double counted).
 * - A provider "available" balance is never a valuation: it can include overdraft or credit limits, and broker
 *   buying power is not value.
 * - Unknown source dates stay unknown: freshness is then `unknown`.
 */
import type { BalanceSnapshot, ConvertedMoney, Explanation, Freshness, MaybeMoney, Money, Provenance, Valuation } from '@financialos/contracts';
import { convert, FxTable } from '../fx';
import { D, dec, money, type Dec } from '../money';
import { ExplanationBuilder, snapshotLink } from './explain';
import type { IsoDate } from '../dates';
import type { IsoDateTime } from './types';

export type ValuationBasis = Valuation['basis'];

export interface HoldingsSourceLine {
  instrumentSymbol: string;
  quantity: string | null;
  value: MaybeMoney;
  approximate?: boolean;
}

export interface HoldingsSource {
  id: string;
  asOf: IsoDateTime | null;
  reportedAt: IsoDateTime | null;
  completeness: 'complete' | 'partial' | 'unknown';
  /** Reconciled against the institution (e.g. a verified statement or API holdings with cash). */
  verified: boolean;
  source: string;
  sourceKind: Provenance['sourceKind'];
  lines: readonly HoldingsSourceLine[];
}

export interface ProviderBalanceSource {
  id: string;
  balance: Money;
  /** `available` balances are recorded but never used as a valuation. */
  kind: 'current' | 'available';
  asOf: IsoDateTime | null;
  reportedAt: IsoDateTime;
  source: string;
  verified: boolean;
}

export interface LedgerBalanceSource {
  balance: Money;
  asOf: IsoDate;
  /** True when coverage is complete up to `asOf`. */
  complete: boolean;
}

export interface ValuationInput {
  accountId: string;
  accountCurrency: string | null;
  holdings?: readonly HoldingsSource[];
  providerBalances?: readonly ProviderBalanceSource[];
  snapshots?: readonly BalanceSnapshot[];
  ledgerBalance?: LedgerBalanceSource | null;
}

export interface ValuationSettings {
  now: IsoDateTime;
  /** From AppSettings.staleAfterHours. */
  staleAfterHours: number;
  /** Defaults to half of staleAfterHours. */
  agingAfterHours?: number;
  reportingCurrency?: string | null;
  fx?: FxTable | null;
  fxMaxStalenessDays?: number;
}

export interface ValuationCandidate {
  basis: ValuationBasis;
  sourceId: string | null;
  value: Money | null;
  asOf: IsoDateTime | null;
  usable: boolean;
  chosen: boolean;
  reason: string;
}

export interface ValuationResult {
  valuation: Valuation;
  freshness: Freshness;
  candidates: ValuationCandidate[];
  supersededSnapshotIds: string[];
  explanation: Explanation;
}

const BASIS_LABEL: Record<ValuationBasis, string> = {
  verified_holdings: 'Verified holdings',
  provider_balance: 'Provider balance',
  statement_closing: 'Statement closing balance',
  ledger_balance: 'Ledger balance',
  owner_reported_total: 'Owner-reported total',
  unknown: 'Unknown',
};

const PRECEDENCE: readonly ValuationBasis[] = ['verified_holdings', 'provider_balance', 'statement_closing', 'ledger_balance', 'owner_reported_total'];

interface Chosen {
  basis: ValuationBasis;
  sourceId: string | null;
  value: Money;
  asOf: IsoDateTime | null;
  freshnessAt: IsoDateTime | null;
  reportedAt: IsoDateTime | null;
  approximate: boolean;
  completeness: Valuation['completeness'];
  provenance: Provenance;
  label: string;
}

function symbolKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function instant(value: IsoDateTime | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function latestFirst<T>(items: readonly T[], at: (t: T) => IsoDateTime | null, id: (t: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ta = instant(at(a)) ?? -Infinity;
    const tb = instant(at(b)) ?? -Infinity;
    if (ta !== tb) return tb - ta;
    const ia = id(a);
    const ib = id(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

function endOfDay(date: IsoDate): IsoDateTime {
  return `${date}T23:59:59Z`;
}

function dateOf(value: IsoDateTime | null, fallback: IsoDateTime): IsoDate {
  return (value ?? fallback).slice(0, 10);
}

/** fresh / aging / stale from the age of `at`; `unknown` when the date is unknown. */
export function freshnessState(at: IsoDateTime | null, settings: Pick<ValuationSettings, 'now' | 'staleAfterHours' | 'agingAfterHours'>): Freshness['state'] {
  const t = instant(at);
  const now = instant(settings.now);
  if (t === null || now === null) return 'unknown';
  const ageHours = (now - t) / 3_600_000;
  const aging = settings.agingAfterHours ?? settings.staleAfterHours / 2;
  if (ageHours <= aging) return 'fresh';
  if (ageHours <= settings.staleAfterHours) return 'aging';
  return 'stale';
}

function holdingsTotal(
  h: HoldingsSource,
  target: string | null,
  settings: ValuationSettings,
): { ok: true; value: Money; approximate: boolean } | { ok: false; reason: string } {
  if (h.lines.length === 0) return { ok: false, reason: 'Holdings snapshot has no lines' };
  const unknown = h.lines.filter((l) => l.value.amount === null || l.value.currency === null);
  if (unknown.length > 0) return { ok: false, reason: `${unknown.length} holding line(s) have no value` };
  const currencies = new Set(h.lines.map((l) => l.value.currency!));
  const currency = currencies.size === 1 ? [...currencies][0]! : target;
  if (!currency) return { ok: false, reason: 'Holdings are in several currencies and no valuation currency is set' };
  const table = settings.fx ?? new FxTable();
  const date = dateOf(h.asOf ?? h.reportedAt, settings.now);
  let total: Dec = new D(0);
  for (const line of h.lines) {
    const value = money(line.value.amount!, line.value.currency!);
    const converted = convert(value, currency, date, table, { method: 'spot_at_valuation', maxStalenessDays: settings.fxMaxStalenessDays ?? 7 });
    if (!converted.converted) return { ok: false, reason: `Cannot convert ${line.instrumentSymbol}: ${converted.unconvertedReason}` };
    total = total.plus(dec(converted.converted.amount));
  }
  return { ok: true, value: money(total, currency), approximate: h.lines.some((l) => l.approximate === true) };
}

/** Chooses one valuation for an account and explains the choice. */
export function selectValuation(input: ValuationInput, settings: ValuationSettings): ValuationResult {
  const candidates: ValuationCandidate[] = [];
  const holdings = input.holdings ?? [];
  const snapshots = input.snapshots ?? [];
  const importedSymbols = new Set(holdings.flatMap((h) => h.lines.map((l) => symbolKey(l.instrumentSymbol))));
  const superseded: string[] = [];
  const target = input.accountCurrency ?? settings.reportingCurrency ?? null;
  let chosen: Chosen | null = null;
  const consider = (candidate: Omit<ValuationCandidate, 'chosen'>, make: () => Chosen | null) => {
    if (candidate.usable && !chosen) {
      chosen = make();
      candidates.push({ ...candidate, chosen: chosen !== null });
    } else {
      candidates.push({ ...candidate, chosen: false, reason: candidate.usable ? `${candidate.reason}; a higher-precedence source was used` : candidate.reason });
    }
  };

  // 1. Verified complete holdings.
  for (const h of latestFirst(holdings, (x) => x.asOf ?? x.reportedAt, (x) => x.id)) {
    const total = holdingsTotal(h, target, settings);
    const qualifies = h.verified && h.completeness === 'complete';
    const reason = !h.verified
      ? 'Holdings are not verified'
      : h.completeness !== 'complete'
        ? `Holdings are ${h.completeness}, not complete`
        : total.ok
          ? 'Verified complete holdings'
          : total.reason;
    consider(
      { basis: 'verified_holdings', sourceId: h.id, value: total.ok ? total.value : null, asOf: h.asOf, usable: qualifies && total.ok, reason },
      () =>
        total.ok
          ? {
              basis: 'verified_holdings',
              sourceId: h.id,
              value: total.value,
              asOf: h.asOf,
              freshnessAt: h.asOf ?? h.reportedAt,
              reportedAt: h.reportedAt,
              approximate: total.approximate,
              completeness: 'complete',
              provenance: { source: h.source, sourceKind: h.sourceKind, reportedAt: h.reportedAt, sourceAsOf: h.asOf, verified: true },
              label: `Holdings from ${h.source}`,
            }
          : null,
    );
  }

  // 2. Provider balance (current only).
  const providerSnapshots = snapshots.filter((s) => s.kind === 'provider_current' && !s.supersededBy);
  const providers = [
    ...(input.providerBalances ?? []).map((p) => ({
      id: p.id,
      kind: p.kind,
      balance: p.balance,
      asOf: p.asOf,
      reportedAt: p.reportedAt as IsoDateTime | null,
      approximate: false,
      completeness: 'complete' as const,
      provenance: { source: p.source, sourceKind: 'provider_api', reportedAt: p.reportedAt, sourceAsOf: p.asOf, verified: p.verified } as Provenance,
    })),
    ...providerSnapshots.map((s) => ({
      id: s.id,
      kind: 'current' as const,
      balance: s.balance,
      asOf: s.sourceAsOf,
      reportedAt: s.reportedAt as IsoDateTime | null,
      approximate: s.approximate,
      completeness: s.completeness,
      provenance: s.provenance,
    })),
  ];
  for (const p of latestFirst(providers, (x) => x.asOf ?? x.reportedAt, (x) => x.id)) {
    if (p.kind === 'available') {
      candidates.push({
        basis: 'provider_balance',
        sourceId: p.id,
        value: p.balance,
        asOf: p.asOf,
        usable: false,
        chosen: false,
        reason: 'Available balance can include overdraft, credit limit or buying power; never used as a valuation',
      });
      continue;
    }
    consider({ basis: 'provider_balance', sourceId: p.id, value: p.balance, asOf: p.asOf, usable: true, reason: 'Current balance from the provider' }, () => ({
      basis: 'provider_balance',
      sourceId: p.id,
      value: p.balance,
      asOf: p.asOf ?? p.reportedAt,
      freshnessAt: p.asOf ?? p.reportedAt,
      reportedAt: p.reportedAt,
      approximate: p.approximate,
      completeness: p.completeness,
      provenance: p.provenance,
      label: 'Provider balance',
    }));
  }
  for (const s of snapshots.filter((x) => x.kind === 'provider_available')) {
    candidates.push({
      basis: 'provider_balance',
      sourceId: s.id,
      value: s.balance,
      asOf: s.sourceAsOf,
      usable: false,
      chosen: false,
      reason: 'Available balance can include overdraft, credit limit or buying power; never used as a valuation',
    });
  }

  // 3. Statement closing.
  const fromSnapshot = (s: BalanceSnapshot, basis: ValuationBasis, label: string): Chosen => ({
    basis,
    sourceId: s.id,
    value: s.balance,
    asOf: s.sourceAsOf,
    freshnessAt: s.sourceAsOf,
    reportedAt: s.reportedAt,
    approximate: s.approximate,
    completeness: s.completeness,
    provenance: s.provenance,
    label,
  });
  for (const s of latestFirst(snapshots.filter((x) => x.kind === 'statement_closing'), (x) => x.sourceAsOf ?? x.reportedAt, (x) => x.id)) {
    if (s.supersededBy) {
      candidates.push({ basis: 'statement_closing', sourceId: s.id, value: s.balance, asOf: s.sourceAsOf, usable: false, chosen: false, reason: `Superseded by ${s.supersededBy}` });
      continue;
    }
    consider({ basis: 'statement_closing', sourceId: s.id, value: s.balance, asOf: s.sourceAsOf, usable: true, reason: 'Statement closing balance' }, () =>
      fromSnapshot(s, 'statement_closing', 'Statement closing balance'),
    );
  }
  for (const s of snapshots.filter((x) => x.kind === 'statement_opening')) {
    candidates.push({ basis: 'statement_closing', sourceId: s.id, value: s.balance, asOf: s.sourceAsOf, usable: false, chosen: false, reason: 'A statement opening balance is not a current valuation' });
  }

  // 4. Ledger balance.
  if (input.ledgerBalance) {
    const l = input.ledgerBalance;
    const at = endOfDay(l.asOf);
    consider({ basis: 'ledger_balance', sourceId: null, value: l.balance, asOf: at, usable: true, reason: 'Balance computed from the ledger' }, () => ({
      basis: 'ledger_balance',
      sourceId: null,
      value: l.balance,
      asOf: at,
      freshnessAt: at,
      reportedAt: null,
      approximate: false,
      completeness: l.complete ? 'complete' : 'partial',
      provenance: { source: 'ledger', sourceKind: 'derived', reportedAt: null, sourceAsOf: at, verified: false },
      label: 'Ledger balance',
    }));
  }

  // 5. Owner-reported totals (and manual / opening snapshots).
  const ownerKinds = new Set<BalanceSnapshot['kind']>(['owner_reported_total', 'manual', 'opening']);
  for (const s of latestFirst(snapshots.filter((x) => ownerKinds.has(x.kind)), (x) => x.sourceAsOf ?? x.reportedAt, (x) => x.id)) {
    const overlap = (s.composition ?? []).filter((c) => importedSymbols.has(symbolKey(c.instrumentSymbol))).map((c) => symbolKey(c.instrumentSymbol));
    if (s.supersededBy) {
      superseded.push(s.id);
      candidates.push({ basis: 'owner_reported_total', sourceId: s.id, value: s.balance, asOf: s.sourceAsOf, usable: false, chosen: false, reason: `Superseded by ${s.supersededBy}` });
      continue;
    }
    if (overlap.length > 0) {
      superseded.push(s.id);
      candidates.push({
        basis: 'owner_reported_total',
        sourceId: s.id,
        value: s.balance,
        asOf: s.sourceAsOf,
        usable: false,
        chosen: false,
        reason: `Superseded by imported holdings (${[...new Set(overlap)].sort().join(', ')}); never added to them`,
      });
      continue;
    }
    consider({ basis: 'owner_reported_total', sourceId: s.id, value: s.balance, asOf: s.sourceAsOf, usable: true, reason: 'Owner-reported total (unverified)' }, () =>
      fromSnapshot(s, 'owner_reported_total', 'Owner-reported total'),
    );
  }

  const pick = chosen as Chosen | null;
  const explain = new ExplanationBuilder(
    pick ? `${BASIS_LABEL[pick.basis]} used for ${input.accountId}` : `No usable valuation for ${input.accountId}`,
    'verified complete holdings > provider balance > statement closing > ledger balance > owner-reported total (one source, never summed)',
  );
  for (const c of candidates) {
    const links = c.sourceId ? [snapshotLink(c.sourceId, BASIS_LABEL[c.basis])] : [];
    if (c.chosen) explain.result(`${BASIS_LABEL[c.basis]} (used)`, c.value, { note: c.reason, links });
    else explain.excluded(BASIS_LABEL[c.basis], c.value, { note: c.reason, links });
  }
  const partial = holdings.filter((h) => !(h.verified && h.completeness === 'complete'));
  if (!pick && partial.length > 0) {
    explain.missing('Imported holdings are incomplete or unverified, so they are not a valuation on their own', true);
  }
  if (!pick) explain.missing('No verified or reported value is available', true);
  if (pick?.basis === 'owner_reported_total') explain.assume('Owner-reported figure; not verified against a statement or provider');

  let valuation: Valuation;
  let freshness: Freshness;
  if (pick) {
    const valuationDate = dateOf(pick.asOf, settings.now);
    let reporting: ConvertedMoney | null = null;
    if (settings.reportingCurrency) {
      reporting = convert(pick.value, settings.reportingCurrency, valuationDate, settings.fx ?? new FxTable(), {
        method: 'spot_at_valuation',
        maxStalenessDays: settings.fxMaxStalenessDays ?? 7,
      });
      if (!reporting.converted) explain.missing(`No rate to convert into ${settings.reportingCurrency}: ${reporting.unconvertedReason}`);
    }
    if (pick.asOf === null) explain.missing('The date this value applies to is unknown');
    valuation = {
      value: { amount: pick.value.amount, currency: pick.value.currency },
      reporting,
      basis: pick.basis,
      asOf: pick.asOf,
      reportedAt: pick.reportedAt,
      approximate: pick.approximate,
      completeness: pick.completeness,
      provenance: pick.provenance,
    };
    freshness = { label: pick.label, lastUpdatedAt: pick.freshnessAt, state: freshnessState(pick.freshnessAt, settings) };
  } else {
    valuation = {
      value: { amount: null, currency: input.accountCurrency },
      reporting: null,
      basis: 'unknown',
      asOf: null,
      reportedAt: null,
      approximate: false,
      completeness: 'unknown',
      provenance: null,
    };
    freshness = { label: 'No valuation', lastUpdatedAt: null, state: candidates.length === 0 ? 'never' : 'unknown' };
  }
  return { valuation, freshness, candidates, supersededSnapshotIds: superseded, explanation: explain.build() };
}

/** Precedence rank of a basis (0 = highest). `unknown` ranks last. */
export function valuationPrecedence(basis: ValuationBasis): number {
  const index = PRECEDENCE.indexOf(basis);
  return index === -1 ? PRECEDENCE.length : index;
}
