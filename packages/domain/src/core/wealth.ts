/**
 * Wealth segmentation by liquidity class, for three scopes:
 * - personal: accounts whose economic owner is the primary owner. Company assets are excluded; ownership
 *   interests count only with a verified valuation.
 * - consolidated: the primary owner plus owner-controlled entities. Company assets are included, so the value
 *   of ownership interests in included entities is excluded (never both). Balances between in-scope entities
 *   (receivables/liabilities with an in-scope counterparty) are eliminated.
 * - entity: one entity's accounts.
 *
 * Always: third-party money is excluded and reported separately; credit limits and broker buying power are
 * never counted; unknown values are counted as `accountsUnknown` (never zero); missing FX is counted as
 * `unconvertedCount`; contingent items are shown but not part of net worth; anything unknown makes the result
 * provisional.
 */
import type { AccountKind, ConvertedMoney, LiquidityClass, Money, SourceLink, WealthSegment, WealthSummary } from '@financialos/contracts';
import type { IsoDate } from '../dates';
import { convert, type FxTable } from '../fx';
import { D, dec, money, type Dec } from '../money';
import { accountLink, ExplanationBuilder, sourceLink } from './explain';
import type { AttributableThirdPartyResult } from './thirdParty';
import type { EntityInfo, ValueInput } from './types';

export class WealthError extends Error {
  override name = 'WealthError';
}

export interface WealthAccount {
  id: string;
  name: string;
  kind: AccountKind;
  legalEntityId: string | null;
  economicOwnerEntityId: string | null;
  ownershipConfirmed: boolean;
  liquidityClass: LiquidityClass;
  status: 'active' | 'closed';
  /** Signed from the holder's perspective: assets positive, debts negative. */
  valuation: ValueInput;
  /** For receivable/liability accounts: the other entity, when known (used for consolidated eliminations). */
  counterpartyEntityId?: string | null;
  /** Set when the account represents an equity stake in an entity (e.g. shares in an owner company). */
  representsEntityId?: string | null;
  /** Whether the valuation of an equity-stake account is verified. */
  valuationVerified?: boolean;
  /** Informational only; never counted. */
  creditLimit?: Money | null;
  /** Informational only; never counted. */
  buyingPower?: Money | null;
}

export interface OwnershipInterest {
  id: string;
  label: string;
  holderEntityId: string;
  heldEntityId: string;
  /** Null = unknown. */
  value: Money | null;
  verified: boolean;
}

export type WealthScope = { kind: 'personal' } | { kind: 'consolidated' } | { kind: 'entity'; entityId: string };

export interface WealthInput {
  scope: WealthScope;
  entities: readonly EntityInfo[];
  accounts: readonly WealthAccount[];
  ownershipInterests?: readonly OwnershipInterest[];
  thirdParty?: AttributableThirdPartyResult | null;
  reportingCurrency: string;
  fx: FxTable;
  /** Valuation date; balances convert at the spot rate on this date. */
  asOf: IsoDate;
  fxMaxStalenessDays?: number;
}

export interface WealthDecision {
  subjectKind: 'account' | 'ownership_interest' | 'third_party_clearing';
  subjectId: string;
  label: string;
  included: boolean;
  segment: LiquidityClass | null;
  reason: string;
  value: ConvertedMoney | null;
}

export interface WealthComputation {
  summary: WealthSummary;
  decisions: WealthDecision[];
}

export const SEGMENT_ORDER: readonly LiquidityClass[] = ['cash', 'near_cash', 'marketable', 'restricted', 'illiquid', 'property', 'receivable', 'liability', 'contingent'];

const SEGMENT_LABEL: Record<LiquidityClass, string> = {
  cash: 'Cash',
  near_cash: 'Near cash',
  marketable: 'Marketable investments',
  restricted: 'Restricted assets',
  illiquid: 'Illiquid assets',
  property: 'Property',
  liability: 'Liabilities',
  receivable: 'Receivables',
  contingent: 'Contingent (not in net worth)',
};

const DEBT_KINDS: ReadonlySet<AccountKind> = new Set(['credit_card', 'loan', 'mortgage']);

interface SegmentAccumulator {
  total: Dec;
  known: number;
  unknown: number;
  unconverted: number;
  links: SourceLink[];
}

