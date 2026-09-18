import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Database } from '@financialos/db';
import type { Keyring } from '@financialos/security/crypto';
import { randomToken } from '@financialos/security/tokens';
import { systemClock, type Clock } from './clock';
import { extensionOrigins, type RuntimeConfig } from './config';
import { unavailableJobEnqueuer, type AppContext, type JobEnqueuer, type ReadinessCheck } from './context';
import { createLogger } from './logger';
import { resolveProviders, type AppProviders } from './providers';
import { AuditService } from './auth/audit';
import { registerLaunchRoutes } from './auth/launch';
import { registerLoginRoutes } from './auth/login';
import { hashPassword } from './auth/passwords';
import { registerSecuritySettingsRoutes } from './auth/security-settings';
import { SessionService } from './auth/sessions';
import { registerSetupRoutes } from './auth/setup';
import { DbSettingsStore, ensureSetupState } from './auth/store';
import { ThrottleService } from './auth/throttle';
import { WebAuthnService } from './auth/webauthn';
import { McpToolRegistry } from './mcp/registry';
import { registerMcpRoutes } from './mcp/server';
import { createDefaultToolRegistry } from './mcp/tools';
import { registerErrorHandling } from './plugins/errors';
import { registerOriginGuard } from './plugins/origin';
import { registerRateLimit } from './plugins/rate-limit';
import { registerSecurityHeaders } from './plugins/security-headers';
import { registerStatic } from './plugins/static';
import { registerAgentRoutes } from './routes/agent';
import { dataRouteModules, type RouteModule } from './routes/data/index';
import { registerExtensionRoutes } from './routes/extension';
import { registerHealthRoutes } from './routes/health';

export interface AppDeps {
  config: RuntimeConfig;
  db: Database;
  keyring: Keyring;
  /** Secret for CSRF tokens and keyed hashes (from sessionPepperPath). */
  sessionPepper: Buffer;
  /** SHA-256 hex of the bootstrap secret, or null when no secret file exists. */
  bootstrapHash: string | null;
  clock?: Clock;
  /** A pino logger. Defaults to one built from config.logLevel with redaction. */
  logger?: Logger;
  jobs?: JobEnqueuer;
  providers?: Partial<AppProviders>;
  mcpTools?: McpToolRegistry;
  readinessChecks?: ReadinessCheck[];
  /** Extra route modules, registered after the core and data routes. */
  routeModules?: RouteModule[];
}

/** Builds the HTTP application. Used by main.ts and by tests (with a fake clock and test database). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  if (deps.sessionPepper.length < 32) throw new Error('session pepper is too short');
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? createLogger(config.logLevel);

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: config.trustedProxyCidrs.length > 0 ? config.trustedProxyCidrs : false,
    bodyLimit: config.bodyLimitBytes,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });

  const settings = new DbSettingsStore(db, clock);
  const ctx: AppContext = {
    config,
    db,
    clock,
    keyring: deps.keyring,
    pepper: deps.sessionPepper,
    jobs: deps.jobs ?? unavailableJobEnqueuer,
    providers: resolveProviders(deps.providers),
    mcpTools: deps.mcpTools ?? createDefaultToolRegistry(),
    audit: new AuditService(db, clock, deps.sessionPepper),
    sessions: new SessionService(db, clock, deps.sessionPepper, settings, new URL(config.canonicalOrigin).protocol === 'https:'),
    throttle: new ThrottleService(db, clock),
    settings,
    webauthn: new WebAuthnService(db, clock, config.rpName),
    extensionOrigins: extensionOrigins(config),
    // Used to equalise sign-in timing when no owner exists; never matches any input.
    dummyPasswordHash: await hashPassword(randomToken(32)),
  };
  app.decorate('fos', ctx);
  app.decorateRequest('session', null);
  app.decorateRequest('agent', null);
  app.decorateRequest('device', null);

  // Plain-text bodies are refused: they allow simple cross-site POSTs.
  app.removeContentTypeParser('text/plain');

  registerErrorHandling(app);
  registerSecurityHeaders(app);
  await app.register(cookie, { hook: 'onRequest' });
  await registerRateLimit(app);
  registerOriginGuard(app);

  await ensureSetupState(db, clock, deps.bootstrapHash);

  registerHealthRoutes(app, deps.readinessChecks ?? []);
  registerSetupRoutes(app);
  registerLoginRoutes(app);
  registerLaunchRoutes(app);
  registerSecuritySettingsRoutes(app);
  registerExtensionRoutes(app);
  registerAgentRoutes(app);
  registerMcpRoutes(app);
  for (const register of [...dataRouteModules, ...(deps.routeModules ?? [])]) {
    await register(app);
  }
  await registerStatic(app);
  return app;
}

export { McpToolRegistry };
