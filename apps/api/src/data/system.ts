/**
 * System status from the operational status files the deploy scripts drop in `opsStatusDir`, plus
 * live counts from the database.
 *
 * An absent or unreadable status file means "unknown". It never becomes "ok": the API does not
 * claim a route is active, a restore was verified, or disk space is fine, unless a file says so.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { and, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { BackupRecord, SystemStatus } from '@financialos/contracts';
import { backups, jobRecords, workerHeartbeats, type DbOrTx } from '@financialos/db';
import type { RuntimeConfig } from '../config';
import { iso } from './common';

const MAX_STATUS_FILE_BYTES = 256 * 1024;
const WORKER_OK_SECONDS = 300;
const WORKER_STALE_SECONDS = 3600;

export const OPS_STATUS_FILES = ['route-status.json', 'restore-verify-status.json', 'release.json', 'disk-status.json'] as const;
export type OpsStatusFile = (typeof OPS_STATUS_FILES)[number];

const RouteStatusFile = z.object({
  schemaVersion: z.number().int().optional(),
  checkedAt: z.string().optional(),
  mode: z.string().optional(),
  canonicalOrigin: z.string().nullable().optional(),
  handlerPresent: z.boolean().optional(),
  backend: z.string().optional(),
  certificateValid: z.boolean().nullable().optional(),
  healthz: z.number().nullable().optional(),
  headersOk: z.boolean().nullable().optional(),
  status: z.enum(['active', 'not_configured', 'owner_action_required', 'error']).optional(),
  ownerAction: z.string().nullable().optional(),
  detail: z.string().optional(),
});

const DiskStatusFile = z.object({
  checkedAt: z.string().optional(),
  paths: z
    .array(z.object({ path: z.string(), totalBytes: z.number(), availBytes: z.number(), usedPercent: z.number().optional(), level: z.enum(['ok', 'warn', 'critical']).optional() }))
    .optional(),
});

const ReleaseFile = z.object({ image: z.string().optional(), previousImage: z.string().nullable().optional(), deployedAt: z.string().optional(), result: z.string().optional() });

const RestoreVerifyFile = z.object({ checkedAt: z.string().optional(), backupFile: z.string().optional(), ok: z.boolean().optional(), detail: z.string().optional() });

export interface OpsStatusRead<T> {
  /** Null when the file is absent or unreadable: the caller must report "unknown", never "ok". */
  value: T | null;
  present: boolean;
  detail: string;
}