function scopeEntities(scope: WealthScope, entities: readonly EntityInfo[]): Set<string> {
  if (scope.kind === 'entity') {
    if (!entities.some((e) => e.id === scope.entityId)) throw new WealthError(`Unknown entity ${scope.entityId}`);
    return new Set([scope.entityId]);
  }
  const primaries = entities.filter((e) => e.primaryOwner);
  if (primaries.length !== 1) throw new WealthError(`Expected exactly one primary owner, found ${primaries.length}`);
  const primary = primaries[0]!;
  if (scope.kind === 'personal') return new Set([primary.id]);
  return new Set([primary.id, ...entities.filter((e) => e.ownerControlled && e.kind !== 'third_party').map((e) => e.id)]);
}

/** Wealth summary with the per-item decisions behind it. */
export function computeWealthDetailed(input: WealthInput): WealthComputation {
  const entities = new Map(input.entities.map((e) => [e.id, e]));
  const scope = scopeEntities(input.scope, input.entities);
  const primaryId = input.entities.find((e) => e.primaryOwner)?.id ?? null;
  const currency = input.reportingCurrency;
  const thirdPartyIds = new Set(input.entities.filter((e) => e.kind === 'third_party').map((e) => e.id));
  for (const item of input.thirdParty?.items ?? []) thirdPartyIds.add(item.thirdPartyEntityId);
  const wholeThirdParty = new Set(input.thirdParty?.wholeAccountIds ?? []);

  const segments = new Map<LiquidityClass, SegmentAccumulator>(SEGMENT_ORDER.map((c) => [c, { total: new D(0), known: 0, unknown: 0, unconverted: 0, links: [] }]));
  const decisions: WealthDecision[] = [];
  const explain = new ExplanationBuilder('', 'net worth = Σ segment totals (contingent excluded); third-party money excluded');
  let thirdPartyTotal: Dec = new D(0);
  let thirdPartyKnown = 0;
  let thirdPartyUnknown = 0;
  const included = new Set<string>();
  const knownValue = new Set<string>();

  const toReporting = (value: Money): ConvertedMoney =>
    convert(value, currency, input.asOf, input.fx, { method: 'spot_at_valuation', maxStalenessDays: input.fxMaxStalenessDays ?? 7 });

  const addToSegment = (segment: LiquidityClass, value: Money | null, link: SourceLink, label: string): ConvertedMoney | null => {
    const acc = segments.get(segment)!;
    acc.links.push(link);
    if (!value) {
      acc.unknown += 1;
      explain.missing(`${label}: value unknown`, true, { links: [link] });
      return null;
    }
    const converted = toReporting(value);
    if (!converted.converted) {
      acc.unconverted += 1;
      explain.missing(`${label}: ${converted.unconvertedReason}`, true, { links: [link] });
      return converted;
    }
    acc.total = acc.total.plus(dec(converted.converted.amount));
    acc.known += 1;
    return converted;
  };

  const reportThirdParty = (value: Money | null, label: string, link: SourceLink, note: string): ConvertedMoney | null => {
    if (!value) {
      thirdPartyUnknown += 1;
      explain.missing(`${label}: third-party amount unknown`, true, { links: [link] });
      return null;
    }
    const converted = toReporting(value);
    if (converted.converted) {
      thirdPartyTotal = thirdPartyTotal.plus(dec(converted.converted.amount));
      thirdPartyKnown += 1;
    } else {
      thirdPartyUnknown += 1;
      explain.missing(`${label}: ${converted.unconvertedReason}`);
    }
    explain.excluded(label, value, { note, links: [link], fx: converted.fx });
    return converted;
  };

  // Accounts.
  for (const account of [...input.accounts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const link = accountLink(account.id, account.name);
    const value = account.valuation.value.amount !== null && account.valuation.value.currency !== null
      ? money(account.valuation.value.amount, account.valuation.value.currency)
      : null;
    const decide = (inc: boolean, segment: LiquidityClass | null, reason: string, converted: ConvertedMoney | null) =>
      decisions.push({ subjectKind: 'account', subjectId: account.id, label: account.name, included: inc, segment, reason, value: converted });
    if (account.creditLimit) explain.excluded(`${account.name}: credit limit`, account.creditLimit, { note: 'A credit limit is not cash and never counted', links: [link] });
    if (account.buyingPower) explain.excluded(`${account.name}: buying power`, account.buyingPower, { note: 'Broker buying power is not cash and never counted', links: [link] });

    if (account.status === 'closed') {
      decide(false, null, 'Account is closed', null);
      continue;
    }
    const owner = account.economicOwnerEntityId;
    const legalInScope = account.legalEntityId !== null && scope.has(account.legalEntityId);
    if ((owner && thirdPartyIds.has(owner)) || wholeThirdParty.has(account.id)) {
      // Report it when an in-scope entity (or an unconfirmed holder) holds the money.
      if (legalInScope || account.legalEntityId === null) {
        const converted = reportThirdParty(value, account.name, link, 'Economically owned by a third party');
        decide(false, null, 'Belongs to a third party; reported separately', converted);
      } else {
        decide(false, null, 'Belongs to a third party and is not held by an entity in scope', null);
      }
      continue;
    }
    if (!owner) {
      if (legalInScope || account.legalEntityId === null) {
        explain.missing(`${account.name}: economic owner unknown, not counted`, true, { links: [link] });
      }
      decide(false, null, 'Economic owner unknown', null);
      continue;
    }
    if (!scope.has(owner)) {
      decide(false, null, input.scope.kind === 'personal' ? 'Not owned by the primary owner (company assets are never personal)' : 'Owner outside scope', null);
      continue;
    }
    const legalKind = account.legalEntityId ? entities.get(account.legalEntityId)?.kind : undefined;
    if (input.scope.kind === 'personal' && (legalKind === 'company' || legalKind === 'trust') && !account.ownershipConfirmed) {
      explain.missing(`${account.name}: held by a company; personal ownership is unconfirmed, so it is not counted`, true, { links: [link] });
      decide(false, null, 'Company-held account without confirmed personal ownership', null);
      continue;
    }
    if (input.scope.kind === 'consolidated' && (account.liquidityClass === 'receivable' || account.liquidityClass === 'liability') && account.counterpartyEntityId && scope.has(account.counterpartyEntityId)) {
      explain.excluded(`${account.name}: balance with an in-scope entity`, value, { note: 'Eliminated in the consolidated view', links: [link] });
      decide(false, null, 'Intercompany balance eliminated in the consolidated view', null);
      continue;
    }
    if (account.representsEntityId) {
      if (input.scope.kind === 'consolidated' && scope.has(account.representsEntityId)) {
        explain.excluded(`${account.name}: stake in an included entity`, value, { note: "The entity's own assets are already included", links: [link] });
        decide(false, null, 'Ownership value of an included entity (never counted with its assets)', null);
        continue;
      }
      if (!account.valuationVerified) {
        const segment: LiquidityClass = account.liquidityClass;
        segments.get(segment)!.unknown += 1;
        segments.get(segment)!.links.push(link);
        explain.missing(`${account.name}: ownership value is not verified, so it is not counted`, true, { links: [link] });
        decide(false, segment, 'Ownership value unverified', null);
        continue;
      }
    }
    let segment = account.liquidityClass;
    if (DEBT_KINDS.has(account.kind) && segment !== 'liability' && segment !== 'contingent') {
      explain.assume(`${account.name} is a ${account.kind.replace('_', ' ')}; counted as a liability, never as ${segment}`);
      segment = 'liability';
    }
    const converted = addToSegment(segment, value, link, account.name);
    included.add(account.id);
    if (converted?.converted) knownValue.add(account.id);
    if (account.valuation.approximate) explain.assume(`${account.name}: value is approximate`);
    if (value && account.valuation.completeness !== 'complete') explain.missing(`${account.name}: valuation is ${account.valuation.completeness}`);
    decide(true, segment, value ? 'Included' : 'Included with unknown value', converted);
  }

  // Clearing balances inside in-scope accounts.
  for (const item of input.thirdParty?.items ?? []) {
    if (item.basis !== 'clearing_liability') continue;
    const inScope = item.accountId ? included.has(item.accountId) : item.holderEntityId !== null && scope.has(item.holderEntityId);
    const id = item.arrangementId ?? item.accountId ?? 'clearing';
    const link = item.links[0] ?? sourceLink('arrangement', id, 'Third-party clearing');
    if (!inScope) {
      decisions.push({ subjectKind: 'third_party_clearing', subjectId: id, label: link.label, included: false, segment: null, reason: 'Held outside this scope', value: null });
      continue;
    }
    const segment: LiquidityClass = item.accountId
      ? (decisions.find((d) => d.subjectKind === 'account' && d.subjectId === item.accountId)?.segment ?? 'cash')
      : 'cash';
    const converted = reportThirdParty(item.amount, `Held for a third party (${link.label})`, link, item.note);
    const holdingKnown = item.accountId ? knownValue.has(item.accountId) : segments.get(segment)!.known > 0;
    if (item.amount === null || !converted?.converted) {
      segments.get(segment)!.unknown += 1;
    } else if (!holdingKnown) {
      explain.missing(`${link.label}: the holding balance is unknown, so the third-party share cannot be deducted`, true, { links: [link] });
    } else {
      segments.get(segment)!.total = segments.get(segment)!.total.minus(dec(converted.converted.amount));
    }
    decisions.push({
      subjectKind: 'third_party_clearing',
      subjectId: id,
      label: link.label,
      included: true,
      segment,
      reason: 'Deducted from the holding segment: money owed to a third party',
      value: converted,
    });
  }

  // Ownership interests.
  for (const interest of [...(input.ownershipInterests ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const link = sourceLink('account', interest.id, interest.label);
    const decide = (inc: boolean, segment: LiquidityClass | null, reason: string, value: ConvertedMoney | null) =>
      decisions.push({ subjectKind: 'ownership_interest', subjectId: interest.id, label: interest.label, included: inc, segment, reason, value });
    if (!scope.has(interest.holderEntityId)) {
      decide(false, null, 'Holder outside scope', null);
      continue;
    }
    if (input.scope.kind === 'consolidated' && scope.has(interest.heldEntityId)) {
      explain.excluded(`${interest.label}: stake in an included entity`, interest.value, { note: "The entity's own assets are already included" });
      decide(false, null, 'Ownership value of an included entity (never counted with its assets)', null);
      continue;
    }
    if (!interest.verified || !interest.value) {
      segments.get('illiquid')!.unknown += 1;
      segments.get('illiquid')!.links.push(link);
      explain.missing(`${interest.label}: no verified valuation, not counted`, true);
      decide(false, 'illiquid', 'No verified valuation', null);
      continue;
    }
    const converted = addToSegment('illiquid', interest.value, link, interest.label);
    decide(true, 'illiquid', 'Verified ownership value', converted);
  }

  // Assemble.
  const summarySegments: WealthSegment[] = SEGMENT_ORDER.map((liquidityClass) => {
    const acc = segments.get(liquidityClass)!;
    const total = acc.known === 0 && acc.unknown + acc.unconverted > 0 && acc.total.isZero() ? null : money(acc.total, currency);
    return {
      liquidityClass,
      label: SEGMENT_LABEL[liquidityClass],
      total,
      accountsCounted: acc.known,
      accountsUnknown: acc.unknown,
      unconvertedCount: acc.unconverted,
      links: acc.links,
    };
  });
  const knownItems = SEGMENT_ORDER.filter((c) => c !== 'contingent').reduce((n, c) => n + segments.get(c)!.known, 0);
  const netWorth = SEGMENT_ORDER.filter((c) => c !== 'contingent').reduce((acc, c) => acc.plus(segments.get(c)!.total), new D(0));
  const anyUnknown =
    summarySegments.some((s) => s.accountsUnknown > 0 || s.unconvertedCount > 0) || thirdPartyUnknown > 0 || explain.missingCount > 0;
  const status: WealthSummary['status'] = knownItems === 0 ? 'insufficient_data' : anyUnknown ? 'provisional' : 'ok';
  const netWorthKnown = knownItems === 0 ? null : money(netWorth, currency);
  const excludedThirdParty = thirdPartyKnown === 0 && thirdPartyUnknown > 0 ? null : money(thirdPartyTotal, currency);

  if (segments.get('contingent')!.known + segments.get('contingent')!.unknown > 0) explain.assume('Contingent items are shown separately and are not part of net worth');
  for (const s of summarySegments) {
    if (s.accountsCounted + s.accountsUnknown + s.unconvertedCount === 0) continue;
    explain.result(s.label, s.total, {
      note: `${s.accountsCounted} counted, ${s.accountsUnknown} unknown, ${s.unconvertedCount} unconverted`,
      links: s.links,
    });
  }
  explain.result(status === 'ok' ? 'Net worth' : 'Net worth (known items only, provisional)', netWorthKnown);
  const scopeLabel = input.scope.kind === 'entity' ? `entity ${input.scope.entityId}` : `${input.scope.kind} scope`;
  explain.setSummary(
    status === 'insufficient_data'
      ? `Not enough known values for the ${scopeLabel}`
      : status === 'provisional'
        ? `Provisional net worth for the ${scopeLabel}: some values are unknown or unconverted`
        : `Net worth for the ${scopeLabel}`,
  );
  if (input.scope.kind === 'personal' && primaryId) explain.assume('Personal scope: only accounts whose economic owner is the primary owner');

  return {
    summary: {
      scope: input.scope.kind,
      entityIds: [...scope].sort(),
      currency,
      segments: summarySegments,
      netWorthKnown,
      status,
      excludedThirdParty,
      explanation: explain.build(),
    },
    decisions,
  };
}

export function computeWealth(input: WealthInput): WealthSummary {
  return computeWealthDetailed(input).summary;
}
