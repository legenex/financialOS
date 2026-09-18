/**
 * Explainable transfer matching between an outflow on one account and an inflow on another.
 *
 * Score (integer points, not money):
 * - amounts: same currency exact 50; within the fee tolerance 35 (fee reported); cross currency with the implied
 *   rate within tolerance of the reference rate 35–45 (deviation reported); cross currency without a reference
 *   rate 10 (confidence capped at low);
 * - dates: same day 20, 1 day 15, 2–3 days 10, otherwise within the window 5;
 * - description hints (transfer wording, or the other account's name or masked number) up to 15;
 * - relationship: same economic owner 15, same owner group 10.
 * Confidence: high ≥ 80, medium ≥ 60, low ≥ 40; lower scores are not suggested.
 *
 * Assignment is one-to-one, best score first. Nothing is confirmed below the auto-confirm threshold, or when a
 * competing candidate scores within the ambiguity margin. Rejected pairs are never suggested again.
 */
import type { Confidence, Money } from '@financialos/contracts';
import { diffDays } from '../dates';
import { impliedRate, rateDeviation, type FxTable } from '../fx';
import { D, dec, money, toDecimalString, type Dec } from '../money';
import { confidenceRank, normaliseText } from './classification';
import type { AccountInfo, EntityInfo, TransactionLike } from './types';

export interface TransferPair {
  outflowId: string;
  inflowId: string;
}

export interface TransferMatchState {
  confirmed: readonly TransferPair[];
  rejected: readonly TransferPair[];
}

export const EMPTY_TRANSFER_STATE: TransferMatchState = Object.freeze({ confirmed: Object.freeze([]), rejected: Object.freeze([]) });

export interface TransferMatchOptions {
  /** ± days between outflow and inflow (default 5). */
  windowDays?: number;
  /** Max fee as a fraction of the outflow for same-currency pairs (default "0.02"). */
  feeTolerancePercent?: string;
  /** Absolute fee allowance per currency, used when larger than the percentage allowance. */
  feeToleranceAbsolute?: Readonly<Record<string, string>>;
  /** Max relative deviation of an implied FX rate from the reference (default "0.03"). */
  fxTolerance?: string;
  fx?: FxTable | null;
  /** Staleness limit for reference rates (default 7 days). */
  fxMaxStalenessDays?: number;
  /** Minimum confidence to auto-confirm (default `high`). Set `autoConfirm` to enable. */
  autoConfirmThreshold?: 'high' | 'medium';
  autoConfirm?: boolean;
  /** Points by which the best candidate must beat any competitor before auto-confirming (default 5). */
  ambiguityMargin?: number;
  /** Include pending transactions (default false). */
  includePending?: boolean;
}

export interface TransferMatchSuggestion extends TransferPair {
  outflowAccountId: string;
  inflowAccountId: string;
  score: number;
  confidence: Confidence;
  status: 'suggested' | 'confirmed';
  sameCurrency: boolean;
  dayGap: number;
  /** Same currency: outflow magnitude − inflow (null when equal amounts are matched exactly). */
  fee: Money | null;
  impliedRate: string | null;
  referenceRate: string | null;
  rateDeviation: string | null;
  explanation: string[];
}

export interface TransferMatchResult {
  suggestions: TransferMatchSuggestion[];
  /** Pairs skipped because the owner rejected them before. */
  skippedRejected: number;
}

const HINT_WORDS = ['transfer', 'trf', 'xfer', 'tfr', 'own account', 'internal', 'sweep', 'top up', 'topup', 'fx', 'exchange', 'conversion', 'converted', 'move money', 'to savings', 'from savings'];
// Built once from the fixed list above (never from user input).
const HINT_PATTERNS = HINT_WORDS.map((word) => ({
  word,
  pattern: new RegExp(`(?:^|[^\\p{L}\\p{N}])${word.replace(/ /g, '[-\\s]?')}(?:$|[^\\p{L}\\p{N}])`, 'u'),
}));

