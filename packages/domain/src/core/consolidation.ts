/**
 * Consolidation of flows across a scope of entities.
 *
 * A flow whose both sides are inside the scope is eliminated (intercompany invoices and payments, salary from
 * an in-scope company to the in-scope owner, personal ↔ business transfers, matched transfers between in-scope
 * accounts). Flows with out-of-scope parties are kept. An entity report is the same computation with a scope
 * of one entity: it eliminates only the entity's own-account transfers and keeps every flow with other entities.
 */
import type { ConsolidatedView, Explanation, Money, SourceLink, TransactionNature } from '@financialos/contracts';
import type { IsoDate } from '../dates';
import { D, dec, money, type Dec } from '../money';
import { ExplanationBuilder, dedupeLinks, transactionLink } from './explain';
import { entryCounts, type JournalEntry, type JournalLineNature, type LedgerChart } from './ledger';
import type { EntityInfo } from './types';

export interface ConsolidationFlow {
  id: string;
  /** Entity whose books contain the flow. */
  entityId: string;
  /** The other party when it is a known entity (null for external or unknown parties). */
  counterpartyEntityId: string | null;
  /** Signed from `entityId`'s perspective: positive = inflow / income, negative = outflow / expense. */
  amount: Money;
  nature: TransactionNature | JournalLineNature;
  date: IsoDate;
  label: string;
  /** Shared by the two sides of one movement (a matched transfer, an intercompany pair, a journal entry). */
  pairId?: string | null;
  categoryId?: string | null;
  links?: readonly SourceLink[];
}

export type EliminationReason = 'salary' | 'intercompany' | 'personal_business_transfer' | 'matched_transfer' | 'internal_transfer' | 'internal_other';

export interface EliminatedFlow {
  flow: ConsolidationFlow;
  reason: EliminationReason;
  counterpartyEntityId: string;
  /** Flows recorded on the other side of the same movement. */
  counterpartFlowIds: string[];
  label: string;
  links: SourceLink[];
}

export interface CurrencyTotals {
  currency: string;
  inflows: Money;
  /** Negative (or zero). */
  outflows: Money;
  net: Money;
}

export interface ConsolidationResult {
  scope: string[];
  kept: ConsolidationFlow[];
  eliminated: EliminatedFlow[];
  totals: CurrencyTotals[];
  byNature: Array<{ nature: string; currency: string; total: Money }>;
  eliminatedByReason: Array<{ reason: EliminationReason; currency: string; inflows: Money; outflows: Money }>;
  /** Intercompany pairs whose two sides do not net to zero (timing or recording differences). */
  warnings: string[];
  explanation: Explanation;
}

const REASON_LABEL: Record<EliminationReason, string> = {
  salary: 'Salary between in-scope entities',
  intercompany: 'Intercompany invoices and payments',
  personal_business_transfer: 'Personal ↔ business transfers',
  matched_transfer: 'Matched transfers between in-scope accounts',
  internal_transfer: "Transfers between an entity's own accounts",
  internal_other: 'Other flows between in-scope entities',
};

function reasonFor(flow: ConsolidationFlow, counterparty: string, entities: ReadonlyMap<string, EntityInfo>): EliminationReason {
  if (flow.nature === 'salary' || flow.nature === 'payroll') return 'salary';
  if (flow.nature === 'intercompany') return 'intercompany';
  if (counterparty === flow.entityId) return 'internal_transfer';
  if (flow.nature === 'owner_contribution' || flow.nature === 'owner_drawing' || flow.nature === 'business_support') return 'personal_business_transfer';
  const own = entities.get(flow.entityId)?.kind;
  const other = entities.get(counterparty)?.kind;
  const personal = (k: string | undefined) => k === 'person';
  const business = (k: string | undefined) => k === 'company' || k === 'trust';
  if ((personal(own) && business(other)) || (business(own) && personal(other))) return 'personal_business_transfer';
  if (flow.pairId || flow.nature === 'transfer_internal' || flow.nature === 'fx_conversion') return 'matched_transfer';
  return 'internal_other';
}

