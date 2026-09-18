/**
 * Encrypted database + documents backups (`cli.mjs backup-now|backup-verify|backup-restore`),
 * per docs/BACKUP_AND_RECOVERY.md.
 *
 * Archive format (all multi-byte integers big-endian):
 *   plaintext header:  8 bytes magic "FOSBAK1\n" | 12 bytes GCM IV
 *   AES-256-GCM ciphertext of:
 *     u32 manifestLen | manifest JSON bytes
 *     u32 dumpLen     | pg_dump custom-format bytes (schema `pgboss` excluded)
 *     u32 fileCount   | for each: u32 pathLen | path (utf8) | u32 contentLen | content
 *   16 bytes GCM auth tag
 *
 * The archive is never partially readable: a modified or truncated file fails to decrypt.
 */
import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { createDb, parseDatabaseUrl, type Database } from '@financialos/db';
import type { Keyring } from '@financialos/security/crypto';
import { readSecretFile } from './secrets';
import type { WorkerConfig } from './config';

const MAGIC = Buffer.from('FOSBAK1\n', 'utf8');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ARCHIVE_EXT = '.fosbak';

export class BackupError extends Error {
  override readonly name = 'BackupError';
}

// ---------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------

export interface BackupManifest {
  version: 1;
  createdAt: string;
  schemaVersion: { applied: number; latestApplied: string | null };
  counts: Record<string, number>;
  dumpBytes: number;
  documentCount: number;
}

export interface DocumentFile {
  path: string;
  content: Buffer;
}

interface DecodedArchive {
  manifest: BackupManifest;
  dump: Buffer;
  documents: DocumentFile[];
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function encodePlaintext(manifest: BackupManifest, dump: Buffer, documents: DocumentFile[]): Buffer {
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  const parts: Buffer[] = [u32(manifestBuf.length), manifestBuf, u32(dump.length), dump, u32(documents.length)];
  for (const doc of documents) {
    const pathBuf = Buffer.from(doc.path, 'utf8');
    parts.push(u32(pathBuf.length), pathBuf, u32(doc.content.length), doc.content);
  }
  return Buffer.concat(parts);
}

function decodePlaintext(buf: Buffer): DecodedArchive {
  let offset = 0;
  const readU32 = (): number => {
    if (offset + 4 > buf.length) throw new BackupError('archive is truncated');
    const n = buf.readUInt32BE(offset);
    offset += 4;
    return n;
  };
  const readBytes = (len: number): Buffer => {
    if (offset + len > buf.length) throw new BackupError('archive is truncated');
    const b = buf.subarray(offset, offset + len);
    offset += len;
    return Buffer.from(b);
  };
  const manifestLen = readU32();
  const manifest = JSON.parse(readBytes(manifestLen).toString('utf8')) as BackupManifest;
  const dumpLen = readU32();
  const dump = readBytes(dumpLen);
  const fileCount = readU32();
  const documents: DocumentFile[] = [];
  for (let i = 0; i < fileCount; i += 1) {
    const pathLen = readU32();
    const path = readBytes(pathLen).toString('utf8');
    const contentLen = readU32();
    const content = readBytes(contentLen);
    documents.push({ path, content });
  }
  return { manifest, dump, documents };
}

// ---------------------------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------------------------

function loadBackupKey(config: WorkerConfig): Buffer {
  if (!config.backupKeyPath) throw new BackupError('backup key is not configured (FOS_BACKUP_KEY_FILE)');
  const key = Buffer.from(readSecretFile(config.backupKeyPath, 'backup key'), 'base64');
  if (key.length !== 32) throw new BackupError('backup key must decode to exactly 32 bytes');
  return key;
}

function encryptArchive(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, ciphertext, tag]);
}

function decryptArchive(key: Buffer, archive: Buffer): Buffer {
  if (archive.length < MAGIC.length + IV_LENGTH + TAG_LENGTH || !archive.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupError('not a FinancialOS backup archive');
  }
  const iv = archive.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
  const tag = archive.subarray(archive.length - TAG_LENGTH);
  const ciphertext = archive.subarray(MAGIC.length + IV_LENGTH, archive.length - TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupError('archive could not be decrypted: wrong key, or the file was modified or truncated');
  }
}

// ---------------------------------------------------------------------------------------------
// pg_dump / pg_restore
// ---------------------------------------------------------------------------------------------