/** Reads one ops status file. Nothing outside `opsStatusDir` can be read. */
export async function readOpsStatus<T>(config: Pick<RuntimeConfig, 'opsStatusDir'>, name: OpsStatusFile, schema: z.ZodType<T>): Promise<OpsStatusRead<T>> {
  if (!config.opsStatusDir || !isAbsolute(config.opsStatusDir)) {
    return { value: null, present: false, detail: 'No operational status directory is configured on this server.' };
  }
  const path = join(config.opsStatusDir, name);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { value: null, present: false, detail: `${name} has not been written on this server.` };
  }
  if (text.length > MAX_STATUS_FILE_BYTES) return { value: null, present: true, detail: `${name} is larger than expected and was not read.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: null, present: true, detail: `${name} is not valid JSON.` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) return { value: null, present: true, detail: `${name} does not match the expected shape.` };
  return { value: result.data, present: true, detail: `${name} read.` };
}

export function backupView(row: typeof backups.$inferSelect): BackupRecord {
  return {
    id: row.id,
    status: row.status,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    keyVersion: row.keyVersion,
    destination: row.destination,
    includes: row.includes,
    restoreVerifiedAt: iso(row.restoreVerifiedAt),
    restoreVerification: row.restoreVerification,
    error: row.error,
  };
}

const ROUTE_STATUS_MAP: Record<'active' | 'not_configured' | 'owner_action_required' | 'error', SystemStatus['route']['status']> = {
  active: 'active',
  not_configured: 'unverified',
  owner_action_required: 'pending_owner_activation',
  error: 'error',
};

export async function buildSystemStatus(db: DbOrTx, config: RuntimeConfig, options: { version: string; now: Date; extensionOrigins: string[] }): Promise<SystemStatus> {
  const [route, disk, release, restore] = await Promise.all([
    readOpsStatus(config, 'route-status.json', RouteStatusFile),
    readOpsStatus(config, 'disk-status.json', DiskStatusFile),
    readOpsStatus(config, 'release.json', ReleaseFile),
    readOpsStatus(config, 'restore-verify-status.json', RestoreVerifyFile),
  ]);

  let databaseStatus: SystemStatus['database']['status'];
  let sizeBytes: number | null = null;
  let migrations: string;
  try {
    const rows = (await db.execute(sql`select pg_database_size(current_database())::bigint as size`)) as unknown as Array<{ size: string | number }>;
    const raw = rows[0]?.size;
    sizeBytes = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : null;
    databaseStatus = 'ok';
  } catch {
    databaseStatus = 'down';
  }
  try {
    const rows = (await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as unknown as Array<{ n: number }>;
    const n = rows[0]?.n;
    migrations = typeof n === 'number' ? `${n} applied` : 'unknown';
  } catch {
    migrations = 'unknown';
  }

  const [heartbeat] = await db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastBeatAt)).limit(1);
  const ageSeconds = heartbeat ? (options.now.getTime() - heartbeat.lastBeatAt.getTime()) / 1000 : null;
  const workerStatus: SystemStatus['worker']['status'] =
    ageSeconds === null ? 'down' : ageSeconds <= WORKER_OK_SECONDS ? 'ok' : ageSeconds <= WORKER_STALE_SECONDS ? 'stale' : 'down';

  const dayAgo = new Date(options.now.getTime() - 86_400_000);
  const [jobCounts, failed24h, recentFailures, lastBackup, offhostBackup] = await Promise.all([
    db.select({ status: jobRecords.status, n: count() }).from(jobRecords).groupBy(jobRecords.status),
    db
      .select({ n: count() })
      .from(jobRecords)
      .where(and(eq(jobRecords.status, 'failed'), gte(jobRecords.finishedAt, dayAgo))),
    db
      .select({ finishedAt: jobRecords.finishedAt, queue: jobRecords.queue, error: jobRecords.error })
      .from(jobRecords)
      .where(and(isNotNull(jobRecords.error), gte(jobRecords.createdAt, dayAgo)))
      .orderBy(desc(jobRecords.createdAt))
      .limit(10),
    db.select().from(backups).orderBy(desc(backups.startedAt)).limit(1),
    db.select({ n: count() }).from(backups).where(eq(backups.destination, 'offhost')),
  ]);
  const byStatus = new Map(jobCounts.map((row) => [row.status, row.n]));

  const diskPath = disk.value?.paths?.[0] ?? null;
  const routeValue = route.value;

  return {
    version: options.version,
    environment: config.environment,
    canonicalOrigin: config.canonicalOrigin,
    allowedOrigins: config.allowedOrigins,
    route: {
      kind: routeValue?.mode === 'tailscale-serve' ? 'tailscale_serve' : routeValue?.mode === 'custom-domain' ? 'custom_domain' : 'loopback_only',
      status: routeValue?.status ? ROUTE_STATUS_MAP[routeValue.status] : 'unverified',
      detail: routeValue?.detail ?? route.detail,
      ownerSteps: routeValue?.ownerAction ? [routeValue.ownerAction] : [],
    },
    tls: {
      terminatedBy: routeValue?.backend ?? 'unknown',
      verified: routeValue?.certificateValid === true,
      detail: routeValue ? (routeValue.certificateValid === null || routeValue.certificateValid === undefined ? 'The certificate has not been verified.' : routeValue.detail ?? '') : route.detail,
    },
    oauthCallbackUrls: [`${config.publicBaseForOAuthCallbacks}/api/oauth/callback`],
    extensionOrigins: options.extensionOrigins,
    database: { status: databaseStatus, sizeBytes, migrations },
    worker: { status: workerStatus, lastHeartbeatAt: heartbeat ? iso(heartbeat.lastBeatAt) : null },
    jobs: {
      queued: byStatus.get('queued') ?? 0,
      running: byStatus.get('running') ?? 0,
      failed24h: failed24h[0]?.n ?? 0,
      deadLetter: byStatus.get('dead_letter') ?? 0,
    },
    disk: {
      freeBytes: diskPath ? diskPath.availBytes : null,
      totalBytes: diskPath ? diskPath.totalBytes : null,
      warning: diskPath ? diskPath.level === 'warn' || diskPath.level === 'critical' : false,
    },
    backups: {
      last: lastBackup[0] ? backupView(lastBackup[0]) : null,
      offhost: {
        configured: (offhostBackup[0]?.n ?? 0) > 0,
        detail:
          (offhostBackup[0]?.n ?? 0) > 0
            ? 'At least one backup has been written to an off-host destination.'
            : 'No off-host backup has been recorded on this server.',
      },
      encryption: restore.value?.ok === true ? `Encrypted; last restore verification passed (${restore.value.checkedAt ?? 'date unknown'}).` : restore.value?.ok === false ? `Encrypted; the last restore verification failed: ${restore.value.detail ?? 'no detail'}.` : `Encrypted. ${restore.detail}`,
    },
    encryptionAtRest: {
      secrets: 'AES-256-GCM with the versioned keyring; ciphertext only in the database.',
      documents: 'AES-256-GCM envelope encryption per file; the plaintext is never written to disk.',
      database: 'Not encrypted by FinancialOS; it inherits whatever the host volume provides.',
      hostDisk: release.value?.image ? `Release ${release.value.image}; host disk encryption is not visible to the application.` : 'Not visible to the application.',
    },
    recentErrors: recentFailures
      .filter((row) => row.error !== null)
      .map((row) => ({ at: iso(row.finishedAt ?? options.now), source: row.queue, message: (row.error as string).slice(0, 300) })),
  };
}

export { gte };
