/**
 * Versioned classification of a source record.
 *
 * Exactly one version per record is current (a partial unique index enforces it). A change
 * inserts a new version and flips the old one in the same transaction; versions are never
 * edited, so the full history of how a transaction was understood stays readable.
 *
 * The decision of *whether* a change is worth a new version — an automatic method may not
 * overwrite an owner decision, a model may not decide ownership, identical content is not
 * re-versioned — belongs to `nextClassificationVersion` in `@financialos/domain`.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  nextClassificationVersion,
  type ClassificationContent,
  type ClassificationVersion as DomainClassificationVersion,
} from '@financialos/domain';
import { classifications, type ClassificationMethod, type ConfidenceValue, type TransactionNatureValue } from '../schema/sources';
import { InvalidError, iso, mapErrors, required, tx, type DbOrTx } from './_util';

export type ClassificationRow = typeof classifications.$inferSelect;

export interface SetCurrentInput {
  sourceRecordId: string;
  nature: TransactionNatureValue;
  method: ClassificationMethod;
  categoryId?: string | null;
  economicOwnerEntityId?: string | null;
  counterpartyId?: string | null;
  splits?: Array<Record<string, unknown>> | null;
  confidence?: ConfidenceValue;
  needsReview?: boolean;
  note?: string | null;
  ruleId?: string | null;
  transferMatchId?: string | null;
  createdBy?: string;
  /** Lets a rule or model overwrite an earlier `user` decision. Off by default. */
  overrideUser?: boolean;
}

export type SetCurrentResult =
  | { applied: true; current: ClassificationRow; previous: ClassificationRow | null }
  | { applied: false; current: ClassificationRow; reason: 'unchanged' | 'protected_user_decision' };

function toDomainVersion(row: ClassificationRow): DomainClassificationVersion {
  return {
    sourceRecordId: row.sourceRecordId,
    version: row.version,
    current: row.isCurrent,
    createdAt: iso(row.createdAt),
    supersedesVersion: row.version > 1 ? row.version - 1 : null,
    supersededAt: null,
    method: row.method,
    categoryId: row.categoryId,
    nature: row.nature,
    economicOwnerEntityId: row.economicOwnerEntityId,
    splits: null,
    tags: [],
    confidence: row.confidence,
    needsReview: row.needsReview,
    explanation: [],
    ruleIds: row.ruleId ? [row.ruleId] : [],
    note: row.note,
  };
}

function toContent(input: SetCurrentInput): ClassificationContent {
  return {
    method: input.method,
    categoryId: input.categoryId ?? null,
    nature: input.nature,
    economicOwnerEntityId: input.economicOwnerEntityId ?? null,
    splits: null,
    tags: [],
    confidence: input.confidence ?? 'none',
    needsReview: input.needsReview ?? false,
    explanation: [],
    ruleIds: input.ruleId ? [input.ruleId] : [],
    note: input.note ?? null,
  };
}

/**
 * Inserts a new current version and clears the previous one, in one transaction. Returns
 * `applied: false` (with the unchanged current row) when the domain rules say the change
 * must not be recorded.
 */
export async function setCurrent(db: DbOrTx, input: SetCurrentInput, now = new Date()): Promise<SetCurrentResult> {
  return mapErrors('set classification', () =>
    tx(db, async (t) => {
      // Lock the record's versions so two workers cannot both create version n + 1.
      const existing = await t
        .select()
        .from(classifications)
        .where(eq(classifications.sourceRecordId, input.sourceRecordId))
        .orderBy(desc(classifications.version))
        .for('update');
      const current = existing.find((row) => row.isCurrent) ?? null;

      const decision = nextClassificationVersion(current ? toDomainVersion(current) : null, input.sourceRecordId, toContent(input), {
        at: iso(now),
        ...(input.overrideUser ? { overrideUser: true } : {}),
      });
      if (!decision.applied) {
        return { applied: false as const, current: required(current ?? undefined, 'classification'), reason: decision.reason };
      }

      if (current) {
        await t.update(classifications).set({ isCurrent: false }).where(eq(classifications.id, current.id));
      }
      const version = (existing[0]?.version ?? 0) + 1;
      const [row] = await t
        .insert(classifications)
        .values({
          sourceRecordId: input.sourceRecordId,
          version,
          isCurrent: true,
          nature: input.nature,
          categoryId: input.categoryId ?? null,
          economicOwnerEntityId: decision.next.economicOwnerEntityId,
          counterpartyId: input.counterpartyId ?? null,
          splits: input.splits ?? null,
          confidence: input.confidence ?? 'none',
          method: input.method,
          ruleId: input.ruleId ?? null,
          transferMatchId: input.transferMatchId ?? null,
          needsReview: decision.next.needsReview,
          note: input.note ?? null,
          createdBy: input.createdBy ?? 'system',
        })
        .returning();
      return { applied: true as const, current: required(row, 'classification'), previous: current };
    }),
  );
}

export async function getCurrent(db: DbOrTx, sourceRecordId: string): Promise<ClassificationRow | undefined> {
  const [row] = await db
    .select()
    .from(classifications)
    .where(and(eq(classifications.sourceRecordId, sourceRecordId), eq(classifications.isCurrent, true)))
    .limit(1);
  return row;
}

/** Current classifications for many records, keyed by source record id. */
export async function getCurrentMany(db: DbOrTx, sourceRecordIds: readonly string[]): Promise<Map<string, ClassificationRow>> {
  if (sourceRecordIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(classifications)
    .where(and(inArray(classifications.sourceRecordId, [...sourceRecordIds]), eq(classifications.isCurrent, true)));
  return new Map(rows.map((row) => [row.sourceRecordId, row]));
}

/** Full version history for one record, oldest first. */
export async function history(db: DbOrTx, sourceRecordId: string): Promise<ClassificationRow[]> {
  return db
    .select()
    .from(classifications)
    .where(eq(classifications.sourceRecordId, sourceRecordId))
    .orderBy(asc(classifications.version));
}

export async function listNeedingReview(db: DbOrTx, limit = 100): Promise<ClassificationRow[]> {
  return db
    .select()
    .from(classifications)
    .where(and(eq(classifications.isCurrent, true), eq(classifications.needsReview, true)))
    .orderBy(desc(classifications.createdAt))
    .limit(limit);
}

export async function countByNature(db: DbOrTx): Promise<Record<string, number>> {
  const rows = await db
    .select({ nature: classifications.nature, n: sql<number>`count(*)::int` })
    .from(classifications)
    .where(eq(classifications.isCurrent, true))
    .groupBy(classifications.nature);
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.nature] = row.n;
  return counts;
}

/** Records with no classification at all yet. */
export async function listUnclassified(db: DbOrTx, sourceRecordIds: readonly string[]): Promise<string[]> {
  if (sourceRecordIds.length === 0) return [];
  const classified = await getCurrentMany(db, sourceRecordIds);
  return sourceRecordIds.filter((id) => !classified.has(id));
}

export function assertNature(value: string): TransactionNatureValue {
  const nature = value as TransactionNatureValue;
  if (!nature) throw new InvalidError('A classification needs a nature');
  return nature;
}