function sortFlows(flows: ConsolidationFlow[]): ConsolidationFlow[] {
  return flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Eliminates flows with both sides inside `scope`; keeps everything else for the scope's entities. */
export function consolidateFlows(flows: readonly ConsolidationFlow[], scope: readonly string[], entityList: readonly EntityInfo[] = []): ConsolidationResult {
  const inScope = new Set(scope);
  const entities = new Map(entityList.map((e) => [e.id, e]));
  const ids = new Set<string>();
  for (const f of flows) {
    if (ids.has(f.id)) throw new Error(`Duplicate flow id ${f.id}`);
    ids.add(f.id);
    dec(f.amount.amount);
  }
  const byPair = new Map<string, ConsolidationFlow[]>();
  for (const f of flows) {
    if (!f.pairId) continue;
    const list = byPair.get(f.pairId) ?? [];
    list.push(f);
    byPair.set(f.pairId, list);
  }

  const relevant = flows.filter((f) => inScope.has(f.entityId));
  const kept: ConsolidationFlow[] = [];
  const eliminated: EliminatedFlow[] = [];

  for (const flow of relevant) {
    const partners = flow.pairId ? (byPair.get(flow.pairId) ?? []).filter((p) => p.id !== flow.id) : [];
    let counterparty = flow.counterpartyEntityId;
    if (!counterparty && partners.length > 0) {
      // Only an offsetting partner (opposite sign) is the other side of the same movement, and only an
      // unambiguous one is used.
      const sign = dec(flow.amount.amount).isNegative();
      const offsetting = partners.filter((p) => dec(p.amount.amount).isNegative() !== sign);
      const partnerEntities = [...new Set(offsetting.map((p) => p.entityId))];
      if (partnerEntities.length === 1) counterparty = partnerEntities[0]!;
    }
    if (!counterparty || !inScope.has(counterparty)) {
      kept.push(flow);
      continue;
    }
    let counterparts = partners.filter((p) => p.entityId === counterparty).map((p) => p.id);
    if (counterparts.length === 0) {
      counterparts = relevant
        .filter(
          (o) =>
            o.id !== flow.id &&
            o.entityId === counterparty &&
            o.counterpartyEntityId === flow.entityId &&
            o.amount.currency === flow.amount.currency &&
            dec(o.amount.amount).equals(dec(flow.amount.amount).negated()),
        )
        .map((o) => o.id);
    }
    const reason = reasonFor(flow, counterparty, entities);
    eliminated.push({
      flow,
      reason,
      counterpartyEntityId: counterparty,
      counterpartFlowIds: counterparts.sort(),
      label: `${REASON_LABEL[reason]}: ${flow.label}`,
      links: dedupeLinks(flow.links && flow.links.length > 0 ? flow.links : [transactionLink(flow.id, flow.label)]),
    });
  }

  sortFlows(kept);
  eliminated.sort((a, b) => (a.flow.date < b.flow.date ? -1 : a.flow.date > b.flow.date ? 1 : a.flow.id < b.flow.id ? -1 : 1));

  // Totals on kept flows.
  const totals = new Map<string, { inflows: Dec; outflows: Dec }>();
  const natures = new Map<string, Dec>();
  for (const f of kept) {
    const amount = dec(f.amount.amount);
    const t = totals.get(f.amount.currency) ?? { inflows: new D(0), outflows: new D(0) };
    if (amount.isNegative()) t.outflows = t.outflows.plus(amount);
    else t.inflows = t.inflows.plus(amount);
    totals.set(f.amount.currency, t);
    const key = `${f.nature}\u0000${f.amount.currency}`;
    natures.set(key, (natures.get(key) ?? new D(0)).plus(amount));
  }

  // Elimination summaries and pair checks.
  const byReason = new Map<string, { inflows: Dec; outflows: Dec }>();
  const pairNet = new Map<string, Dec>();
  for (const e of eliminated) {
    const amount = dec(e.flow.amount.amount);
    const key = `${e.reason}\u0000${e.flow.amount.currency}`;
    const r = byReason.get(key) ?? { inflows: new D(0), outflows: new D(0) };
    if (amount.isNegative()) r.outflows = r.outflows.plus(amount);
    else r.inflows = r.inflows.plus(amount);
    byReason.set(key, r);
    const [a, b] = [e.flow.entityId, e.counterpartyEntityId].sort();
    const pk = `${a}\u0000${b}\u0000${e.flow.amount.currency}`;
    pairNet.set(pk, (pairNet.get(pk) ?? new D(0)).plus(amount));
  }
  const warnings: string[] = [];
  for (const [key, net] of [...pairNet].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (!net.isZero()) {
      const [a, b, currency] = key.split('\u0000');
      warnings.push(`Eliminated flows between ${a} and ${b} do not net to zero in ${currency} (${net.toFixed()}); check timing or missing records`);
    }
  }

  const currencies = [...totals.keys()].sort();
  const explain = new ExplanationBuilder(
    `Combined flows for ${scope.length} entit${scope.length === 1 ? 'y' : 'ies'}; ${eliminated.length} internal flow(s) eliminated`,
    'combined = Σ in-scope flows − flows whose both sides are in scope',
  );
  const eliminatedByReason = [...byReason.entries()]
    .map(([key, r]) => {
      const [reason, currency] = key.split('\u0000') as [EliminationReason, string];
      return { reason, currency, inflows: money(r.inflows, currency), outflows: money(r.outflows, currency) };
    })
    .sort((x, y) => (x.reason < y.reason ? -1 : x.reason > y.reason ? 1 : x.currency < y.currency ? -1 : 1));
  for (const r of eliminatedByReason) {
    explain.excluded(`${REASON_LABEL[r.reason]} (in)`, r.inflows).excluded(`${REASON_LABEL[r.reason]} (out)`, r.outflows);
  }
  for (const currency of currencies) {
    const t = totals.get(currency)!;
    explain.result(`Net ${currency}`, money(t.inflows.plus(t.outflows), currency));
  }
  for (const w of warnings) explain.assume(w);

  return {
    scope: [...scope],
    kept,
    eliminated,
    totals: currencies.map((currency) => {
      const t = totals.get(currency)!;
      return { currency, inflows: money(t.inflows, currency), outflows: money(t.outflows, currency), net: money(t.inflows.plus(t.outflows), currency) };
    }),
    byNature: [...natures.entries()]
      .map(([key, total]) => {
        const [nature, currency] = key.split('\u0000') as [string, string];
        return { nature, currency, total: money(total, currency) };
      })
      .sort((x, y) => (x.nature < y.nature ? -1 : x.nature > y.nature ? 1 : x.currency < y.currency ? -1 : 1)),
    eliminatedByReason,
    warnings,
    explanation: explain.build(),
  };
}

/** Entity report: keeps every flow with other entities; only the entity's own-account transfers are eliminated. */
export function entityFlowReport(flows: readonly ConsolidationFlow[], entityId: string, entities: readonly EntityInfo[] = []): ConsolidationResult {
  return consolidateFlows(flows, [entityId], entities);
}

/** Maps eliminations to the contract `ConsolidatedView.eliminated` shape (one row per eliminated flow). */
export function toConsolidatedEliminations(result: ConsolidationResult): ConsolidatedView['eliminated'] {
  return result.eliminated.map((e) => ({ label: e.label, amount: { ...e.flow.amount }, links: e.links }));
}

export interface FlowExtractionOptions {
  /** `pnl`: income and expense lines (income positive). `cash`: lines on cash-like asset accounts. */
  basis: 'pnl' | 'cash';
  /** Ledger account subtypes treated as cash for the `cash` basis (default cash, bank, card, wallet). */
  cashSubtypes?: readonly string[];
  includePending?: boolean;
  from?: IsoDate;
  to?: IsoDate;
}

/**
 * Turns journal lines into consolidation flows. Opening balances and reversed entries (with their reversals)
 * are skipped: they are not flows. On the cash basis, an entry with several cash lines uses its id as the pair
 * id, so both sides of a transfer or conversion link up. P&L flows rely on the lines' counterparties.
 */
export function flowsFromJournalEntries(entries: readonly JournalEntry[], chart: LedgerChart, options: FlowExtractionOptions): ConsolidationFlow[] {
  const cashSubtypes = new Set(options.cashSubtypes ?? ['cash', 'bank', 'card', 'wallet']);
  const reversed = new Set(entries.filter((e) => e.status === 'reversed').map((e) => e.id));
  const flows: ConsolidationFlow[] = [];
  for (const entry of entries) {
    if (!entryCounts(entry, { includePending: options.includePending ?? false })) continue;
    if (entry.kind === 'opening_balance') continue;
    if (entry.status === 'reversed' || (entry.reversesEntryId && reversed.has(entry.reversesEntryId))) continue;
    if (options.from && entry.effectiveDate < options.from) continue;
    if (options.to && entry.effectiveDate > options.to) continue;
    const accountOf = (ledgerAccountId: string) => {
      const account = chart.get(ledgerAccountId);
      if (!account) throw new Error(`Unknown ledger account ${ledgerAccountId} in entry ${entry.id}`);
      return account;
    };
    const isCash = (ledgerAccountId: string) => {
      const account = accountOf(ledgerAccountId);
      return account.type === 'asset' && account.subtype !== null && cashSubtypes.has(account.subtype);
    };
    const cashLineCount = entry.lines.filter((l) => isCash(l.ledgerAccountId)).length;
    entry.lines.forEach((line, index) => {
      const account = accountOf(line.ledgerAccountId);
      let amount: Dec;
      if (options.basis === 'pnl') {
        if (account.type !== 'income' && account.type !== 'expense') return;
        amount = dec(line.amount).negated();
      } else {
        if (!isCash(line.ledgerAccountId)) return;
        amount = dec(line.amount);
      }
      flows.push({
        id: `${entry.id}#${index}`,
        entityId: line.entityId,
        counterpartyEntityId: line.counterpartyEntityId,
        amount: money(amount, line.currency),
        nature: line.nature,
        date: entry.effectiveDate,
        label: line.memo ?? entry.description,
        pairId: options.basis === 'cash' && cashLineCount > 1 ? entry.id : null,
        categoryId: line.categoryId,
        links: [transactionLink(entry.id, entry.description)],
      });
    });
  }
  return flows;
}