function pairKey(p: TransferPair): string {
  return `${p.outflowId}\u0000${p.inflowId}`;
}

function ownerGroup(entityId: string | null, entities: ReadonlyMap<string, EntityInfo>): string | null {
  if (!entityId) return null;
  const entity = entities.get(entityId);
  if (!entity) return null;
  if (entity.ownerGroupId) return entity.ownerGroupId;
  if (entity.primaryOwner || entity.ownerControlled) return 'owner';
  return `entity:${entity.id}`;
}

function scoreConfidence(score: number): Confidence {
  if (score >= 80) return 'high';
  if (score >= 60) return 'medium';
  if (score >= 40) return 'low';
  return 'none';
}

function containsHint(text: string, account: AccountInfo): string | null {
  const normal = normaliseText(text);
  const name = normaliseText(account.name);
  if (name.length >= 3 && normal.includes(name)) return `mentions account "${account.name}"`;
  const digits = account.maskedIdentifier?.replace(/\D/g, '') ?? '';
  if (digits.length >= 4 && normal.includes(digits.slice(-4))) return `mentions account ending ${digits.slice(-4)}`;
  return null;
}

interface Scored {
  suggestion: TransferMatchSuggestion;
}

function scorePair(
  out: TransactionLike,
  inn: TransactionLike,
  accounts: ReadonlyMap<string, AccountInfo>,
  entities: ReadonlyMap<string, EntityInfo>,
  options: TransferMatchOptions,
): Scored | null {
  const windowDays = options.windowDays ?? 5;
  const dayGap = diffDays(out.bookedOn, inn.bookedOn);
  if (Math.abs(dayGap) > windowDays) return null;
  const outAccount = accounts.get(out.accountId);
  const inAccount = accounts.get(inn.accountId);
  if (!outAccount || !inAccount) return null;

  const explanation: string[] = [];
  let score = 0;
  let capAtLow = false;
  const outMag = dec(out.amount.amount).abs();
  const inMag = dec(inn.amount.amount);
  const sameCurrency = out.amount.currency === inn.amount.currency;
  let fee: Money | null = null;
  let implied: string | null = null;
  let reference: string | null = null;
  let deviation: string | null = null;

  if (sameCurrency) {
    const currency = out.amount.currency;
    if (outMag.equals(inMag)) {
      score += 50;
      explanation.push(`Equal amounts (${toDecimalString(outMag)} ${currency})`);
    } else {
      const diff = outMag.minus(inMag);
      if (diff.isNegative()) return null;
      const pctAllowance = outMag.times(dec(options.feeTolerancePercent ?? '0.02'));
      const absAllowance = options.feeToleranceAbsolute?.[currency] ? dec(options.feeToleranceAbsolute[currency]) : new D(0);
      const allowance: Dec = D.max(pctAllowance, absAllowance);
      if (diff.greaterThan(allowance)) return null;
      fee = money(diff, currency);
      score += 35;
      explanation.push(`Inflow is ${toDecimalString(diff)} ${currency} less than the outflow; treated as a fee within tolerance (${toDecimalString(allowance)})`);
    }
  } else {
    const rate = impliedRate(out.amount, inn.amount);
    implied = toDecimalString(rate.toDecimalPlaces(10));
    const resolved = options.fx?.resolve(out.amount.currency, inn.amount.currency, out.bookedOn, { maxStalenessDays: options.fxMaxStalenessDays ?? 7 }) ?? null;
    if (resolved) {
      const dev = rateDeviation(rate, resolved.rate);
      reference = toDecimalString(resolved.rate.toDecimalPlaces(10));
      deviation = toDecimalString(dev.toDecimalPlaces(6));
      const tolerance = dec(options.fxTolerance ?? '0.03');
      if (dev.greaterThan(tolerance)) return null;
      const points = dev.lessThanOrEqualTo('0.005') ? 45 : dev.lessThanOrEqualTo('0.015') ? 40 : 35;
      score += points;
      explanation.push(
        `Implied rate ${implied} ${out.amount.currency}/${inn.amount.currency} is ${toDecimalString(dev.times(100).toDecimalPlaces(3))}% from the reference ${reference} (${resolved.source}, ${resolved.asOf})`,
      );
    } else {
      score += 10;
      capAtLow = true;
      explanation.push(`No reference ${out.amount.currency}/${inn.amount.currency} rate available; implied rate ${implied} could not be verified`);
    }
  }

  const absGap = Math.abs(dayGap);
  const datePoints = absGap === 0 ? 20 : absGap === 1 ? 15 : absGap <= 3 ? 10 : 5;
  score += datePoints;
  explanation.push(absGap === 0 ? 'Same day' : `${absGap} day(s) apart`);

  const text = `${out.description} ${out.counterparty ?? ''} | ${inn.description} ${inn.counterparty ?? ''}`;
  const normal = normaliseText(text);
  let hintPoints = 0;
  const word = HINT_PATTERNS.find((h) => h.pattern.test(normal))?.word;
  if (word) {
    hintPoints += 10;
    explanation.push(`Description suggests a transfer ("${word}")`);
  }
  const mention =
    containsHint(`${out.description} ${out.counterparty ?? ''}`, inAccount) ?? containsHint(`${inn.description} ${inn.counterparty ?? ''}`, outAccount);
  if (mention) {
    hintPoints += 10;
    explanation.push(`Description ${mention}`);
  }
  score += Math.min(hintPoints, 15);

  const outOwner = outAccount.economicOwnerEntityId;
  const inOwner = inAccount.economicOwnerEntityId;
  if (outOwner && inOwner && outOwner === inOwner) {
    score += 15;
    explanation.push('Both accounts have the same economic owner');
  } else {
    const g1 = ownerGroup(outOwner ?? outAccount.legalEntityId, entities);
    const g2 = ownerGroup(inOwner ?? inAccount.legalEntityId, entities);
    if (g1 && g1 === g2) {
      score += 10;
      explanation.push('Both accounts belong to the same owner group');
    } else {
      explanation.push('Accounts belong to unrelated or unknown owners');
    }
  }

  let confidence = scoreConfidence(score);
  if (capAtLow && confidenceRank(confidence) > confidenceRank('low')) {
    confidence = 'low';
    explanation.push('Confidence capped at low because the exchange rate could not be verified');
  }
  if (confidence === 'none') return null;
  return {
    suggestion: {
      outflowId: out.id,
      inflowId: inn.id,
      outflowAccountId: out.accountId,
      inflowAccountId: inn.accountId,
      score,
      confidence,
      status: 'suggested',
      sameCurrency,
      dayGap,
      fee,
      impliedRate: implied,
      referenceRate: reference,
      rateDeviation: deviation,
      explanation,
    },
  };
}

