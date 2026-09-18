import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb, withDatabase, type Database } from './client';
import { assertTestDatabaseName, assertTestDatabaseUrl, TEST_DATABASE_PREFIX } from './guard';
import { runMigrations, type RuntimeRoleNames } from './migrate';

export interface TestDatabase {
  /** Name of the per-test database (`fos_it_<random>`). */
  name: string;
  /** URL of the per-test database. */
  url: string;
  db: Database;
  sql: postgres.Sql;
  /** Closes the pool and drops the database. Safe to call more than once. */
  close(): Promise<void>;
  /** Alias of close(). */
  drop(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** Defaults to FOS_TEST_DATABASE_URL. Must point at the isolated test server. */
  baseUrl?: string;
  /** Install the pg-boss schema as well. Default false (it is slower). */
  pgBoss?: boolean;
  /** Runtime role names to grant. Default: none (roles are cluster-wide on the test server). */
  roles?: Partial<RuntimeRoleNames>;
  /** Pool size for the returned client. Default 3. */
  max?: number;
  applicationName?: string;
}

const NO_ROLES: RuntimeRoleNames = { app: null, worker: null, backup: null };

/**
 * Creates `fos_it_<random>` on the isolated test server, applies all migrations, and
 * returns a client. Refuses to touch anything but the test server.
 */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const baseUrl = options.baseUrl ?? process.env.FOS_TEST_DATABASE_URL;
  assertTestDatabaseUrl(baseUrl);
  const base = baseUrl as string;
  // The creation time is part of the name so crashed runs can be cleaned up by age.
  const name = `${TEST_DATABASE_PREFIX}${Math.floor(Date.now() / 1000).toString(36)}_${randomBytes(5).toString('hex')}`;
  assertTestDatabaseName(name);

  const admin = postgres(base, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = withDatabase(base, name);
  let dropped = false;
  const dropDatabase = async () => {
    if (dropped) return;
    dropped = true;
    const cleanup = postgres(base, { max: 1, onnotice: () => undefined });
    try {
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await cleanup.end({ timeout: 5 });
    }
  };

  try {
    await runMigrations({
      url,
      installPgBoss: options.pgBoss ?? false,
      roles: { ...NO_ROLES, ...options.roles },
      log: () => undefined,
    });
  } catch (error) {
    await dropDatabase();
    throw error;
  }

  const handle = createDb({ url, max: options.max ?? 3, applicationName: options.applicationName ?? 'financialos-test' });
  const close = async () => {
    await handle.close();
    await dropDatabase();
  };
  return { name, url, db: handle.db, sql: handle.sql, close, drop: close };
}

/** Drops leftover `fos_it_*` databases created more than `olderThanMinutes` ago (crashed test runs). */
export async function dropStaleTestDatabases(options: { baseUrl?: string; olderThanMinutes?: number } = {}): Promise<string[]> {
  const baseUrl = options.baseUrl ?? process.env.FOS_TEST_DATABASE_URL;
  assertTestDatabaseUrl(baseUrl);
  const cutoff = Date.now() / 1000 - (options.olderThanMinutes ?? 60) * 60;
  const sql = postgres(baseUrl as string, { max: 1, onnotice: () => undefined });
  const dropped: string[] = [];
  try {
    const rows = await sql<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname LIKE ${`${TEST_DATABASE_PREFIX}%`}`;
    for (const { datname } of rows) {
      const match = /^fos_it_([0-9a-z]+)_[0-9a-f]+$/.exec(datname);
      if (!match?.[1]) continue;
      const createdAt = Number.parseInt(match[1], 36);
      if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;
      assertTestDatabaseName(datname);
      await sql.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
      dropped.push(datname);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return dropped;
}