const MAX_BUFFER = 2 * 1024 * 1024 * 1024 - 1;

function runPg(cmd: 'pg_dump' | 'pg_restore', args: string[], env: NodeJS.ProcessEnv, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { env, encoding: 'buffer', maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const message = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? err.message);
        reject(new BackupError(`${cmd} failed: ${message.slice(0, 2000)}`));
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
    if (input) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

function pgEnv(password: string | undefined): NodeJS.ProcessEnv {
  return { ...process.env, ...(password !== undefined ? { PGPASSWORD: password } : {}) };
}

async function dumpDatabase(config: WorkerConfig): Promise<Buffer> {
  const parsed = parseDatabaseUrl(config.database.url);
  const password = config.backupDbPasswordFile ? readSecretFile(config.backupDbPasswordFile, 'backup database password') : undefined;
  const args = [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--exclude-schema=pgboss',
    '--host', parsed.host,
    '--port', String(parsed.port),
    '--username', config.backupDbUser,
    '--dbname', parsed.database,
  ];
  return runPg('pg_dump', args, pgEnv(password));
}

async function restoreDatabase(targetUrl: string, targetPassword: string | undefined, dump: Buffer): Promise<void> {
  const parsed = parseDatabaseUrl(targetUrl);
  const args = [
    '--no-owner',
    '--no-privileges',
    '--clean',
    '--if-exists',
    '--host', parsed.host,
    '--port', String(parsed.port),
    '--username', parsed.user || 'fos_migrator',
    '--dbname', parsed.database,
  ];
  await runPg('pg_restore', args, pgEnv(targetPassword ?? (parsed.password || undefined)), dump);
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

function collectDocuments(documentsDir: string): DocumentFile[] {
  const out: DocumentFile[] = [];
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ path: relative(documentsDir, full), content: readFileSync(full) });
    }
  };
  walk(documentsDir);
  return out;
}

function writeDocuments(documentsDir: string, documents: DocumentFile[]): void {
  for (const doc of documents) {
    const dest = join(documentsDir, doc.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, doc.content, { mode: 0o640 });
  }
}

// ---------------------------------------------------------------------------------------------
// Row counts (backup manifest + verify)
// ---------------------------------------------------------------------------------------------

const MANIFEST_TABLES = ['entities', 'accounts', 'source_records', 'journal_entries', 'documents'] as const;

