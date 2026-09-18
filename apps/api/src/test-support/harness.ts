/**
 * Integration harness: a real Fastify app on a disposable test database, a controllable clock,
 * and a cookie-aware client. Nothing here is reachable from production code.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DestinationStream, Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { Database } from '@financialos/db';
import { createTestDatabase, type TestDatabase } from '@financialos/db/testing';
import { Keyring, generateKeyringFile } from '@financialos/security/crypto';
import { sha256Hex } from '@financialos/security/tokens';
import { buildApp, type AppDeps } from '../app';
import { parseRuntimeConfig, type RuntimeConfig } from '../config';
import type { JobEnqueuer, ReadinessCheck } from '../context';
import { createLogger } from '../logger';
import type { McpToolRegistry } from '../mcp/registry';
import type { AppProviders } from '../providers';
import type { RouteModule } from '../routes/data/index';
import { TestClock } from './clock';

// https: so the harness exercises the same Secure/`__Host-` session-cookie path as production (see
// auth/sessions.ts sessionCookieName) even though app.inject() never opens a real TLS connection.
export const TEST_ORIGIN = 'https://localhost:3180';
export const TEST_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const TEST_EXTENSION_ORIGIN = `chrome-extension://${TEST_EXTENSION_ID}`;
export const TEST_BOOTSTRAP_SECRET = 'bootstrap-secret-for-tests-0123456789abcdef0123456789abcdef';
export const TEST_PASSWORD = 'plum-harbour-tangent-vessel-71';
export const TEST_OWNER_NAME = 'Example Owner';
/** 32+ characters of synthetic high-entropy-looking material. */
export const TEST_PEPPER = 'test-pepper-0123456789abcdef-ABCDEFGH';

export interface HarnessOptions {
  /** `null` means no bootstrap secret file exists on the host. */
  bootstrapSecret?: string | null;
  providers?: Partial<AppProviders>;
  mcpTools?: McpToolRegistry;
  jobs?: JobEnqueuer;
  readinessChecks?: ReadinessCheck[];
  routeModules?: RouteModule[];
  /** Extra config overrides merged into the test runtime config before parsing. */
  config?: Record<string, unknown>;
  /** Capture logs: pass a pino destination stream. */
  logDestination?: DestinationStream;
  logLevel?: string;
  /** Write an index.html into the web dist dir (default true). */
  webBuild?: boolean;
  /** Write a stub extension package (default true). */
  extensionPackage?: boolean;
  clockStart?: string | Date | number;
}

export interface Harness {
  app: FastifyInstance;
  clock: TestClock;
  db: Database;
  testDb: TestDatabase;
  config: RuntimeConfig;
  keyring: Keyring;
  pepper: Buffer;
  bootstrapSecret: string;
  dir: string;
  webDistDir: string;
  extensionPackagePath: string;
  logger: Logger;
  close(): Promise<void>;
}

