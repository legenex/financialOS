/** Banks, brokers, wallets, funds, issuers and lenders. Reference data, never balances. */
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { institutions, INSTITUTION_KINDS } from '../schema/org';
import { mapErrors, pickDefined, required, type DbOrTx } from './_util';

export type InstitutionRow = typeof institutions.$inferSelect;
export type InstitutionKind = (typeof INSTITUTION_KINDS)[number];

export interface CreateInstitutionInput {
  name: string;
  kind: InstitutionKind;
  country?: string | null;
  providerKey?: string | null;
  notes?: string | null;
  bootstrapKey?: string | null;
}

export async function createInstitution(db: DbOrTx, input: CreateInstitutionInput): Promise<InstitutionRow> {
  return mapErrors('create institution', async () => {
    const [row] = await db
      .insert(institutions)
      .values({
        name: input.name,
        kind: input.kind,
        country: input.country ?? null,
        providerKey: input.providerKey ?? null,
        notes: input.notes ?? null,
        bootstrapKey: input.bootstrapKey ?? null,
      })
      .returning();
    return required(row, 'institution');
  });
}

export async function updateInstitution(
  db: DbOrTx,
  id: string,
  patch: Partial<Omit<CreateInstitutionInput, 'bootstrapKey'>>,
): Promise<InstitutionRow> {
  return mapErrors('update institution', async () => {
    const [row] = await db.update(institutions).set(pickDefined(patch)).where(eq(institutions.id, id)).returning();
    return required(row, 'institution');
  });
}

export async function getInstitution(db: DbOrTx, id: string): Promise<InstitutionRow | undefined> {
  const [row] = await db.select().from(institutions).where(eq(institutions.id, id)).limit(1);
  return row;
}

export async function getInstitutionByBootstrapKey(db: DbOrTx, key: string): Promise<InstitutionRow | undefined> {
  const [row] = await db.select().from(institutions).where(eq(institutions.bootstrapKey, key)).limit(1);
  return row;
}

export async function listInstitutions(db: DbOrTx, query: { kind?: InstitutionKind; providerKey?: string } = {}): Promise<InstitutionRow[]> {
  const conditions: SQL[] = [];
  if (query.kind) conditions.push(eq(institutions.kind, query.kind));
  if (query.providerKey) conditions.push(eq(institutions.providerKey, query.providerKey));
  return db
    .select()
    .from(institutions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(institutions.name));
}

/**
 * Finds an institution by bootstrap key (when given) or by exact name, and creates it when
 * it does not exist. Never merges two institutions that only look alike.
 */
export async function getOrCreateInstitution(db: DbOrTx, input: CreateInstitutionInput): Promise<{ row: InstitutionRow; created: boolean }> {
  if (input.bootstrapKey) {
    const existing = await getInstitutionByBootstrapKey(db, input.bootstrapKey);
    if (existing) return { row: existing, created: false };
  }
  const [byName] = await db.select().from(institutions).where(eq(institutions.name, input.name)).limit(1);
  if (byName) return { row: byName, created: false };
  return { row: await createInstitution(db, input), created: true };
}
