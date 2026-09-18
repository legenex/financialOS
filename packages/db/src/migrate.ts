import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import { listCurrencies } from '@financialos/domain';
import { parseDatabaseUrl, redactDatabaseUrl } from './client';

export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';
export const PGBOSS_SCHEMA = 'pgboss';
/** Advisory lock name shared by every process that migrates this database. */
export const MIGRATION_LOCK_NAME = 'financialos:migrate';

export interface RuntimeRoleNames {
  app: string | null;
  worker: string | null;
  backup: string | null;
}

export const DEFAULT_ROLE_NAMES: RuntimeRoleNames = { app: 'fos_app', worker: 'fos_worker', backup: 'fos_backup' };

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export type MigrationLogger = (message: string) => void;

const defaultLogger: MigrationLogger = (message) => {
  process.stdout.write(`[migrate] ${message}\n`);
};

/**
 * Locates the migrations folder: explicit option, then FOS_MIGRATIONS_DIR, then the
 * folder next to this package's sources, then `<cwd>/migrations`.
 */
export function resolveMigrationsDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (env.FOS_MIGRATIONS_DIR) candidates.push(env.FOS_MIGRATIONS_DIR);
  try {
    candidates.push(fileURLToPath(new URL('../migrations', import.meta.url)));
  } catch {
    // import.meta.url is not a file URL (for example inside some bundles).
  }
  candidates.push(path.resolve(process.cwd(), 'migrations'));
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'meta', '_journal.json'))) return dir;
  }
  throw new Error(`Migrations folder not found. Set FOS_MIGRATIONS_DIR. Tried: ${candidates.join(', ')}`);
}

const journalCache = new Map<string, JournalEntry[]>();

export function readJournal(migrationsDir: string): JournalEntry[] {
  const cached = journalCache.get(migrationsDir);
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  const entries = [...raw.entries].sort((a, b) => a.when - b.when);
  journalCache.set(migrationsDir, entries);
  return entries;
}

async function appliedMillis(sql: postgres.Sql): Promise<number[]> {
  const exists = await sql<{ present: boolean }[]>`
    SELECT to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) IS NOT NULL AS present`;
  if (!exists[0]?.present) return [];
  const rows = await sql<{ created_at: string | number }[]>`
    SELECT created_at FROM ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)} ORDER BY created_at`;
  return rows.map((r) => Number(r.created_at));
}

export interface MigrationStatus {
  ok: boolean;
  applied: number;
  expected: number;
  pending: string[];
  /** Applied migrations the running code does not know (database is newer than the code). */
  unknown: number;
  latestApplied: string | null;
  latestExpected: string | null;
}

/** Compares applied migrations with the journal shipped with this code. Used by /readyz. */
export async function checkMigrations(sql: postgres.Sql, options: { migrationsDir?: string } = {}): Promise<MigrationStatus> {
  const journal = readJournal(resolveMigrationsDir(options.migrationsDir));
  const applied = await appliedMillis(sql);
  const appliedSet = new Set(applied);
  const known = new Map(journal.map((e) => [e.when, e.tag]));
  const pending = journal.filter((e) => !appliedSet.has(e.when)).map((e) => e.tag);
  const unknown = applied.filter((w) => !known.has(w)).length;
  const lastApplied = applied.length > 0 ? applied[applied.length - 1] : undefined;
  return {
    ok: pending.length === 0,
    applied: applied.length,
    expected: journal.length,
    pending,
    unknown,
    latestApplied: lastApplied === undefined ? null : (known.get(lastApplied) ?? `unknown:${lastApplied}`),
    latestExpected: journal.at(-1)?.tag ?? null,
  };
}

export interface RunMigrationsOptions {
  url: string;
  password?: string;
  migrationsDir?: string;
  log?: MigrationLogger;
  /** Install or upgrade the pg-boss schema as the migrating role. Default true. */
  installPgBoss?: boolean;
  /** Role names to grant. Missing roles are skipped. */
  roles?: Partial<RuntimeRoleNames>;
  /** How long to wait for another migrator holding the lock. Default 300 s. */
  lockTimeoutSeconds?: number;
}

export interface RunMigrationsResult {
  newlyApplied: string[];
  totalApplied: number;
  currenciesAdded: number;
  pgBoss: 'installed' | 'skipped';
  grantedRoles: string[];
}

