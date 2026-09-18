/**
 * Operations CLI (bundled to dist/cli.mjs). See deploy/compose/*.yml and deploy/scripts/*.sh for
 * how each command is invoked.
 *
 *   migrate
 *       Applies database migrations, installs the pg-boss schema, and grants the runtime roles.
 *       Uses FOS_CONFIG_FILE (FOS_DATABASE_ROLE=migrator).
 *   bootstrap --file <path>
 *       Loads a private owner bootstrap file (idempotent; see src/bootstrap.ts).
 *   seed-demo
 *       Loads a small synthetic dataset. Refuses to run when FOS_ENVIRONMENT=production.
 *   health
 *       Exit 0 when this worker's own heartbeat row is recent. Used as the container healthcheck.
 *   backup-now
 *       Writes one encrypted backup archive now (see src/backup.ts).
 *   backup-verify --file <name> --target-url <url>
 *       Restores the named archive into an empty target database and checks it. Prints one JSON
 *       report line on stdout.
 *   backup-restore --file <name> --target-url <url> --documents-dir <dir>
 *       Restores the named archive's database and documents into the given targets.
 */
import { and, eq, gt } from 'drizzle-orm';
import { hostname } from 'node:os';
import { checkMigrations, runMigrations, workerHeartbeats } from '@financialos/db';
import { readSecretFile } from './secrets';
import { backupNow, backupRestore, backupVerify } from './backup';
import { loadRuntimeConfig } from './config';
import { connectDb } from './db';
import { loadBootstrapFile } from './bootstrap';
import { seedDemo } from './seed-demo';
import { createLogger } from './logger';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`financialos-worker-cli: ${message}\n`);
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) fail(`${name} needs a value`);
  return value;
}

function requiredOption(args: string[], name: string): string {
  return option(args, name) ?? fail(`${name} <value> is required`);
}

const USAGE = `usage: cli.mjs <command>
  migrate
  bootstrap --file <path>
  seed-demo
  health
  backup-now
  backup-verify --file <name> --target-url <url>
  backup-restore --file <name> --target-url <url> --documents-dir <dir>`;

async function cmdMigrate(): Promise<void> {
  const config = loadRuntimeConfig();
  const password = config.database.passwordFile ? readSecretFile(config.database.passwordFile, 'database password') : undefined;
  const result = await runMigrations({
    url: config.database.url,
    ...(password !== undefined ? { password } : {}),
    installPgBoss: true,
    roles: {
      app: process.env.FOS_DB_ROLE_APP ?? 'fos_app',
      worker: process.env.FOS_DB_ROLE_WORKER ?? 'fos_worker',
      backup: process.env.FOS_DB_ROLE_BACKUP ?? 'fos_backup',
    },
    log: (message) => out(`[migrate] ${message}`),
  });
  out(`[migrate] done: ${result.newlyApplied.length} applied, ${result.totalApplied} total, pg-boss ${result.pgBoss}`);
}

async function cmdBootstrap(args: string[]): Promise<void> {
  const file = requiredOption(args, '--file');
  const config = loadRuntimeConfig();
  const logger = createLogger(config.logLevel);
  const handle = connectDb(config);
  try {
    const { readFileSync } = await import('node:fs');
    const result = await loadBootstrapFile(handle.db, file, logger, (p) => readFileSync(p, 'utf8'));
    out(`[bootstrap] ${result.applied ? 'applied' : 'already applied, unchanged'}: ${result.bootstrapId}`);
  } finally {
    await handle.close();
  }
}

async function cmdSeedDemo(): Promise<void> {
  const config = loadRuntimeConfig();
  const logger = createLogger(config.logLevel);
  const handle = connectDb(config);
  try {
    const { bootstrapId } = await seedDemo(handle.db, config, logger);
    out(`[seed-demo] loaded synthetic dataset: ${bootstrapId}`);
  } finally {
    await handle.close();
  }
}

const HEARTBEAT_STALE_MS = 90_000;

async function cmdHealth(): Promise<void> {
  const config = loadRuntimeConfig();
  const handle = connectDb(config);
  try {
    const status = await checkMigrations(handle.sql);
    if (!status.ok) fail(`migrations not fully applied (${status.pending.length} pending)`);
    const workerId = process.env.HOSTNAME || hostname() || 'financialos-worker';
    const cutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);
    const rows = await handle.db
      .select({ lastBeatAt: workerHeartbeats.lastBeatAt })
      .from(workerHeartbeats)
      .where(and(eq(workerHeartbeats.workerId, workerId), gt(workerHeartbeats.lastBeatAt, cutoff)))
      .limit(1);
    if (rows.length === 0) fail(`no recent heartbeat for worker ${workerId}`);
    out('ok');
  } finally {
    await handle.close();
  }
}

async function cmdBackupNow(): Promise<void> {
  const config = loadRuntimeConfig();
  const logger = createLogger(config.logLevel);
  const handle = connectDb(config);
  try {
    const result = await backupNow(config, handle.db, logger);
    out(`[backup-now] wrote ${result.file} (${result.bytes} bytes)`);
  } finally {
    await handle.close();
  }
}

function targetPasswordFromEnv(): string | undefined {
  const path = process.env.FOS_TARGET_DB_PASSWORD_FILE;
  return path ? readSecretFile(path, 'target database password') : undefined;
}

async function cmdBackupVerify(args: string[]): Promise<void> {
  const file = requiredOption(args, '--file');
  const targetUrl = requiredOption(args, '--target-url');
  const config = loadRuntimeConfig();
  const { Keyring } = await import('@financialos/security/crypto');
  const keyring = Keyring.load(config.keyringPath, { allowGroupReadable: config.secretFilesGroupReadable });
  const report = await backupVerify(config, file, targetUrl, targetPasswordFromEnv(), keyring);
  out(JSON.stringify(report));
  if (!report.ok) process.exit(1);
}

async function cmdBackupRestore(args: string[]): Promise<void> {
  const file = requiredOption(args, '--file');
  const targetUrl = requiredOption(args, '--target-url');
  const documentsDir = requiredOption(args, '--documents-dir');
  const config = loadRuntimeConfig();
  const result = await backupRestore(config, file, targetUrl, targetPasswordFromEnv(), documentsDir);
  out(`[backup-restore] restored database and ${result.documentCount} document file(s)`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'migrate':
      return cmdMigrate();
    case 'bootstrap':
      return cmdBootstrap(rest);
    case 'seed-demo':
      return cmdSeedDemo();
    case 'health':
      return cmdHealth();
    case 'backup-now':
      return cmdBackupNow();
    case 'backup-verify':
      return cmdBackupVerify(rest);
    case 'backup-restore':
      return cmdBackupRestore(rest);
    case '-h':
    case '--help':
    case undefined:
      out(USAGE);
      return;
    default:
      fail(`unknown command: ${command} (see --help)`);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`financialos-worker-cli: failed: ${message}\n`);
    process.exit(1);
  },
);
