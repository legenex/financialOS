/**
 * Source-record identity and import planning.
 *
 * Dedupe key
 * - With a provider transaction id: derived from (account, provider id).
 * - Otherwise: a stable fingerprint of (account, booked date, amount, currency, normalised description) plus an
 *   OCCURRENCE INDEX among identical tuples in the same file. Two genuine identical purchases on one day get
 *   occurrences 0 and 1, so they stay two records, and re-importing the same (or an overlapping) statement
 *   matches them one-to-one.
 *
 * `planImport` classifies each incoming row as new | duplicate | possible_duplicate | pending_to_posted |
 * changed_upstream, with an explanation for every decision. Every existing record is matched at most once.
 * Persist the `dedupeKey` from the plan: it is computed across the whole file, and recomputing it over a subset
 * of rows would restart the occurrence count.
 *
 * The fingerprint is a non-cryptographic 128-bit hash used for identity only (never for security).
 */
import type { Money } from '@financialos/contracts';
import { diffDays, isValidIsoDate, type IsoDate } from '../dates';
import { D, dec, toDecimalString } from '../money';
import { normaliseText } from './classification';

export type ImportDecision = 'new' | 'duplicate' | 'possible_duplicate' | 'pending_to_posted' | 'changed_upstream';

export interface IncomingSourceRow {
  /** 1-based position in the file (or API page order). */
  rowNumber: number;
  accountId: string;
  bookedOn: IsoDate;
  /** Signed amount. */
  amount: Money;
  description: string;
  providerTransactionId?: string | null;
  pending?: boolean;
  counterparty?: string | null;
  valueOn?: IsoDate | null;
}

export interface ExistingSourceRecord {
  id: string;
  accountId: string;
  bookedOn: IsoDate;
  amount: Money;
  description: string;
  providerTransactionId: string | null;
  pending: boolean;
  /** Records of a reversed import or superseded by a newer version are ignored. */
  state?: 'active' | 'superseded' | 'reversed';
  dedupeKey: string;
  contentHash: string;
}

export interface RowIdentity {
  rowNumber: number;
  /** Provider key when a provider id is present, otherwise the tuple key. */
  dedupeKey: string;
  /** Always computed, including for rows with a provider id. */
  tupleKey: string;
  contentHash: string;
  /** 0-based index among identical tuples in this file. */
  occurrence: number;
}

export interface PlannedImportRow extends RowIdentity {
  status: ImportDecision;
  /** The existing record this row duplicates, posts, or updates. */
  matchedRecordId: string | null;
  /** An earlier row of the same file this row repeats (same provider id). */
  duplicateOfRow: number | null;
  /** Description token similarity with the matched record, as a decimal string in [0, 1]. */
  similarity: string | null;
  dayGap: number | null;
  explanation: string[];
}

export interface ImportPlan {
  rows: PlannedImportRow[];
  counts: { total: number; new: number; duplicate: number; possibleDuplicate: number; pendingToPosted: number; changedUpstream: number };
}

export interface PlanImportOptions {
  /** Max days from a pending record to its posted version (default 7). */
  pendingWindowDays?: number;
  /** Min description similarity for pending→posted (default "0.5"). */
  similarityThreshold?: string;
  /** Date tolerance when matching API and file records that lack a common provider id (default 2). */
  crossSourceWindowDays?: number;
}

export class DedupeError extends Error {
  override name = 'DedupeError';
}

// ---------------------------------------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------------------------------------

