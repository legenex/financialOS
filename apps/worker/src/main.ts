/**
 * Production entry point: a long-running pg-boss worker.
 *
 * Reads configuration and secrets, connects to PostgreSQL as the worker role, subscribes to every
 * known queue, and records a heartbeat row (`worker_heartbeats`) that `cli.mjs health` checks.
 * Queues with no implemented handler yet report `not_configured` rather than hang forever or fake
 * success (ARCHITECTURE.md "Jobs"); see the per-queue comments below.
 */
import { hostname } from 'node:os';
import { PgBoss } from 'pg-boss';
import { pgBossRuntimeOptions, withPassword } from '@financialos/db';
import { Keyring } from '@financialos/security/crypto';
import { redactText } from '@financialos/security/redact';
import { backupNow, backupVerify } from './backup';
import { loadRuntimeConfig } from './config';
import { connectDb } from './db';
import { handleImportCommit, handleImportParse, handleImportReverse } from './jobs/import';
import type { JobContext, JobOutcome } from './jobs/types';
import { completeJobRecord, failJobRecord, markJobRunning, recordWorkerHeartbeat } from './jobRecords';
import { createLogger } from './logger';
import { readSecretFile } from './secrets';

const HEARTBEAT_INTERVAL_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const WORKER_ID = process.env.HOSTNAME || hostname() || 'financialos-worker';
const VERSION = process.env.FOS_RELEASE_VERSION || '0.0.0';

// Payloads differ per queue (see the job-specific handler modules for their real shapes); this
// boundary type is deliberately loose, like an HTTP body, and each handler narrows what it reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (ctx: JobContext, data: any) => Promise<JobOutcome>;

const NOT_IMPLEMENTED = (queue: string): Handler => async () => ({
  status: 'not_configured',
  summary: `${queue} has no handler in this build yet`,
});

const HANDLERS: Record<string, Handler> = {
  'import.parse': handleImportParse,
  'import.commit': handleImportCommit,
  'import.reverse': handleImportReverse,
  'backup.run': async (ctx) => {
    const result = await backupNow(ctx.config, ctx.db, ctx.logger);
    return { status: 'ok', summary: `backup written: ${result.file}`, detail: { bytes: result.bytes, counts: result.manifest.counts } };
  },
  'backup.verify': async (ctx, data) => {
    // Two very different callers share this queue name. deploy/scripts/restore-verify.sh spins up an
    // isolated, throwaway Postgres cluster at the host/compose level and drives `cli.mjs backup-verify`
    // against it directly (never through pg-boss); that flow is unaffected by this handler. The
    // Settings/System "verify" button (POST /api/backups/:id/verify) enqueues here instead, with just
    // a `backupId` — this worker has no scratch database to restore into from inside its own
    // container, so it reports that honestly rather than trying (and failing) to fabricate one.
    if (typeof data.backupId === 'string' && data.file === undefined) {
      return {
        status: 'not_configured',
        summary: 'In-place restore verification is not available from the app; run deploy/scripts/restore-verify.sh, which verifies in an isolated throwaway database.',
      };
    }
    const fileName = String(data.file ?? '');
    const targetUrl = String(data.targetUrl ?? '');
    if (!fileName || !targetUrl) throw new Error('backup.verify requires file and targetUrl');
    const targetPassword = typeof data.targetPassword === 'string' ? data.targetPassword : undefined;
    const report = await backupVerify(ctx.config, fileName, targetUrl, targetPassword, ctx.keyring);
    return { status: 'ok', summary: report.ok ? 'backup verified' : 'backup verification found problems', detail: { ...report } };
  },
  // Bank/provider sync and monthly reconciliation are not implemented in this build; the job
  // record still resolves (rather than staying "queued" forever) so the UI can say so honestly.
  'sync.connection': NOT_IMPLEMENTED('sync.connection'),
  'sync.backfill': NOT_IMPLEMENTED('sync.backfill'),
  'reconcile.monthly': NOT_IMPLEMENTED('reconcile.monthly'),
  'ai.task': NOT_IMPLEMENTED('ai.task'),
};

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const logger = createLogger(config.logLevel);
  const keyring = Keyring.load(config.keyringPath, { allowGroupReadable: config.secretFilesGroupReadable });
  const database = connectDb(config);

  if (config.environment === 'production') {
    const [row] = await database.sql<{ current_user: string }[]>`select current_user`;
    if (row?.current_user !== config.database.role) {
      throw new Error(`Refusing to start: connected as a different database role than ${config.database.role}`);
    }
  }

  const password = config.database.passwordFile ? readSecretFile(config.database.passwordFile, 'database password') : undefined;
  const boss = new PgBoss({
    connectionString: withPassword(config.database.url, password),
    application_name: 'financialos-worker',
    max: 4,
    ...pgBossRuntimeOptions('worker'),
  });
  boss.on('error', (err: unknown) => logger.error({ err }, 'job queue error'));

  const queueNames = Object.keys(HANDLERS);
  await boss.start();
  for (const name of queueNames) {
    await boss.createQueue(name).catch((err: unknown) => {
      logger.warn({ err, queue: name }, 'createQueue failed (it may already exist)');
    });
  }

  const ctx: JobContext = { db: database.db, config, keyring, logger };
  for (const [queue, handler] of Object.entries(HANDLERS)) {
    await boss.work(queue, { includeMetadata: true }, async (jobs) => {
      for (const job of jobs) {
        const data = (job.data ?? {}) as Record<string, unknown>;
        const jobRecordId = typeof data.jobRecordId === 'string' ? data.jobRecordId : null;
        if (jobRecordId) await markJobRunning(ctx.db, jobRecordId);
        try {
          const outcome = await handler(ctx, data);
          if (jobRecordId) {
            await completeJobRecord(ctx.db, jobRecordId, { status: outcome.status, summary: outcome.summary, ...(outcome.detail ?? {}) });
          }
          logger.info({ queue, jobId: job.id, status: outcome.status }, outcome.summary);
        } catch (err) {
          const message = err instanceof Error ? redactText(err.message) : 'job failed';
          const willRetry = job.retryCount < job.retryLimit;
          if (jobRecordId) await failJobRecord(ctx.db, jobRecordId, { error: message, willRetry });
          logger.error({ queue, jobId: job.id, err }, 'job failed');
          throw err;
        }
      }
    });
  }

  await recordWorkerHeartbeat(ctx.db, { workerId: WORKER_ID, version: VERSION, status: 'running', queues: queueNames });
  const heartbeat = setInterval(() => {
    recordWorkerHeartbeat(ctx.db, { workerId: WORKER_ID, version: VERSION, status: 'running', queues: queueNames }).catch((err: unknown) => {
      logger.error({ err }, 'heartbeat write failed');
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  logger.info({ queues: queueNames, workerId: WORKER_ID }, 'worker started');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(heartbeat);
    const force = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await boss.stop({ graceful: true, timeout: 10_000 });
      await database.close();
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`financialos-worker: failed to start: ${err instanceof Error ? redactText(err.message) : String(err)}\n`);
  process.exit(1);
});
