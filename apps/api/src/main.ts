/**
 * Production entry point. Reads configuration and secret files, connects to PostgreSQL as the
 * application role, and serves until SIGTERM/SIGINT, then shuts down gracefully.
 */
import { checkMigrations, createDb } from '@financialos/db';
import { Keyring } from '@financialos/security/crypto';
import { redactText } from '@financialos/security/redact';
import { buildApp } from './app';
import { loadRuntimeConfig } from './config';
import type { ReadinessCheck } from './context';
import { createPgBossEnqueuer } from './jobs';
import { createLogger } from './logger';
import { loadBootstrapHash, loadSessionPepper, readSecretFile } from './secrets';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const logger = createLogger(config.logLevel);
  const keyring = Keyring.load(config.keyringPath, { allowGroupReadable: config.secretFilesGroupReadable });
  const sessionPepper = loadSessionPepper(config.sessionPepperPath);
  const bootstrapHash = loadBootstrapHash(config.bootstrapHashPath);
  const password = config.database.passwordFile ? readSecretFile(config.database.passwordFile, 'database password') : undefined;

  const database = createDb({
    url: config.database.url,
    ...(password !== undefined ? { password } : {}),
    applicationName: 'financialos-api',
    max: 5,
  });

  if (config.environment === 'production') {
    const [row] = await database.sql<{ current_user: string }[]>`select current_user`;
    if (row?.current_user !== config.database.role) {
      throw new Error(`Refusing to start: connected as a different database role than ${config.database.role}`);
    }
  }

  const jobs = createPgBossEnqueuer({ url: config.database.url, ...(password !== undefined ? { password } : {}), logger });
  const migrationsReady: ReadinessCheck = async () => {
    const status = await checkMigrations(database.sql);
    return {
      name: 'migrations',
      ok: status.ok && status.unknown === 0,
      detail: status.ok ? (status.unknown === 0 ? 'applied' : 'database is newer than this release') : `${status.pending.length} pending`,
    };
  };

  const app = await buildApp({
    config,
    db: database.db,
    keyring,
    sessionPepper,
    bootstrapHash,
    logger,
    jobs: jobs.enqueuer,
    readinessChecks: [migrationsReady, jobs.readiness],
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await app.close();
      await jobs.stop();
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
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));

  await app.listen({ host: config.listen.host, port: config.listen.port });
  logger.info({ environment: config.environment, port: config.listen.port }, 'FinancialOS API listening');
}

main().catch((err: unknown) => {
  // Configuration and secret errors never include secret values.
  const message = err instanceof Error ? redactText(`${err.name}: ${err.message}`) : 'startup failed';
  console.error(`financialos-api: ${message}`);
  process.exit(1);
});