function mix64(input: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Stable, platform-independent 128-bit hex fingerprint of a string. Not cryptographic. */
export function stableHash(input: string): string {
  return mix64(input, 0x9e3779b9) + mix64(input, 0x85ebca6b);
}

/** Normalised amount text, so "5.00" and "5" fingerprint identically. */
function amountText(amount: Money): string {
  return toDecimalString(dec(amount.amount));
}

export function normaliseDescription(value: string): string {
  return normaliseText(value);
}

function checkRow(row: IncomingSourceRow): void {
  if (!row.accountId) throw new DedupeError(`Row ${row.rowNumber}: account is required`);
  if (!isValidIsoDate(row.bookedOn)) throw new DedupeError(`Row ${row.rowNumber}: invalid booked date`);
  dec(row.amount.amount);
}

export function providerDedupeKey(accountId: string, providerTransactionId: string): string {
  return `p1:${stableHash(JSON.stringify(['provider', accountId, providerTransactionId.trim()]))}`;
}

function tupleBase(row: Pick<IncomingSourceRow, 'accountId' | 'bookedOn' | 'amount' | 'description'>): string {
  return JSON.stringify([row.accountId, row.bookedOn, amountText(row.amount), row.amount.currency, normaliseDescription(row.description)]);
}

export function tupleDedupeKey(row: Pick<IncomingSourceRow, 'accountId' | 'bookedOn' | 'amount' | 'description'>, occurrence: number): string {
  if (!Number.isInteger(occurrence) || occurrence < 0) throw new DedupeError('Occurrence must be a non-negative integer');
  return `t1:${stableHash(`${tupleBase(row)}#${occurrence}`)}`;
}

/** Hash of the fields whose change means the provider revised a record. */
export function sourceContentHash(row: Pick<IncomingSourceRow, 'bookedOn' | 'amount' | 'description' | 'pending' | 'counterparty' | 'valueOn'>): string {
  return `c1:${stableHash(
    JSON.stringify([
      row.bookedOn,
      amountText(row.amount),
      row.amount.currency,
      normaliseDescription(row.description),
      Boolean(row.pending),
      row.counterparty ? normaliseText(row.counterparty) : null,
      row.valueOn ?? null,
    ]),
  )}`;
}

/** Computes dedupe keys, tuple keys, occurrence indexes and content hashes for one file, in row order. */
export function computeRowIdentities(rows: readonly IncomingSourceRow[]): RowIdentity[] {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    checkRow(row);
    const base = tupleBase(row);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const tupleKey = tupleDedupeKey(row, occurrence);
    const providerId = row.providerTransactionId?.trim() || null;
    return {
      rowNumber: row.rowNumber,
      dedupeKey: providerId ? providerDedupeKey(row.accountId, providerId) : tupleKey,
      tupleKey,
      contentHash: sourceContentHash(row),
      occurrence,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------------------------------------

/** Description tokens: normalised words of 2+ characters, excluding pure numbers (references, dates). */
export function descriptionTokens(value: string): Set<string> {
  return new Set(
    normaliseDescription(value)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2 && !/^\d+$/.test(t)),
  );
}

/** Jaccard similarity of description tokens, as a decimal string rounded to 4 places. */
export function tokenSimilarity(a: string, b: string): string {
  const ta = descriptionTokens(a);
  const tb = descriptionTokens(b);
  if (ta.size === 0 && tb.size === 0) return normaliseDescription(a) === normaliseDescription(b) ? '1' : '0';
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const union = ta.size + tb.size - shared;
  return toDecimalString(new D(shared).dividedBy(union).toDecimalPlaces(4));
}

// ---------------------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------------------

function amountIndexKey(accountId: string, amount: Money): string {
  return JSON.stringify([accountId, amount.currency, amountText(amount)]);
}

function sameMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && dec(a.amount).equals(dec(b.amount));
}

function describeDifferences(existing: ExistingSourceRecord, row: IncomingSourceRow): string {
  const diffs: string[] = [];
  if (existing.bookedOn !== row.bookedOn) diffs.push(`date ${existing.bookedOn} → ${row.bookedOn}`);
  if (!sameMoney(existing.amount, row.amount)) {
    diffs.push(`amount ${existing.amount.amount} ${existing.amount.currency} → ${row.amount.amount} ${row.amount.currency}`);
  }
  if (normaliseDescription(existing.description) !== normaliseDescription(row.description)) diffs.push('description changed');
  if (existing.pending !== Boolean(row.pending)) diffs.push(existing.pending ? 'pending → posted' : 'posted → pending');
  return diffs.length > 0 ? diffs.join(', ') : 'other details changed';
}

interface FuzzyCandidate {
  rowIndex: number;
  existing: ExistingSourceRecord;
  kind: 'pending_to_posted' | 'possible_duplicate';
  dayGap: number;
  similarity: string;
}

/**
 * Plans an import against existing source records. Phases:
 * 1. exact identity: repeated provider id in the file, same provider id (duplicate / pending→posted /
 *    changed upstream), same tuple key with occurrence (duplicate);
 * 2. exact cross-source: provider id on one side only, same date, amount and description (duplicate);
 * 3. fuzzy, best pair first: pending→posted (same amount, within the pending window, similar description) and
 *    cross-source near matches within ±N days (possible_duplicate);
 * 4. everything else is new.
 */
export function planImport(existing: readonly ExistingSourceRecord[], incoming: readonly IncomingSourceRow[], options: PlanImportOptions = {}): ImportPlan {
  const pendingWindow = options.pendingWindowDays ?? 7;
  const crossWindow = options.crossSourceWindowDays ?? 2;
  const threshold = dec(options.similarityThreshold ?? '0.5');
  const active = existing.filter((e) => (e.state ?? 'active') === 'active');
  const identities = computeRowIdentities(incoming);
  const used = new Set<string>();
  const results: Array<PlannedImportRow | null> = incoming.map(() => null);

  const byProviderKey = new Map<string, ExistingSourceRecord>();
  const byDedupeKey = new Map<string, ExistingSourceRecord>();
  const byAmount = new Map<string, ExistingSourceRecord[]>();
  for (const record of active) {
    if (record.providerTransactionId) byProviderKey.set(providerDedupeKey(record.accountId, record.providerTransactionId), record);
    byDedupeKey.set(record.dedupeKey, record);
    const key = amountIndexKey(record.accountId, record.amount);
    const list = byAmount.get(key) ?? [];
    list.push(record);
    byAmount.set(key, list);
  }
  const sameAccountAndAmount = (row: IncomingSourceRow) => byAmount.get(amountIndexKey(row.accountId, row.amount)) ?? [];

  const settle = (index: number, status: ImportDecision, detail: Partial<PlannedImportRow> & { explanation: string[] }) => {
    const identity = identities[index]!;
    results[index] = {
      ...identity,
      status,
      matchedRecordId: detail.matchedRecordId ?? null,
      duplicateOfRow: detail.duplicateOfRow ?? null,
      similarity: detail.similarity ?? null,
      dayGap: detail.dayGap ?? null,
      explanation: detail.explanation,
    };
    if (detail.matchedRecordId) used.add(detail.matchedRecordId);
  };

  // Phase 1: exact identity.
  const seenProviderKeys = new Map<string, number>();
  incoming.forEach((row, index) => {
    const identity = identities[index]!;
    const providerId = row.providerTransactionId?.trim() || null;
    if (providerId) {
      const earlier = seenProviderKeys.get(identity.dedupeKey);
      if (earlier !== undefined) {
        settle(index, 'duplicate', { duplicateOfRow: earlier, explanation: [`Provider id repeats row ${earlier} of this file`] });
        return;
      }
      seenProviderKeys.set(identity.dedupeKey, row.rowNumber);
      const match = byProviderKey.get(identity.dedupeKey);
      if (match && !used.has(match.id)) {
        const dayGap = diffDays(match.bookedOn, row.bookedOn);
        if (match.pending && !row.pending) {
          settle(index, 'pending_to_posted', { matchedRecordId: match.id, dayGap, explanation: ['Same provider id: the pending record is now posted', describeDifferences(match, row)] });
        } else if (match.contentHash === identity.contentHash) {
          settle(index, 'duplicate', { matchedRecordId: match.id, dayGap, explanation: ['Same provider id and identical content'] });
        } else {
          settle(index, 'changed_upstream', {
            matchedRecordId: match.id,
            dayGap,
            explanation: ['Same provider id but the provider changed the record', describeDifferences(match, row)],
          });
        }
      }
      return;
    }
    const match = byDedupeKey.get(identity.tupleKey);
    if (match && !used.has(match.id) && !match.providerTransactionId) {
      const tuple = `same account, date, amount and description (occurrence ${identity.occurrence + 1} of that tuple in this file)`;
      if (match.pending && !row.pending) {
        settle(index, 'pending_to_posted', { matchedRecordId: match.id, dayGap: 0, similarity: '1', explanation: [`Pending record with the ${tuple} is now posted`] });
      } else {
        settle(index, 'duplicate', { matchedRecordId: match.id, dayGap: 0, explanation: [`Existing record with the ${tuple}`] });
      }
    }
  });

  // Phase 2: exact cross-source (provider id on exactly one side).
  incoming.forEach((row, index) => {
    if (results[index]) return;
    const rowHasId = Boolean(row.providerTransactionId?.trim());
    const description = normaliseDescription(row.description);
    const match = sameAccountAndAmount(row).find(
      (e) =>
        !used.has(e.id) &&
        Boolean(e.providerTransactionId) !== rowHasId &&
        e.bookedOn === row.bookedOn &&
        e.pending === Boolean(row.pending) &&
        normaliseDescription(e.description) === description,
    );
    if (match) {
      settle(index, 'duplicate', {
        matchedRecordId: match.id,
        dayGap: 0,
        similarity: '1',
        explanation: ['Provider id present on one side only; date, amount and description are identical'],
      });
    }
  });

  // Phase 3: fuzzy candidates, assigned best-first.
  const candidates: FuzzyCandidate[] = [];
  incoming.forEach((row, index) => {
    if (results[index]) return;
    const rowProviderId = row.providerTransactionId?.trim() || null;
    for (const e of sameAccountAndAmount(row)) {
      if (used.has(e.id)) continue;
      const dayGap = diffDays(e.bookedOn, row.bookedOn);
      const similarity = tokenSimilarity(e.description, row.description);
      const differentIds = !(rowProviderId && e.providerTransactionId && rowProviderId === e.providerTransactionId.trim());
      if (e.pending && !row.pending && differentIds && dayGap >= 0 && dayGap <= pendingWindow && dec(similarity).greaterThanOrEqualTo(threshold)) {
        candidates.push({ rowIndex: index, existing: e, kind: 'pending_to_posted', dayGap, similarity });
        continue;
      }
      const oneSided = Boolean(e.providerTransactionId) !== Boolean(rowProviderId);
      if (oneSided && Math.abs(dayGap) <= crossWindow) {
        candidates.push({ rowIndex: index, existing: e, kind: 'possible_duplicate', dayGap, similarity });
      }
    }
  });
  candidates.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'pending_to_posted' ? -1 : 1) ||
      Math.abs(a.dayGap) - Math.abs(b.dayGap) ||
      dec(b.similarity).comparedTo(dec(a.similarity)) ||
      incoming[a.rowIndex]!.rowNumber - incoming[b.rowIndex]!.rowNumber ||
      (a.existing.id < b.existing.id ? -1 : a.existing.id > b.existing.id ? 1 : 0),
  );
  for (const c of candidates) {
    if (results[c.rowIndex] || used.has(c.existing.id)) continue;
    const row = incoming[c.rowIndex]!;
    if (c.kind === 'pending_to_posted') {
      settle(c.rowIndex, 'pending_to_posted', {
        matchedRecordId: c.existing.id,
        dayGap: c.dayGap,
        similarity: c.similarity,
        explanation: [
          `Pending record ${c.existing.id} has the same amount, was ${c.dayGap} day(s) earlier and has description similarity ${c.similarity}`,
          'The posted row replaces the pending record',
        ],
      });
    } else {
      settle(c.rowIndex, 'possible_duplicate', {
        matchedRecordId: c.existing.id,
        dayGap: c.dayGap,
        similarity: c.similarity,
        explanation: [
          `Provider id present on ${row.providerTransactionId ? 'this row' : 'the existing record'} only; same amount within ${Math.abs(c.dayGap)} day(s)`,
          `Description similarity ${c.similarity}; not identical, so the owner decides`,
        ],
      });
    }
  }

  // Phase 4: everything else is new.
  incoming.forEach((row, index) => {
    if (results[index]) return;
    const identity = identities[index]!;
    settle(index, 'new', {
      explanation: [
        row.providerTransactionId?.trim()
          ? 'No existing record with this provider id or a matching tuple'
          : `No existing record with this tuple (occurrence ${identity.occurrence + 1})`,
      ],
    });
  });

  const rows = results as PlannedImportRow[];
  const count = (s: ImportDecision) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    counts: {
      total: rows.length,
      new: count('new'),
      duplicate: count('duplicate'),
      possibleDuplicate: count('possible_duplicate'),
      pendingToPosted: count('pending_to_posted'),
      changedUpstream: count('changed_upstream'),
    },
  };
}
