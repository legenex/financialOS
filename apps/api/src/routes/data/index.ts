/**
 * Data route modules (owner API for money, plan, business, imports, connections, system...).
 * Each module is `(app) => void` and must register its routes through `registerOwnerRoutes`
 * (see apps/api/README.md). They are registered after the core auth routes.
 */
import type { FastifyInstance } from 'fastify';
import { registerDataProviders } from '../../providers-impl/index';
import { registerBusinessRoutes } from './business';
import { registerCoachRoutes } from './coach';
import { registerConnectionRoutes } from './connections';
import { registerImportRoutes } from './imports';
import { registerInvestingRoutes } from './investing';
import { registerMoneyRoutes } from './money';
import { registerPlanRoutes } from './plan';
import { registerSystemRoutes } from './system';
import { registerTodayRoutes } from './today';

export type RouteModule = (app: FastifyInstance) => void | Promise<void>;

export const dataRouteModules: RouteModule[] = [
  // Providers first: the extension, agent and MCP handlers resolve them at call time.
  registerDataProviders,
  registerTodayRoutes,
  registerMoneyRoutes,
  registerImportRoutes,
  registerPlanRoutes,
  registerBusinessRoutes,
  registerCoachRoutes,
  registerConnectionRoutes,
  registerSystemRoutes,
  registerInvestingRoutes,
];
