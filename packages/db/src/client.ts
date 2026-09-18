import { readFileSync, statSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;
/** A transaction handle as passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Repositories accept either the root database or an open transaction. */
export type DbOrTx = Database | Tx;

export interface CreateDbOptions {
  /** postgres:// URL. Prefer a URL without a password plus `password` read from a file. */
  url: string;
  /** Password supplied out of band (for example from `readSecretFile`). Overrides any password in the URL. */
  password?: string;
  /** Reported in pg_stat_activity, e.g. `financialos-api`. */
  applicationName?: string;
  /** Pool size. Small by default: the host is shared. */
  max?: number;
  /** Server-side statement_timeout in milliseconds. 0 disables it. Default 30 000. */
  statementTimeoutMs?: number;
  /** Close idle connections after this many seconds. Default 60. */
  idleTimeoutSeconds?: number;
  /** Connection attempt timeout in seconds. Default 10. */
  connectTimeoutSeconds?: number;
  /**
   * Use named prepared statements. Off by default so a migration that changes a table
   * shape can never break cached plans in a running process, and so the client stays
   * compatible with transaction-pooling proxies.
   */
  prepare?: boolean;
  /** Log server notices (for example from migrations) instead of dropping them. */
  onNotice?: (notice: postgres.Notice) => void;
}

export interface DbHandle {
  db: Database;
  /** The underlying postgres-js client, for raw SQL and advisory locks. */
  sql: postgres.Sql;
  close(): Promise<void>;
}

export const DEFAULT_POOL_MAX = 5;

export function createDb(options: CreateDbOptions): DbHandle {
  const sql = createSqlClient(options);
  const db = drizzle({ client: sql, schema });
  let closed = false;
  return {
    db,
    sql,
    async close() {
      if (closed) return;
      closed = true;
      await sql.end({ timeout: 5 });
    },
  };
}

export function createSqlClient(options: CreateDbOptions): postgres.Sql {
  const statementTimeout = options.statementTimeoutMs ?? 30_000;
  if (!Number.isInteger(statementTimeout) || statementTimeout < 0) {
    throw new Error('statementTimeoutMs must be a non-negative integer');
  }
  const max = options.max ?? DEFAULT_POOL_MAX;
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error('max must be an integer between 1 and 50');
  const connectionParams: Record<string, string> = {
    application_name: options.applicationName ?? 'financialos',
    statement_timeout: String(statementTimeout),
    TimeZone: 'UTC',
  };
  return postgres(options.url, {
    max,
    idle_timeout: options.idleTimeoutSeconds ?? 60,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    prepare: options.prepare ?? false,
    ...(options.password !== undefined ? { password: options.password } : {}),
    onnotice: options.onNotice ?? (() => undefined),
    connection: connectionParams,
  });
}

// ---------------------------------------------------------------------------
// Connection configuration helpers. Secrets are read from files, never from env values.
// ---------------------------------------------------------------------------

export class DbConfigError extends Error {
  override name = 'DbConfigError';
}

/**
 * Reads a secret from a file (for example a Docker secret). Trailing newlines are
 * removed. Refuses empty files and files readable by other users.
 */
export function readSecretFile(path: string): string {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new DbConfigError(`Secret file is not readable: ${path}`);
  }
  if ((mode & 0o007) !== 0) {
    throw new DbConfigError(`Secret file must not be accessible to other users: ${path}`);
  }
  const value = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '');
  if (value.length === 0) throw new DbConfigError(`Secret file is empty: ${path}`);
  return value;
}

export interface ResolveDbConfigOptions {
  /** Env var holding the URL without a password. Default `FOS_DATABASE_URL`. */
  urlEnv?: string;
  /** Env vars holding a password file path, tried in order. Default `['FOS_DB_PASSWORD_FILE']`. */
  passwordFileEnv?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedDbConfig {
  url: string;
  password: string | undefined;
  /** URL with any password removed, safe for logs. */
  redactedUrl: string;
  database: string;
}

/**
 * Resolves a database URL from the environment plus a password from a file.
 * A password embedded in the URL is only accepted when FOS_ENVIRONMENT is
 * `test` or `development`.
 */
export function resolveDatabaseConfig(options: ResolveDbConfigOptions = {}): ResolvedDbConfig {
  const env = options.env ?? process.env;
  const urlEnv = options.urlEnv ?? 'FOS_DATABASE_URL';
  const raw = env[urlEnv];
  if (!raw) throw new DbConfigError(`${urlEnv} is not set`);
  const parsed = parseDatabaseUrl(raw);
  const fileVars = options.passwordFileEnv ?? ['FOS_DB_PASSWORD_FILE'];
  const fileVar = fileVars.find((name) => Boolean(env[name]));
  let password: string | undefined;
  if (fileVar) {
    password = readSecretFile(env[fileVar] as string);
  } else if (parsed.password) {
    const environment = env.FOS_ENVIRONMENT;
    if (environment !== 'test' && environment !== 'development') {
      throw new DbConfigError(
        `${urlEnv} contains a password. Put the password in a file and set ${fileVars[0] ?? 'FOS_DB_PASSWORD_FILE'}.`,
      );
    }
  }
  return { url: raw, password, redactedUrl: redactDatabaseUrl(raw), database: parsed.database };
}

export interface ParsedDatabaseUrl {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DbConfigError('Database URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new DbConfigError('Database URL must use the postgres:// scheme');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new DbConfigError('Database URL must name a database');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export function redactDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<invalid database url>';
  }
}

/** Returns a copy of `raw` pointing at another database on the same server. */
export function withDatabase(raw: string, database: string): string {
  const url = new URL(raw);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/**
 * Returns a copy of `raw` with `password` embedded. Needed before handing a URL to `pg` (used by
 * pg-boss): `pg`'s ConnectionParameters re-parses a `connectionString` option and overwrites any
 * separately-supplied `password` field with whatever the string itself specifies, which for a
 * password-less URL is `undefined` — silently discarding a correct password passed alongside it.
 * Embedding the password in the string itself sidesteps that.
 */
export function withPassword(raw: string, password: string | undefined): string {
  if (password === undefined) return raw;
  const url = new URL(raw);
  url.password = password;
  return url.toString();
}
