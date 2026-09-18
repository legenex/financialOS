import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ApiError } from '../errors';

/**
 * In-memory request rate limits (single process). They sit in front of the persistent
 * throttles and lockouts. Route modules opt in with `{ config: { rateLimit: RATE_LIMITS.x } }`.
 */
export const RATE_LIMITS = {
  auth: { max: 30, timeWindow: 60_000 },
  setup: { max: 30, timeWindow: 60_000 },
  launch: { max: 30, timeWindow: 60_000 },
  pairStart: { max: 10, timeWindow: 60_000 },
  pairComplete: { max: 60, timeWindow: 60_000 },
  pairApprove: { max: 20, timeWindow: 60_000 },
  oauth: { max: 30, timeWindow: 60_000 },
  agent: { max: 120, timeWindow: 60_000 },
  glance: { max: 60, timeWindow: 60_000 },
} as const;

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: false,
    addHeadersOnExceeding: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false },
    addHeaders: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false, 'retry-after': true },
    errorResponseBuilder: (_req, ctx) =>
      new ApiError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.', {
        details: { retryAfterSeconds: Math.ceil(ctx.ttl / 1000) },
      }),
  });
}
