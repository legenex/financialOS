import { DbConfigError, parseDatabaseUrl, type ParsedDatabaseUrl } from './client';

/** The isolated test database server (deploy/scripts/test-db.sh). */
export const TEST_DATABASE_PORT = 55432;
export const TEST_DATABASE_PREFIX = 'fos_it_';
export const PRODUCTION_DATABASE_NAME = 'financialos';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Refuses anything that does not look like the isolated test database: a loopback host,
 * port 55432, and a database named `*_test` or `fos_it_*`.
 */
export function assertTestDatabaseUrl(url: string | undefined): ParsedDatabaseUrl {
  if (!url) {
    throw new DbConfigError('FOS_TEST_DATABASE_URL is not set. Start the test database with deploy/scripts/test-db.sh up.');
  }
  const parsed = parseDatabaseUrl(url);
  if (!LOOPBACK_HOSTS.has(parsed.host)) {
    throw new DbConfigError('Refusing to use a test database that is not on a loopback host');
  }
  if (parsed.port !== TEST_DATABASE_PORT) {
    throw new DbConfigError(`Refusing to use a test database that is not on port ${TEST_DATABASE_PORT}`);
  }
  assertTestDatabaseName(parsed.database);
  return parsed;
}

export function assertTestDatabaseName(name: string): void {
  const ok =
    name !== PRODUCTION_DATABASE_NAME &&
    (name.endsWith('_test') || (name.startsWith(TEST_DATABASE_PREFIX) && /^[a-z0-9_]+$/.test(name)));
  if (!ok) {
    throw new DbConfigError(`Refusing to use database "${name}": test databases end in _test or start with ${TEST_DATABASE_PREFIX}`);
  }
}
