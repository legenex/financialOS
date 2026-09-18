/**
 * Imports: upload, file checks, mapping, preview, commit, reverse, cancel and reusable templates.
 *
 * Parsing, committing and reversing are durable jobs (`import.parse`, `import.commit`,
 * `import.reverse`). The request only records intent and returns a job id. The uploaded file is
 * stored encrypted; the plaintext never lands on disk.
 */
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import {
  ColumnMapping,
  ImportCommitInput,
  ImportConfigureInput,
  ImportFileKind,
  ImportLimits,
  ImportReverseInput,
  type FileCheck,
  type ImportBatch,
  type ImportTemplate,
  type PreviewRow,
} from '@financialos/contracts';
import { accounts as accountsTable, documents as documentsTable, importBatches, importRows, importTemplates } from '@financialos/db';
import { errors } from '../../errors';
import { parseBody, parseQuery } from '../../validation';
import { iso, normalizeDecimal } from '../../data/common';
import { audit, enqueueJob, loadOne, ownerRoutes, requireUuid } from './_shared';

const PEEK_BYTES = 64 * 1024;
const SAMPLE_ROWS = 5;
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const NUL = String.fromCharCode(0);

type ImportBatchRow = typeof importBatches.$inferSelect;

const PreviewQuery = z.object({
  status: z.enum(['new', 'duplicate', 'possible_duplicate', 'pending_to_posted', 'changed_upstream', 'error', 'skipped']).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const TemplateInput = z.object({
  name: z.string().min(1).max(80),
  providerKey: z.string().max(64).nullable(),
  fileKind: ImportFileKind,
  mapping: ColumnMapping,
  headerFingerprint: z.string().max(200).nullable(),
  verified: z.boolean().default(false),
});

/** Magic bytes we can recognise without parsing the file. */
function sniff(head: Buffer): { kind: ImportFileKind | null; detail: string } {
  if (head.subarray(0, 5).toString('ascii') === '%PDF-') return { kind: 'pdf', detail: 'PDF document' };
  if (head.subarray(0, 2).toString('ascii') === 'PK') return { kind: 'xlsx', detail: 'ZIP container (xlsx)' };
  if (head.subarray(0, 8).equals(OLE2_MAGIC)) return { kind: null, detail: 'legacy OLE2 workbook' };
  const text = head.subarray(0, 1024).toString('utf8');
  if (/^\s*OFXHEADER|<OFX>/i.test(text)) return { kind: 'ofx', detail: 'OFX/QFX statement' };
  if (/^\s*<\?xml/i.test(text)) return { kind: 'ibkr_flex_xml', detail: 'XML document' };
  if (text.includes(NUL)) return { kind: null, detail: 'binary content' };
  return { kind: 'csv', detail: 'delimited text' };
}

function fileChecks(input: { size: number; mime: string; head: Buffer; fileName: string }): { checks: FileCheck[]; kind: ImportFileKind | null } {
  const checks: FileCheck[] = [];
  const sizeOk = input.size > 0 && input.size <= ImportLimits.maxFileBytes;
  checks.push({ check: 'size', passed: sizeOk, detail: sizeOk ? `${input.size} bytes` : `File must be between 1 byte and ${ImportLimits.maxFileBytes} bytes` });
  const mimeOk = (ImportLimits.allowedMime as readonly string[]).includes(input.mime);
  checks.push({ check: 'declared_type', passed: mimeOk, detail: mimeOk ? input.mime : `Unsupported content type ${input.mime}` });
  const sniffed = sniff(input.head);
  checks.push({ check: 'content_sniff', passed: sniffed.kind !== null, detail: sniffed.kind ? sniffed.detail : `Refused: ${sniffed.detail}` });
  const macroFree = sniffed.detail !== 'legacy OLE2 workbook' && !/\.xlsm$|\.xlsb$|\.docm$/i.test(input.fileName);
  checks.push({ check: 'no_macros', passed: macroFree, detail: macroFree ? 'No macro-enabled container' : 'Macro-enabled files are refused' });
  const nameOk = !/[\\/]/.test(input.fileName) && !input.fileName.includes(NUL) && input.fileName.length > 0 && input.fileName.length <= 200;
  checks.push({ check: 'file_name', passed: nameOk, detail: nameOk ? 'Safe file name' : 'The file name is empty or contains path separators' });
  return { checks, kind: sniffed.kind };
}

/** First lines of a delimited file, offered only so the owner can pick a mapping. No parsing here. */
function peekDelimited(head: Buffer): { headers: string[]; rows: string[][] } {
  const lines = head
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, SAMPLE_ROWS + 1);
  const first = lines[0];
  if (!first) return { headers: [], rows: [] };
  const best = [',', ';', '\t', '|'].map((d) => ({ d, n: first.split(d).length })).sort((a, b) => b.n - a.n)[0];
  if (!best || best.n < 2) return { headers: [], rows: [] };
  const split = (line: string) => line.split(best.d).map((cell) => cell.trim().replace(/^"|"$/g, '').slice(0, 200));
  return { headers: split(first), rows: lines.slice(1).map(split) };
}

function batchView(row: ImportBatchRow): ImportBatch {
  const reconciliation = row.reconciliation as { status?: unknown; expectedClosing?: unknown; difference?: unknown; detail?: unknown } | null;
  const currency = row.statementCurrency;
  return {
    id: row.id,
    status: row.status,
    fileName: row.fileName,
    fileKind: row.fileKind,
    fileSha256: row.fileSha256,
    sizeBytes: row.sizeBytes,
    accountId: row.accountId,
    entityId: row.entityId,
    templateId: row.templateId,
    parser: row.parser,
    parserVersion: row.parserVersion,
    checks: row.checks,
    detectedHeaders: row.detectedHeaders,
    sampleRows: row.sampleRows,
    counts: row.counts,
    coverage: { from: row.coverageFrom, to: row.coverageTo },
    statementBalances: {
      opening: row.statementOpening !== null && currency !== null ? { amount: normalizeDecimal(row.statementOpening), currency } : null,
      closing: row.statementClosing !== null && currency !== null ? { amount: normalizeDecimal(row.statementClosing), currency } : null,
    },
    reconciliation:
      reconciliation && typeof reconciliation.status === 'string'
        ? {
            status: reconciliation.status as 'balanced' | 'discrepancy' | 'incomplete' | 'not_applicable',
            expectedClosing: (reconciliation.expectedClosing as ImportBatch['statementBalances']['opening']) ?? null,
            difference: (reconciliation.difference as ImportBatch['statementBalances']['opening']) ?? null,
            detail: typeof reconciliation.detail === 'string' ? reconciliation.detail : '',
          }
        : null,
    jobId: row.jobId,
    error: row.error,
    createdAt: iso(row.createdAt),
    committedAt: iso(row.committedAt),
    reversedAt: iso(row.reversedAt),
    reversalReason: row.reversalReason,
    providerHistoryNote: row.providerHistoryNote,
  };
}

function templateView(row: typeof importTemplates.$inferSelect): ImportTemplate {
  return {
    id: row.id,
    name: row.name,
    providerKey: row.providerKey,
    fileKind: row.fileKind,
    mapping: row.mapping as ImportTemplate['mapping'],
    headerFingerprint: row.headerFingerprint,
    verified: row.verified,
    lastUsedAt: iso(row.lastUsedAt),
  };
}

function previewView(row: typeof importRows.$inferSelect): PreviewRow {
  return {
    rowNumber: row.rowNumber,
    status: row.status,
    bookedOn: row.bookedOn,
    description: row.description,
    amount: row.amount !== null && row.currency !== null ? { amount: normalizeDecimal(row.amount), currency: row.currency } : null,
    balance: row.balance !== null && row.currency !== null ? { amount: normalizeDecimal(row.balance), currency: row.currency } : null,
    pending: row.pending,
    message: row.message,
    duplicateOf: row.duplicateOfSourceRecordId,
  };
}

export function registerImportRoutes(app: FastifyInstance): void {
  ownerRoutes(app, async (scope) => {
    await scope.register(multipart, {
      limits: { fileSize: ImportLimits.maxFileBytes, files: 1, fields: 8, fieldSize: 4096 },
      attachFieldsToBody: false,
    });

    scope.post('/api/imports', async (req, reply): Promise<ImportBatch> => {
      const { db, config, keyring, clock } = req.server.fos;
      const file = await req.file();
      if (!file) throw errors.badRequest('Send the statement as a multipart file field.');
      const mime = file.mimetype || 'application/octet-stream';
      await mkdir(config.documentsDir, { recursive: true });
      const documentId = randomUUID();
      const storageKey = `${documentId}.enc`;
      const target = join(config.documentsDir, storageKey);
      const hash = createHash('sha256');
      let size = 0;
      let head = Buffer.alloc(0);
      const source = Readable.from(
        (async function* () {
          for await (const chunk of file.file) {
            const buf = chunk as Buffer;
            size += buf.length;
            if (size > ImportLimits.maxFileBytes) throw errors.badRequest('The file is larger than the import limit.');
            if (head.length < PEEK_BYTES) head = Buffer.concat([head, buf.subarray(0, PEEK_BYTES - head.length)]);
            hash.update(buf);
            yield buf;
          }
        })(),
      );
      try {
        await pipeline(source, keyring.createEncryptStream({ aad: `document:${documentId}` }), createWriteStream(target, { mode: 0o600 }));
      } catch (err) {
        await unlink(target).catch(() => undefined);
        throw err;
      }
      if (file.file.truncated) {
        await unlink(target).catch(() => undefined);
        throw errors.badRequest('The file is larger than the import limit.');
      }
      const fileName = file.filename.slice(0, 200);
      const { checks, kind } = fileChecks({ size, mime, head, fileName });
      const sha256 = hash.digest('hex');
      const failed = checks.filter((c) => !c.passed);
      if (failed.length > 0) {
        await unlink(target).catch(() => undefined);
        await audit(req, 'import.rejected', { type: 'import_batch' }, 'Import file refused by the file checks', { checks: failed.map((c) => c.check) });
        throw errors.badRequest('The file did not pass the import checks.', { checks });
      }
      const peek = kind === 'csv' ? peekDelimited(head) : { headers: [], rows: [] };

      const batch = await db.transaction(async (tx) => {
        const existingDocument = await tx.select().from(documentsTable).where(eq(documentsTable.sha256, sha256)).limit(1);
        let linkedDocumentId = existingDocument[0]?.id ?? null;
        if (!linkedDocumentId) {
          const [doc] = await tx
            .insert(documentsTable)
            .values({
              id: documentId,
              fileName,
              mime,
              sizeBytes: size,
              sha256,
              storageKey,
              // The wrapped data key is carried in the encrypted file's own header.
              wrappedDek: 'envelope_header',
              keyVersion: keyring.activeKid,
              kind: 'statement',
              source: 'import',
              uploadedAt: clock.now(),
            })
            .returning();
          linkedDocumentId = doc?.id ?? null;
        }
        const [row] = await tx
          .insert(importBatches)
          .values({
            status: 'uploaded',
            fileName,
            fileKind: kind,
            fileSha256: sha256,
            sizeBytes: size,
            documentId: linkedDocumentId,
            checks,
            detectedHeaders: peek.headers,
            sampleRows: peek.rows,
            createdBy: 'owner',
          })
          .returning();
        return row;
      });
      if (!batch) throw new Error('import batch insert returned no row');
      await audit(req, 'import.uploaded', { type: 'import_batch', id: batch.id }, `Import file accepted (${kind ?? 'unknown'})`, {
        sizeBytes: size,
        sha256,
        checks: checks.map((c) => c.check),
      });
      reply.code(201);
      return batchView(batch);
    });

    scope.get('/api/imports', async (req): Promise<{ items: ImportBatch[] }> => {
      const query = parseQuery(z.object({ status: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
      const rows = await req.server.fos.db
        .select()
        .from(importBatches)
        .where(query.status ? eq(importBatches.status, query.status as ImportBatchRow['status']) : undefined)
        .orderBy(desc(importBatches.createdAt))
        .limit(query.limit);
      return { items: rows.map(batchView) };
    });

    scope.get<{ Params: { id: string } }>('/api/imports/:id', async (req): Promise<ImportBatch> => {
      const id = requireUuid(req.params.id, 'import_not_found');
      const row = await loadOne(req.server.fos.db.select().from(importBatches).where(eq(importBatches.id, id)).limit(1), 'import_not_found', 'Import not found.');
      return batchView(row);
    });

    scope.post<{ Params: { id: string } }>('/api/imports/:id/configure', async (req): Promise<ImportBatch> => {
      const id = requireUuid(req.params.id, 'import_not_found');
      const input = parseBody(ImportConfigureInput, req.body);
      const { db, clock } = req.server.fos;
      const batch = await loadOne(db.select().from(importBatches).where(eq(importBatches.id, id)).limit(1), 'import_not_found', 'Import not found.');
      if (batch.status === 'committed' || batch.status === 'reversed' || batch.status === 'cancelled') {
        throw errors.conflict('import_not_configurable', 'This import can no longer be configured.');
      }
      const account = await loadOne(db.select().from(accountsTable).where(eq(accountsTable.id, input.accountId)).limit(1), 'account_not_found', 'Account not found.');
      let mapping = input.mapping;
      let templateId = input.templateId;
      if (!mapping && templateId) {
        const template = await loadOne(
          db.select().from(importTemplates).where(eq(importTemplates.id, templateId)).limit(1),
          'template_not_found',
          'Import template not found.',
        );
        mapping = ColumnMapping.parse(template.mapping);
      }
      if (!mapping) throw errors.badRequest('Provide a column mapping or a template to use.');
      if (input.saveTemplateAs) {
        const [saved] = await db
          .insert(importTemplates)
          .values({
            name: input.saveTemplateAs,
            providerKey: null,
            fileKind: input.fileKind,
            mapping: mapping as unknown as Record<string, unknown>,
            headerFingerprint: batch.detectedHeaders.join('|').slice(0, 200) || null,
            verified: false,
            lastUsedAt: clock.now(),
          })
          .onConflictDoNothing({ target: importTemplates.name })
          .returning();
        if (saved) templateId = saved.id;
      }
      const [updated] = await db
        .update(importBatches)
        .set({
          accountId: input.accountId,
          entityId: account.legalEntityId,
          templateId: templateId ?? null,
          fileKind: input.fileKind,
          mapping: mapping as unknown as Record<string, unknown>,
          statementCurrency: mapping.defaultCurrency,
          statementOpening: input.statementOpening,
          statementClosing: input.statementClosing,
          status: 'parsing',
          error: null,
          updatedAt: clock.now(),
        })
        .where(eq(importBatches.id, id))
        .returning();
      if (!updated) throw errors.notFound('import_not_found', 'Import not found.');
      const { jobId } = await enqueueJob(req, {
        queue: 'import.parse',
        label: `Parse ${updated.fileName}`,
        data: { importBatchId: id },
        singletonKey: `import.parse:${id}`,
        idempotencyKey: `import.parse:${id}`,
        subjectType: 'import_batch',
        subjectId: id,
        entityId: account.legalEntityId,
      });
      await db.update(importBatches).set({ jobId }).where(eq(importBatches.id, id));
      await audit(req, 'import.configured', { type: 'import_batch', id }, 'Import mapping configured; parsing scheduled', { accountId: input.accountId, jobId });
      const row = await loadOne(db.select().from(importBatches).where(eq(importBatches.id, id)).limit(1), 'import_not_found', 'Import not found.');
      return batchView(row);
    });

    scope.get<{ Params: { id: string } }>('/api/imports/:id/preview', async (req): Promise<{ items: PreviewRow[]; nextCursor: string | null }> => {
      const id = requireUuid(req.params.id, 'import_not_found');
      const query = parseQuery(PreviewQuery, req.query);
      const conditions = [eq(importRows.batchId, id)];
      if (query.status) conditions.push(eq(importRows.status, query.status));
      if (query.cursor !== undefined) conditions.push(gt(importRows.rowNumber, query.cursor));
      const rows = await req.server.fos.db
        .select()
        .from(importRows)
        .where(and(...conditions))
        .orderBy(asc(importRows.rowNumber))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const nextCursor = rows.length > query.limit && last ? String(last.rowNumber) : null;
      return { items: page.map(previewView), nextCursor };
    });

    scope.post<{ Params: { id: string } }>('/api/imports/:id/commit', async (req): Promise<{ jobId: string }> => {
      const id = requireUuid(req.params.id, 'import_not_found');
      const input = parseBody(ImportCommitInput, req.body);
      const { db, clock } = req.server.fos;
      const batch = await loadOne(db.select().from(importBatches).where(eq(importBatches.id, id)).limit(1), 'import_not_found', 'Import not found.');
      if (batch.status !== 'previewed' && batch.status !== 'needs_mapping') {
        throw errors.conflict('import_not_ready', `This import is ${batch.status} and cannot be committed.`);
      }
      if (!batch.accountId) throw errors.conflict('import_not_configured', 'Configure the account and mapping before committing.');
      await db.update(importBatches).set({ status: 'committing', commitIdempotencyKey: input.idempotencyKey, updatedAt: clock.now() }).where(eq(importBatches.id, id));
      const result = await enqueueJob(req, {
        queue: 'import.commit',
        label: `Commit ${batch.fileName}`,
        data: { importBatchId: id, idempotencyKey: input.idempotencyKey, includePossibleDuplicates: input.includePossibleDuplicates },
        singletonKey: `import.commit:${id}`,
        idempotencyKey: `import.commit:${input.idempotencyKey}`,
        subjectType: 'import_batch',
        subjectId: id,
        entityId: batch.entityId,
      });
      await audit(req, 'import.commit_requested', { type: 'import_batch', id }, 'Import commit scheduled', {
        jobId: result.jobId,
        includedPossibleDuplicates: input.includePossibleDuplicates.length,
      });
      return result;
    });

    scope.post<{ Params: { id: string } }>('/api/imports/:id/reverse', async (req): Promise<{ jobId: string }> => {
      const id = requireUuid(req.params.id, 'import_not_found');
      const input = parseBody(ImportReverseInput, req.body);
      const { db, clock } = req.server.fos;
      const batch = await loadOne(db.select().from(importBatches).where(eq(importBatches.id, id)).limit(1), 'import_not_found', 'Import not found.');
      if (batch.status !== 'committed') throw errors.conflict('import_not_committed', 'Only a committed import can be reversed.');
      const result = await enqueueJob(req, {
        queue: 'import.reverse',
        label: `Reverse ${batch.fileName}`,
        data: { importBatchId: id, reason: input.reason },
        singletonKey: `import.reverse:${id}`,
        idempotencyKey: `import.reverse:${id}`,
        subjectType: 'import_batch',
        subjectId: id,
        entityId: batch.entityId,
      });
      await db
        .update(importBatches)
        .set({ status: 'reversing', reversalReason: input.reason, reversalJobId: result.jobId, updatedAt: clock.now() })
        .where(eq(importBatches.id, id));
      await audit(req, 'import.reverse_requested', { type: 'import_batch', id }, 'Import reversal scheduled', { jobId: result.jobId });
      return result;
    });

    scope.post<{ Params: { id: string } }>('/api/imports/:id/cancel', async (req): Promise<ImportBatch> => {
      const id = requireUuid(req.params.id, 'import_not_found');
      const { db, clock } = req.server.fos;
      const batch = await loadOne(db.select().from(importBatches).where(eq(importBatches.id, id)).limit(1), 'import_not_found', 'Import not found.');
      if (batch.status === 'committed' || batch.status === 'reversed') {
        throw errors.conflict('import_not_cancellable', 'A committed import must be reversed, not cancelled.');
      }
      const [row] = await db.update(importBatches).set({ status: 'cancelled', updatedAt: clock.now() }).where(eq(importBatches.id, id)).returning();
      if (!row) throw errors.notFound('import_not_found', 'Import not found.');
      await audit(req, 'import.cancelled', { type: 'import_batch', id }, 'Import cancelled');
      return batchView(row);
    });

    // --- Templates ------------------------------------------------------------------------
    scope.get('/api/import-templates', async (req): Promise<{ items: ImportTemplate[] }> => {
      const rows = await req.server.fos.db.select().from(importTemplates).orderBy(asc(importTemplates.name)).limit(200);
      return { items: rows.map(templateView) };
    });

    scope.post('/api/import-templates', async (req, reply): Promise<ImportTemplate> => {
      const input = parseBody(TemplateInput, req.body);
      const [row] = await req.server.fos.db
        .insert(importTemplates)
        .values({
          name: input.name,
          providerKey: input.providerKey,
          fileKind: input.fileKind,
          mapping: input.mapping as unknown as Record<string, unknown>,
          headerFingerprint: input.headerFingerprint,
          verified: input.verified,
        })
        .returning();
      if (!row) throw errors.conflict('template_exists', 'A template with that name already exists.');
      await audit(req, 'import_template.created', { type: 'import_template', id: row.id }, `Import template saved (${row.name})`);
      reply.code(201);
      return templateView(row);
    });

    scope.delete('/api/import-templates', async (req) => {
      const input = parseBody(z.object({ id: z.uuid() }), req.body);
      const rows = await req.server.fos.db.delete(importTemplates).where(eq(importTemplates.id, input.id)).returning({ id: importTemplates.id });
      if (rows.length === 0) throw errors.notFound('template_not_found', 'Import template not found.');
      await audit(req, 'import_template.deleted', { type: 'import_template', id: input.id }, 'Import template deleted');
      return { deleted: true };
    });
  });
}