/**
 * Applies pending migrations under a session advisory lock, tops up reference data,
 * installs pg-boss, and re-applies role grants. Safe to run repeatedly and concurrently.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const log = options.log ?? defaultLogger;
  const migrationsFolder = resolveMigrationsDir(options.migrationsDir);
  const journal = readJournal(migrationsFolder);
  const roles = { ...DEFAULT_ROLE_NAMES, ...options.roles };
  const lockTimeout = options.lockTimeoutSeconds ?? 300;

  // A single connection: the advisory lock and drizzle's migration transaction share it.
  const sql = postgres(options.url, {
    max: 1,
    idle_timeout: 0,
    prepare: false,
    onnotice: () => undefined,
    ...(options.password !== undefined ? { password: options.password } : {}),
    connection: {
      application_name: 'financialos-migrate',
      statement_timeout: 0,
      lock_timeout: lockTimeout * 1000,
      TimeZone: 'UTC',
    },
  });

  log(`target ${redactDatabaseUrl(options.url)}; ${journal.length} migrations in ${migrationsFolder}`);
  try {
    log('waiting for migration lock');
    await sql`SELECT pg_advisory_lock(hashtextextended(${MIGRATION_LOCK_NAME}, 0))`;
    log('migration lock acquired');
    try {
      const before = new Set(await appliedMillis(sql));
      log(`${before.size} migrations already applied`);

      await drizzleMigrate(drizzle({ client: sql }), {
        migrationsFolder,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      });

      const after = await appliedMillis(sql);
      const tags = new Map(journal.map((e) => [e.when, e.tag]));
      const newlyApplied = after.filter((w) => !before.has(w)).map((w) => tags.get(w) ?? `unknown:${w}`);
      if (newlyApplied.length === 0) log('schema is up to date; nothing to apply');
      for (const tag of newlyApplied) log(`applied ${tag}`);

      const currenciesAdded = await topUpCurrencies(sql);
      if (currenciesAdded > 0) log(`added ${currenciesAdded} currencies from the registry`);
      await sql`SELECT financialos_install_updated_at_triggers()`;

      let pgBoss: RunMigrationsResult['pgBoss'] = 'skipped';
      if (options.installPgBoss !== false) {
        await installPgBoss(options.url, options.password);
        pgBoss = 'installed';
        log(`pg-boss schema "${PGBOSS_SCHEMA}" installed or up to date`);
      }

      const granted = await applyGrants(sql, roles);
      log(granted.length > 0 ? `grants applied to ${granted.join(', ')}` : 'no runtime roles found; grants skipped');

      return { newlyApplied, totalApplied: after.length, currenciesAdded, pgBoss, grantedRoles: granted };
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtextextended(${MIGRATION_LOCK_NAME}, 0))`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Re-applies grants (including the pg-boss schema). Idempotent. */
export async function applyGrants(sql: postgres.Sql, roles: Partial<RuntimeRoleNames> = {}): Promise<string[]> {
  const r = { ...DEFAULT_ROLE_NAMES, ...roles };
  const rows = await sql<{ granted: string }[]>`
    SELECT financialos_apply_grants(${r.app}, ${r.worker}, ${r.backup}) AS granted`;
  const granted = rows[0]?.granted ?? '';
  return granted ? granted.split(',') : [];
}

/** Grants pg-boss access to the runtime roles; call after boss.start() created the schema. */
export const grantPgBoss = applyGrants;

async function topUpCurrencies(sql: postgres.Sql): Promise<number> {
  const rows = listCurrencies().map((c) => ({ code: c.code, name: c.name, minor_units: c.minorUnits, kind: c.kind }));
  if (rows.length === 0) return 0;
  const inserted = await sql`
    INSERT INTO currencies ${sql(rows, 'code', 'name', 'minor_units', 'kind')}
    ON CONFLICT (code) DO NOTHING
    RETURNING code`;
  return inserted.length;
}

/**
 * Installs or upgrades the pg-boss schema. Runs as the migrating role, which owns the
 * schema. Runtime processes must start pg-boss with `pgBossRuntimeOptions()`.
 */
export async function installPgBoss(url: string, password?: string): Promise<void> {
  const { PgBoss } = await import('pg-boss');
  const parsed = parseDatabaseUrl(url);
  const boss = new PgBoss({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: password ?? parsed.password,
    schema: PGBOSS_SCHEMA,
    application_name: 'financialos-migrate',
    max: 2,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });
  const errors: unknown[] = [];
  boss.on('error', (error) => errors.push(error));
  await boss.start();
  await boss.stop({ graceful: false, close: true });
  if (errors.length > 0) throw new Error('pg-boss reported an error while installing its schema');
}

/**
 * pg-boss options for the app and worker roles. They never run pg-boss migrations or
 * other DDL: schema changes happen only in `migrate`.
 */
export function pgBossRuntimeOptions(role: 'app' | 'worker') {
  return {
    schema: PGBOSS_SCHEMA,
    migrate: false,
    createSchema: false,
    reindex: false,
    persistQueueStats: false,
    supervise: role === 'worker',
    schedule: role === 'worker',
  } as const;
}
