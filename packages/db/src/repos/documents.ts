/**
 * Encrypted evidence files.
 *
 * The blob lives in storage under `storageKey`, encrypted with a per-document data key that
 * is itself wrapped by the keyring version `keyVersion`. Ordinary reads never return
 * `wrappedDek`: only `getWrappedDek` does, and only when the caller is about to decrypt.
 *
 * Document text is untrusted input. It is data for the owner to read, never instructions.
 */
import { and, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import { documents, DOCUMENT_KINDS } from '../schema/documents';
import { ConflictError, InvalidError, mapErrors, required, type DbOrTx } from './_util';

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** A document without its key material. This is what every normal read returns. */
export type DocumentMetadata = Omit<DocumentRow, 'wrappedDek'>;

const METADATA_COLUMNS = {
  id: documents.id,
  fileName: documents.fileName,
  mime: documents.mime,
  sizeBytes: documents.sizeBytes,
  sha256: documents.sha256,
  storageKey: documents.storageKey,
  keyVersion: documents.keyVersion,
  encrypted: documents.encrypted,
  kind: documents.kind,
  accountId: documents.accountId,
  entityId: documents.entityId,
  source: documents.source,
  note: documents.note,
  uploadedAt: documents.uploadedAt,
  createdAt: documents.createdAt,
} as const;

export interface CreateDocumentInput {
  fileName: string;
  mime: string;
  sizeBytes: number;
  /** Lowercase hex digest of the plaintext, used to detect a re-upload of the same file. */
  sha256: string;
  storageKey: string;
  /** The document's data key, wrapped by the keyring. Never logged, never returned by reads. */
  wrappedDek: string;
  keyVersion: string;
  kind?: DocumentKind;
  accountId?: string | null;
  entityId?: string | null;
  source?: string;
  note?: string | null;
  uploadedAt?: Date;
}

export async function create(db: DbOrTx, input: CreateDocumentInput): Promise<DocumentMetadata> {
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new InvalidError('sha256 must be 64 lowercase hex characters');
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) throw new InvalidError('sizeBytes must be a non-negative integer');
  if (!input.wrappedDek) throw new InvalidError('A document needs its wrapped data key');
  return mapErrors('create document', async () => {
    const [row] = await db
      .insert(documents)
      .values({
        fileName: input.fileName,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        storageKey: input.storageKey,
        wrappedDek: input.wrappedDek,
        keyVersion: input.keyVersion,
        kind: input.kind ?? 'other',
        accountId: input.accountId ?? null,
        entityId: input.entityId ?? null,
        source: input.source ?? 'upload',
        note: input.note ?? null,
        ...(input.uploadedAt ? { uploadedAt: input.uploadedAt } : {}),
      })
      .returning(METADATA_COLUMNS);
    return required(row, 'document');
  });
}

/** Creates the document, or returns the existing one when the same file was already stored. */
export async function createIfAbsent(db: DbOrTx, input: CreateDocumentInput): Promise<{ row: DocumentMetadata; created: boolean }> {
  const existing = await getBySha256(db, input.sha256);
  if (existing) return { row: existing, created: false };
  try {
    return { row: await create(db, input), created: true };
  } catch (error) {
    if (error instanceof ConflictError) {
      const raced = await getBySha256(db, input.sha256);
      if (raced) return { row: raced, created: false };
    }
    throw error;
  }
}

export async function getById(db: DbOrTx, id: string): Promise<DocumentMetadata | undefined> {
  const [row] = await db.select(METADATA_COLUMNS).from(documents).where(eq(documents.id, id)).limit(1);
  return row;
}

export async function getBySha256(db: DbOrTx, sha256: string): Promise<DocumentMetadata | undefined> {
  const [row] = await db.select(METADATA_COLUMNS).from(documents).where(eq(documents.sha256, sha256)).limit(1);
  return row;
}

export async function getByStorageKey(db: DbOrTx, storageKey: string): Promise<DocumentMetadata | undefined> {
  const [row] = await db.select(METADATA_COLUMNS).from(documents).where(eq(documents.storageKey, storageKey)).limit(1);
  return row;
}

/**
 * The only way to read a document's wrapped data key. Call it immediately before unwrapping
 * and decrypting; never log or cache the result.
 */
export async function getWrappedDek(db: DbOrTx, id: string): Promise<{ wrappedDek: string; keyVersion: string } | undefined> {
  const [row] = await db
    .select({ wrappedDek: documents.wrappedDek, keyVersion: documents.keyVersion })
    .from(documents)
    .where(eq(documents.id, id))
    .limit(1);
  return row;
}

/** Rewraps a document's data key under a new keyring version (key rotation). */
export async function rewrap(db: DbOrTx, id: string, wrappedDek: string, keyVersion: string): Promise<DocumentMetadata> {
  if (!wrappedDek) throw new InvalidError('A rewrapped document still needs a wrapped data key');
  const [row] = await db.update(documents).set({ wrappedDek, keyVersion }).where(eq(documents.id, id)).returning(METADATA_COLUMNS);
  return required(row, 'document');
}

export async function updateMetadata(
  db: DbOrTx,
  id: string,
  patch: { kind?: DocumentKind; accountId?: string | null; entityId?: string | null; note?: string | null },
): Promise<DocumentMetadata> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) values[key] = value;
  const [row] = await db.update(documents).set(values).where(eq(documents.id, id)).returning(METADATA_COLUMNS);
  return required(row, 'document');
}

export interface DocumentQuery {
  accountId?: string;
  entityId?: string;
  kind?: DocumentKind | DocumentKind[];
  limit?: number;
}

export async function list(db: DbOrTx, query: DocumentQuery = {}): Promise<DocumentMetadata[]> {
  const conditions: SQL[] = [];
  if (query.accountId) conditions.push(eq(documents.accountId, query.accountId));
  if (query.entityId) conditions.push(eq(documents.entityId, query.entityId));
  if (query.kind) conditions.push(inArray(documents.kind, Array.isArray(query.kind) ? query.kind : [query.kind]));
  return db
    .select(METADATA_COLUMNS)
    .from(documents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(documents.uploadedAt))
    .limit(query.limit ?? 100);
}

/** Documents still wrapped by an old key version, for a rotation job. */
export async function listForRotation(db: DbOrTx, currentKeyVersion: string, limit = 200): Promise<DocumentMetadata[]> {
  return db
    .select(METADATA_COLUMNS)
    .from(documents)
    .where(and(eq(documents.encrypted, true), ne(documents.keyVersion, currentKeyVersion)))
    .orderBy(desc(documents.uploadedAt))
    .limit(limit);
}
