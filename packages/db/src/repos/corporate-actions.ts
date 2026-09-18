/**
 * Splits, dividends, spin-offs, symbol changes.
 *
 * A corporate action starts as `unverified` (or `announced`) and only becomes fact when the
 * owner supplies evidence. Nothing is applied to holdings until the status is `applied`.
 */
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { corporateActions, CORPORATE_ACTION_KINDS } from '../schema/accounts';
import { assertDecimal, mapErrors, pickDefined, required, type DbOrTx } from './_util';

export type CorporateActionRow = typeof corporateActions.$inferSelect;
export type CorporateActionKind = (typeof CORPORATE_ACTION_KINDS)[number];
export type CorporateActionStatus = 'announced' | 'unverified' | 'verified' | 'applied';

export interface CreateInput {
  instrumentId: string;
  kind: CorporateActionKind;
  effectiveDate?: string | null;
  /** For a split: `ratioFrom` old shares become `ratioTo` new shares. */
  ratioFrom?: string | null;
  ratioTo?: string | null;
  status?: CorporateActionStatus;
  details?: Record<string, unknown>;
  source?: string | null;
  documentId?: string | null;
}

export async function create(db: DbOrTx, input: CreateInput): Promise<CorporateActionRow> {
  if (input.ratioFrom != null) assertDecimal(input.ratioFrom, 'ratioFrom');
  if (input.ratioTo != null) assertDecimal(input.ratioTo, 'ratioTo');
  return mapErrors('create corporate action', async () => {
    const [row] = await db
      .insert(corporateActions)
      .values({
        instrumentId: input.instrumentId,
        kind: input.kind,
        effectiveDate: input.effectiveDate ?? null,
        ratioFrom: input.ratioFrom ?? null,
        ratioTo: input.ratioTo ?? null,
        status: input.status ?? 'unverified',
        details: input.details ?? {},
        source: input.source ?? null,
        documentId: input.documentId ?? null,
      })
      .returning();
    return required(row, 'corporate action');
  });
}

export async function update(db: DbOrTx, id: string, patch: Partial<CreateInput>): Promise<CorporateActionRow> {
  return mapErrors('update corporate action', async () => {
    const [row] = await db.update(corporateActions).set(pickDefined(patch)).where(eq(corporateActions.id, id)).returning();
    return required(row, 'corporate action');
  });
}

export async function setStatus(db: DbOrTx, id: string, status: CorporateActionStatus): Promise<CorporateActionRow> {
  return update(db, id, { status });
}

export async function getById(db: DbOrTx, id: string): Promise<CorporateActionRow | undefined> {
  const [row] = await db.select().from(corporateActions).where(eq(corporateActions.id, id)).limit(1);
  return row;
}

export async function list(
  db: DbOrTx,
  query: { instrumentId?: string; status?: CorporateActionStatus | CorporateActionStatus[] } = {},
): Promise<CorporateActionRow[]> {
  const conditions: SQL[] = [];
  if (query.instrumentId) conditions.push(eq(corporateActions.instrumentId, query.instrumentId));
  if (query.status) conditions.push(inArray(corporateActions.status, Array.isArray(query.status) ? query.status : [query.status]));
  return db
    .select()
    .from(corporateActions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(corporateActions.effectiveDate), asc(corporateActions.createdAt));
}