async function tableCounts(db: Database): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of MANIFEST_TABLES) {
    const rows = (await db.execute(sql.raw(`select count(*)::text as count from ${table}`))) as unknown as Array<{ count: string }>;
    counts[table] = Number(rows[0]?.count ?? '0');
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Atomic writes + retention
// ---------------------------------------------------------------------------------------------

function archiveTimestamp(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function writeArchiveAtomic(dir: string, contents: Buffer): string {
  const name = `financialos-backup-${archiveTimestamp()}${ARCHIVE_EXT}`;
  const dest = join(dir, name);
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, contents, { mode: 0o640 });
  renameSync(tmp, dest);
  return dest;
}

/** Keeps the newest 14 backups, plus up to 8 more, one per distinct ISO week, from what remains. */
export function applyRetention(dir: string, log: (message: string) => void): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith('financialos-backup-') && n.endsWith(ARCHIVE_EXT));
  } catch {
    return;
  }
  const files = names
    .map((name) => {
      const full = join(dir, name);
      const mtime = statSync(full).mtime;
      return { name, full, mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const keep = new Set(files.slice(0, 14).map((f) => f.name));
  const remainder = files.slice(14);
  const seenWeeks = new Set<string>();
  for (const f of remainder) {
    if (seenWeeks.size >= 8) break;
    const weekKey = isoWeekKey(f.mtime);
    if (seenWeeks.has(weekKey)) continue;
    seenWeeks.add(weekKey);
    keep.add(f.name);
  }
  for (const f of files) {
    if (!keep.has(f.name)) {
      try {
        unlinkSync(f.full);
        log(`removed backup past retention: ${f.name}`);
      } catch {
        // best-effort
      }
    }
  }
}

function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

// ---------------------------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------------------------

export interface BackupNowResult {
  file: string;
  bytes: number;
  manifest: BackupManifest;
}

export async function backupNow(config: WorkerConfig, db: Database, logger: Pick<Logger, 'info'>): Promise<BackupNowResult> {
  if (!config.backupDir) throw new BackupError('backup directory is not configured (FOS_BACKUP_DIR)');
  const key = loadBackupKey(config);
  const [dump, documents, counts] = await Promise.all([
    dumpDatabase(config),
    Promise.resolve(collectDocuments(config.documentsDir)),
    tableCounts(db),
  ]);
  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    schemaVersion: { applied: 0, latestApplied: null },
    counts,
    dumpBytes: dump.length,
    documentCount: documents.length,
  };
  const plaintext = encodePlaintext(manifest, dump, documents);
  const archive = encryptArchive(key, plaintext);
  mkdirSync(config.backupDir, { recursive: true });
  const file = writeArchiveAtomic(config.backupDir, archive);
  applyRetention(config.backupDir, (message) => logger.info({ backupDir: config.backupDir }, message));
  logger.info({ file, bytes: archive.length, counts }, 'backup written');
  return { file, bytes: archive.length, manifest };
}

function readArchiveFile(config: WorkerConfig, fileName: string): Buffer {
  if (!config.backupDir) throw new BackupError('backup directory is not configured (FOS_BACKUP_DIR)');
  if (fileName.includes('/') || fileName.includes('..')) throw new BackupError('invalid backup file name');
  return readFileSync(join(config.backupDir, fileName));
}

export interface VerifyReport {
  ok: boolean;
  file: string;
  manifest: BackupManifest;
  restoredCounts: Record<string, number>;
  countsMatch: boolean;
  documentsChecked: number;
  documentsFailed: number;
  errors: string[];
}

export async function backupVerify(
  config: WorkerConfig,
  fileName: string,
  targetUrl: string,
  targetPassword: string | undefined,
  keyring: Keyring,
): Promise<VerifyReport> {
  const key = loadBackupKey(config);
  const archive = readArchiveFile(config, fileName);
  const { manifest, dump, documents } = decodePlaintext(decryptArchive(key, archive));
  await restoreDatabase(targetUrl, targetPassword, dump);

  const { decryptEnvelope } = await import('@financialos/security/crypto');
  const target = createDb({ url: targetUrl, ...(targetPassword !== undefined ? { password: targetPassword } : {}), applicationName: 'financialos-backup-verify', max: 1 });
  const errors: string[] = [];
  let restoredCounts: Record<string, number> = {};
  let documentsChecked = 0;
  let documentsFailed = 0;
  try {
    restoredCounts = await tableCounts(target.db);
    const docRows = (await target.db.execute(sql`select id, storage_key, encrypted from documents`)) as unknown as Array<{
      id: string;
      storage_key: string;
      encrypted: boolean;
    }>;
    const byStorageKey = new Map(documents.map((d) => [d.path, d.content]));
    for (const row of docRows) {
      const content = byStorageKey.get(row.storage_key);
      if (!content) {
        documentsFailed += 1;
        errors.push(`document ${row.id}: file for storage key ${row.storage_key} missing from archive`);
        continue;
      }
      documentsChecked += 1;
      if (!row.encrypted) continue;
      try {
        decryptEnvelope(keyring, content, { aad: `document:${row.id}` });
      } catch {
        documentsFailed += 1;
        errors.push(`document ${row.id}: failed to decrypt`);
      }
    }
  } finally {
    await target.close();
  }

  const countsMatch = MANIFEST_TABLES.every((t) => manifest.counts[t] === restoredCounts[t]);
  if (!countsMatch) errors.push('restored row counts do not match the backup manifest');
  return {
    ok: countsMatch && documentsFailed === 0,
    file: fileName,
    manifest,
    restoredCounts,
    countsMatch,
    documentsChecked,
    documentsFailed,
    errors,
  };
}

export async function backupRestore(
  config: WorkerConfig,
  fileName: string,
  targetUrl: string,
  targetPassword: string | undefined,
  documentsDir: string,
): Promise<{ documentCount: number }> {
  const key = loadBackupKey(config);
  const archive = readArchiveFile(config, fileName);
  const { documents, dump } = decodePlaintext(decryptArchive(key, archive));
  await restoreDatabase(targetUrl, targetPassword, dump);
  mkdirSync(documentsDir, { recursive: true });
  writeDocuments(documentsDir, documents);
  return { documentCount: documents.length };
}
