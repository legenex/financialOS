import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { HealthStatus } from '@financialos/contracts';
import type { ReadinessCheck, ReadinessResult } from '../context';
import { APP_VERSION } from '../version';

const CHECK_TIMEOUT_MS = 3000;

async function withTimeout(name: string, check: ReadinessCheck): Promise<ReadinessResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check(),
      new Promise<ReadinessResult>((resolve) => {
        timer = setTimeout(() => resolve({ name, ok: false, detail: 'timed out' }), CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return { name, ok: false, detail: 'failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `/healthz`: the process is up. `/readyz`: dependencies are usable. No data, no internals. */
export function registerHealthRoutes(app: FastifyInstance, extraChecks: ReadinessCheck[] = []): void {
  app.get('/healthz', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const body: HealthStatus = { status: 'ok', version: APP_VERSION, checks: [] };
    return body;
  });

  app.get('/readyz', async (req, reply) => {
    const dbCheck: ReadinessCheck = async () => {
      await req.server.fos.db.execute(sql`select 1`);
      return { name: 'database', ok: true, detail: 'reachable' };
    };
    const results = await Promise.all([withTimeout('database', dbCheck), ...extraChecks.map((c, i) => withTimeout(`check_${i}`, c))]);
    const ok = results.every((r) => r.ok);
    const body: HealthStatus = {
      status: ok ? 'ok' : 'down',
      version: APP_VERSION,
      checks: results.map((r) => ({ name: r.name, status: r.ok ? 'ok' : 'down', detail: r.detail.slice(0, 80) })),
    };
    reply.header('cache-control', 'no-store');
    return reply.code(ok ? 200 : 503).send(body);
  });
}