/**
 * Suggests one-to-one transfer matches. Transactions already in a confirmed pair and rejected pairs are
 * skipped. Only `autoConfirm` with a candidate at or above the threshold and clear of competitors is confirmed.
 */
export function matchTransfers(
  transactions: readonly TransactionLike[],
  accountList: readonly AccountInfo[],
  entityList: readonly EntityInfo[],
  state: TransferMatchState = EMPTY_TRANSFER_STATE,
  options: TransferMatchOptions = {},
): TransferMatchResult {
  const accounts = new Map(accountList.map((a) => [a.id, a]));
  const entities = new Map(entityList.map((e) => [e.id, e]));
  const rejected = new Set(state.rejected.map(pairKey));
  const taken = new Set<string>();
  for (const p of state.confirmed) {
    taken.add(p.outflowId);
    taken.add(p.inflowId);
  }
  const eligible = transactions.filter(
    (t) =>
      !taken.has(t.id) &&
      (t.status === undefined || t.status === 'posted' || (t.status === 'pending' && options.includePending)) &&
      !dec(t.amount.amount).isZero(),
  );
  const outflows = eligible.filter((t) => dec(t.amount.amount).isNegative()).sort((a, b) => (a.id < b.id ? -1 : 1));
  const inflows = eligible.filter((t) => dec(t.amount.amount).isPositive()).sort((a, b) => (a.id < b.id ? -1 : 1));

  let skippedRejected = 0;
  const candidates: TransferMatchSuggestion[] = [];
  for (const out of outflows) {
    for (const inn of inflows) {
      if (out.accountId === inn.accountId) continue;
      const scored = scorePair(out, inn, accounts, entities, options);
      if (!scored) continue;
      if (rejected.has(pairKey(scored.suggestion))) {
        skippedRejected += 1;
        continue;
      }
      candidates.push(scored.suggestion);
    }
  }
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Math.abs(a.dayGap) - Math.abs(b.dayGap) ||
      (a.outflowId < b.outflowId ? -1 : a.outflowId > b.outflowId ? 1 : 0) ||
      (a.inflowId < b.inflowId ? -1 : a.inflowId > b.inflowId ? 1 : 0),
  );

  const margin = options.ambiguityMargin ?? 5;
  const threshold = options.autoConfirmThreshold ?? 'high';
  const used = new Set<string>();
  const suggestions: TransferMatchSuggestion[] = [];
  for (const candidate of candidates) {
    if (used.has(candidate.outflowId) || used.has(candidate.inflowId)) continue;
    used.add(candidate.outflowId);
    used.add(candidate.inflowId);
    const competitor = candidates.find(
      (c) => c !== candidate && (c.outflowId === candidate.outflowId || c.inflowId === candidate.inflowId) && candidate.score - c.score < margin,
    );
    const explanation = [...candidate.explanation];
    let status: TransferMatchSuggestion['status'] = 'suggested';
    if (competitor) {
      explanation.push(`Ambiguous: another candidate (${competitor.outflowId} → ${competitor.inflowId}) scores ${competitor.score}`);
    }
    if (options.autoConfirm) {
      if (confidenceRank(candidate.confidence) < confidenceRank(threshold)) {
        explanation.push(`Not auto-confirmed: confidence ${candidate.confidence} is below ${threshold}`);
      } else if (competitor) {
        explanation.push('Not auto-confirmed: a competing candidate is too close');
      } else {
        status = 'confirmed';
        explanation.push(`Auto-confirmed at ${candidate.confidence} confidence (score ${candidate.score})`);
      }
    }
    suggestions.push({ ...candidate, status, explanation });
  }
  return { suggestions, skippedRejected };
}

