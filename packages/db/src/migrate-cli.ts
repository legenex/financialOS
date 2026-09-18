#!/usr/bin/env node
// Applies database migrations as the migrator role.
//
// Environment:
//   FOS_DATABASE_URL_MIGRATOR        postgres:// URL without a password (required)
//   FOS_DB_PASSWORD_FILE_MIGRATOR    file holding the migrator password (falls back to FOS_DB_PASSWORD_FILE)
//   FOS_MIGRATIONS_DIR               folder containing the SQL migrations and meta/_journal.json
//   FOS_DB_ROLE_APP / _WORKER / _BACKUP   runtime role names (defaults fos_app, fos_worker, fos_backup)
//   FOS_SKIP_PGBOSS=1                do not install the pg-boss schema
//
// Usage: tsx src/migrate-cli.ts [--status]
import postgres from 'postgres';
import { resolveDatabaseConfig } from './client';
import { checkMigrations, runMigrations } from './migrate';

async function main(): Promise<number> {
  const config = resolveDatabaseConfig({
    urlEnv: 'FOS_DATABASE_URL_MIGRATOR',
    passwordFileEnv: ['FOS_DB_PASSWORD_FILE_MIGRATOR', 'FOS_DB_PASSWORD_FILE'],
  });

  if (process.argv.includes('--status')) {
    const sql = postgres(config.url, { max: 1, ...(config.password ? { password: config.password } : {}) });
    try {
      const status = await checkMigrations(sql);
      console.log(JSON.stringify(status));
      return status.ok ? 0 : 1;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  const started = Date.now();
  const result = await runMigrations({
    url: config.url,
    ...(config.password !== undefined ? { password: config.password } : {}),
    installPgBoss: process.env.FOS_SKIP_PGBOSS !== '1',
    roles: {
      app: process.env.FOS_DB_ROLE_APP ?? 'fos_app',
      worker: process.env.FOS_DB_ROLE_WORKER ?? 'fos_worker',
      backup: process.env.FOS_DB_ROLE_BACKUP ?? 'fos_backup',
    },
    log: (message) => console.log(`[migrate] ${message}`),
  });
  console.log(
    `[migrate] done in ${Date.now() - started} ms: ${result.newlyApplied.length} applied, ${result.totalApplied} total, pg-boss ${result.pgBoss}`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[migrate] failed: ${message}`);
    process.exit(1);
  },
);
