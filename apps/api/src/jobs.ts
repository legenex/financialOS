import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { pgBossRuntimeOptions, withPassword } from '@financialos/db';
import type { JobEnqueuer, ReadinessCheck } from './context';

const QUEUE_NAME = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

export interface PgBossEnqueuer {
  enqueuer: JobEnqueuer;
  readiness: ReadinessCheck;
  stop(): Promise<void>;
}

/**
 * Send-only pg-boss client for the API. The worker owns maintenance and scheduling; the schema
 * is installed by migrations. The client starts lazily so the API can serve sign-in even while
 * the job schema is being migrated.
 */
export function createPgBossEnqueuer(options: { url: string; password?: string; logger: Logger }): PgBossEnqueuer {
  const boss = new PgBoss({
    connectionString: withPassword(options.url, options.password),
    application_name: 'financialos-api-jobs',
    max: 2,
    ...pgBossRuntimeOptions('app'),
  });
  boss.on('error', (err: unknown) => options.logger.error({ err }, 'job queue error'));
  let starting: Promise<unknown> | null = null;
  const ensureStarted = async () => {
    if (!starting) {
      starting = boss.start().catch((err: unknown) => {
        starting = null;
        throw err;
      });
    }
    await starting;
  };

  return {
    enqueuer: {
      async enqueue(queue, data, sendOptions = {}) {
        if (!QUEUE_NAME.test(queue)) throw new Error('invalid queue name');
        await ensureStarted();
        const jobId = await boss.send(queue, data, {
          ...(sendOptions.singletonKey ? { singletonKey: sendOptions.singletonKey } : {}),
          ...(sendOptions.startAfterSeconds ? { startAfter: sendOptions.startAfterSeconds } : {}),
        });
        return { jobId };
      },
    },
    readiness: async () => {
      try {
        await ensureStarted();
        return { name: 'jobs', ok: true, detail: 'queue reachable' };
      } catch {
        return { name: 'jobs', ok: false, detail: 'queue unavailable' };
      }
    },
    async stop() {
      if (starting) await boss.stop({ graceful: true, timeout: 5000 }).catch(() => undefined);
    },
  };
}