function testRuntimeConfig(dir: string, databaseUrl: string, overrides: Record<string, unknown> = {}): RuntimeConfig {
  return parseRuntimeConfig({
    environment: 'test',
    listen: { host: '127.0.0.1', port: 3180 },
    canonicalOrigin: TEST_ORIGIN,
    allowedOrigins: [TEST_ORIGIN],
    // Lets tests present a client address through X-Forwarded-For (throttling is per client).
    trustedProxyCidrs: ['127.0.0.1/32'],
    rpName: 'FinancialOS Test',
    webDistDir: join(dir, 'web'),
    extensionPackagePath: join(dir, 'extension.zip'),
    allowedExtensionIds: [TEST_EXTENSION_ID],
    keyringPath: join(dir, 'keyring.json'),
    sessionPepperPath: join(dir, 'pepper'),
    bootstrapHashPath: join(dir, 'bootstrap.hash'),
    database: { url: databaseUrl },
    documentsDir: join(dir, 'documents'),
    logLevel: 'silent',
    publicBaseForOAuthCallbacks: TEST_ORIGIN,
    ...overrides,
  });
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'fos-api-test-'));
  const webDistDir = join(dir, 'web');
  const extensionPackagePath = join(dir, 'extension.zip');
  const testDb = await createTestDatabase({ applicationName: 'financialos-api-test' });
  let app: FastifyInstance | null = null;
  try {
    mkdirSync(webDistDir, { recursive: true });
    mkdirSync(join(dir, 'documents'), { recursive: true });
    if (options.webBuild !== false) {
      writeFileSync(
        join(webDistDir, 'index.html'),
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FinancialOS</title></head><body><div id="root"></div></body></html>',
      );
      mkdirSync(join(webDistDir, 'assets'), { recursive: true });
      writeFileSync(join(webDistDir, 'assets', 'app-abcdef12.js'), 'export const ok = true;\n');
      writeFileSync(join(webDistDir, 'sw.js'), '// service worker\n');
    }
    if (options.extensionPackage !== false) writeFileSync(extensionPackagePath, Buffer.alloc(64, 7));

    const config = testRuntimeConfig(dir, testDb.url, options.config);
    const keyring = new Keyring(generateKeyringFile());
    const pepper = Buffer.from(TEST_PEPPER, 'utf8');
    const bootstrapSecret = options.bootstrapSecret ?? TEST_BOOTSTRAP_SECRET;
    const bootstrapHash = options.bootstrapSecret === null ? null : sha256Hex(bootstrapSecret);
    const clock = new TestClock(options.clockStart);
    const logger = createLogger(options.logLevel ?? (options.logDestination ? 'info' : 'silent'), options.logDestination);

    const deps: AppDeps = {
      config,
      db: testDb.db,
      keyring,
      sessionPepper: pepper,
      bootstrapHash,
      clock,
      logger,
      ...(options.jobs ? { jobs: options.jobs } : {}),
      ...(options.providers ? { providers: options.providers } : {}),
      ...(options.mcpTools ? { mcpTools: options.mcpTools } : {}),
      ...(options.readinessChecks ? { readinessChecks: options.readinessChecks } : {}),
      ...(options.routeModules ? { routeModules: options.routeModules } : {}),
    };
    app = await buildApp(deps);
    await app.ready();
    const instance = app;

    return {
      app: instance,
      clock,
      db: testDb.db,
      testDb,
      config,
      keyring,
      pepper,
      bootstrapSecret,
      dir,
      webDistDir,
      extensionPackagePath,
      logger,
      async close() {
        await instance.close();
        await testDb.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    if (app) await app.close().catch(() => undefined);
    await testDb.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Resets every authentication table back to a fresh install (setup awaiting the bootstrap
 * secret). Test-only: it talks to the database directly, never through the app.
 */
export async function resetAuthState(harness: Harness, bootstrapSecret: string | null = harness.bootstrapSecret): Promise<void> {
  const hash = bootstrapSecret === null ? null : sha256Hex(bootstrapSecret);
  await harness.db.execute(sql`
    truncate table sessions, recovery_codes, webauthn_credentials, webauthn_challenges,
      launch_requests, login_throttle, device_pairings, devices, agent_clients, owner_account cascade`);
  await harness.db.execute(sql`
    update setup_state set
      state = 'awaiting_bootstrap_secret',
      bootstrap_secret_hash = ${hash},
      bootstrap_consumed_at = null,
      setup_token_hash = null,
      setup_token_expires_at = null,
      owner_created_at = null,
      totp_verified_at = null,
      recovery_codes_issued_at = null,
      passkey_enrolled_at = null,
      sealed_at = null,
      failed_attempts = 0,
      locked_until = null
    where id = 1`);
}

/** Clears persistent login/re-auth lockouts without touching any security logic. */
export async function clearThrottles(harness: Harness): Promise<void> {
  await harness.db.execute(sql`truncate table login_throttle`);
}