/** Records a rejection. Returns a new state; the pair is never suggested again. */
export function rejectTransferMatch(state: TransferMatchState, pair: TransferPair): TransferMatchState {
  const key = pairKey(pair);
  return {
    confirmed: state.confirmed.filter((p) => pairKey(p) !== key).map((p) => ({ ...p })),
    rejected: state.rejected.some((p) => pairKey(p) === key)
      ? state.rejected.map((p) => ({ ...p }))
      : [...state.rejected.map((p) => ({ ...p })), { outflowId: pair.outflowId, inflowId: pair.inflowId }],
  };
}

/** Records a confirmation by the owner. Returns a new state; a previously rejected identical pair is un-rejected. */
export function confirmTransferMatch(state: TransferMatchState, pair: TransferPair): TransferMatchState {
  const key = pairKey(pair);
  const clash = state.confirmed.find((p) => pairKey(p) !== key && (p.outflowId === pair.outflowId || p.inflowId === pair.inflowId));
  if (clash) throw new Error(`Transaction already confirmed in another transfer pair (${clash.outflowId} → ${clash.inflowId})`);
  return {
    confirmed: state.confirmed.some((p) => pairKey(p) === key)
      ? state.confirmed.map((p) => ({ ...p }))
      : [...state.confirmed.map((p) => ({ ...p })), { outflowId: pair.outflowId, inflowId: pair.inflowId }],
    rejected: state.rejected.filter((p) => pairKey(p) !== key).map((p) => ({ ...p })),
  };
}
