/**
 * Tradable instruments. Identity is (kind, symbol, exchange) with NULLs treated as equal,
 * so a symbol without an exchange is one instrument, not many.
 */
import { and, asc, eq, isNull, type SQL } from 'drizzle-orm';
import { instruments, INSTRUMENT_KINDS } from '../schema/org';
import { mapErrors, pickDefined, required, type DbOrTx } from './_util';

export type InstrumentRow = typeof instruments.$inferSelect;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

export interface CreateInstrumentInput {
  symbol: string;
  name: string;
  kind: InstrumentKind;
  /** The instrument's own currency, when it has one (crypto units, bond currency). */
  currency?: string | null;
  exchange?: string | null;
  isin?: string | null;
  identifiers?: Record<string, unknown>;
  bootstrapKey?: string | null;
}

export async function createInstrument(db: DbOrTx, input: CreateInstrumentInput): Promise<InstrumentRow> {
  return mapErrors('create instrument', async () => {
    const [row] = await db
      .insert(instruments)
      .values({
        symbol: input.symbol,
        name: input.name,
        kind: input.kind,
        currency: input.currency ?? null,
        exchange: input.exchange ?? null,
        isin: input.isin ?? null,
        identifiers: input.identifiers ?? {},
        bootstrapKey: input.bootstrapKey ?? null,
      })
      .returning();
    return required(row, 'instrument');
  });
}

export async function updateInstrument(
  db: DbOrTx,
  id: string,
  patch: Partial<Omit<CreateInstrumentInput, 'bootstrapKey'>>,
): Promise<InstrumentRow> {
  return mapErrors('update instrument', async () => {
    const [row] = await db.update(instruments).set(pickDefined(patch)).where(eq(instruments.id, id)).returning();
    return required(row, 'instrument');
  });
}

export async function getInstrument(db: DbOrTx, id: string): Promise<InstrumentRow | undefined> {
  const [row] = await db.select().from(instruments).where(eq(instruments.id, id)).limit(1);
  return row;
}

export async function getInstrumentByBootstrapKey(db: DbOrTx, key: string): Promise<InstrumentRow | undefined> {
  const [row] = await db.select().from(instruments).where(eq(instruments.bootstrapKey, key)).limit(1);
  return row;
}

export async function findInstrument(
  db: DbOrTx,
  identity: { kind: InstrumentKind; symbol: string; exchange?: string | null },
): Promise<InstrumentRow | undefined> {
  const exchange = identity.exchange ?? null;
  const conditions: SQL[] = [eq(instruments.kind, identity.kind), eq(instruments.symbol, identity.symbol)];
  conditions.push(exchange === null ? isNull(instruments.exchange) : eq(instruments.exchange, exchange));
  const [row] = await db
    .select()
    .from(instruments)
    .where(and(...conditions))
    .limit(1);
  return row;
}

export async function listInstruments(db: DbOrTx, query: { kind?: InstrumentKind } = {}): Promise<InstrumentRow[]> {
  return db
    .select()
    .from(instruments)
    .where(query.kind ? eq(instruments.kind, query.kind) : undefined)
    .orderBy(asc(instruments.symbol));
}

export async function getOrCreateInstrument(db: DbOrTx, input: CreateInstrumentInput): Promise<{ row: InstrumentRow; created: boolean }> {
  if (input.bootstrapKey) {
    const existing = await getInstrumentByBootstrapKey(db, input.bootstrapKey);
    if (existing) return { row: existing, created: false };
  }
  const existing = await findInstrument(db, input);
  if (existing) return { row: existing, created: false };
  return { row: await createInstrument(db, input), created: true };
}
