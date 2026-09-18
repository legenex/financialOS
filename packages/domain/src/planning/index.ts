// Domain-planning public API, mirroring domain-core's index.ts convention.
// explain-local.ts and testing.ts are deliberately not exported (see their own file headers).
// types.ts's `accountLink` is intentionally not re-exported here: it collides with domain-core's
// `accountLink` (../core/explain.ts), which has a different signature and is the package's public one.
export type { PlanningEntity, PlanningAccount, ThirdPartyHolding } from './types';
export { planningAccountFromContract, BUSINESS_ENTITY_KINDS } from './types';
export * from './shared';
export * from './achievements';
export * from './alerts';
export * from './anomalies';
export * from './cashflow';
export * from './budget';
export * from './coach';
export * from './completeness';
export * from './forecast';
export * from './goals';
export * from './interest';
export * from './recurring';
export * from './paperTrading';
export * from './portfolio';
export * from './purchaseImpact';
export * from './restricted';
export * from './rewards';
export * from './runway';
export * from './safeToSpend';
export * from './scenarios';
