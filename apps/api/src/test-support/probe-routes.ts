/**
 * Owner routes used only by tests. They are registered through `buildApp({ routeModules })`,
 * exactly like the real data routes, so they run behind the same guards. They are never part of
 * the production route table.
 */
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { registerOwnerRoutes } from '../auth/guards';
import { openSessionBoundStream, sendSessionBoundDownload, type SessionBoundStream } from '../auth/streams';
import type { RouteModule } from '../routes/data/index';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export interface RouteProbe {
  module: RouteModule;
  /** Streams opened so far by `GET /api/test/stream`. */
  readonly streams: SessionBoundStream[];
  /** Download bodies handed to `sendSessionBoundDownload` by `GET /api/test/download`. */
  readonly downloads: PassThrough[];
  /** Resolves with the stream opened by the next (or already pending) request. */
  nextStream(): Promise<SessionBoundStream>;
  nextDownload(): Promise<PassThrough>;
  /** How many times `GET /api/test/private` was served. */
  readonly privateHits: number;
}

export function createRouteProbe(): RouteProbe {
  const streams: SessionBoundStream[] = [];
  const downloads: PassThrough[] = [];
  const streamWaiters: Array<Deferred<SessionBoundStream>> = [];
  const downloadWaiters: Array<Deferred<PassThrough>> = [];
  let taken = 0;
  let downloadsTaken = 0;
  let privateHits = 0;

  const module: RouteModule = (app: FastifyInstance) => {
    registerOwnerRoutes(app, (scope) => {
      scope.get('/api/test/private', async () => {
        privateHits += 1;
        return { ok: true, secret: 'owner-only-payload' };
      });

      scope.post('/api/test/mutate', async () => ({ mutated: true }));

      scope.get('/api/test/stream', async (req, reply) => {
        const stream = await openSessionBoundStream(req, reply, { heartbeatMs: 0 });
        streams.push(stream);
        const waiter = streamWaiters.shift();
        if (waiter) {
          taken += 1;
          waiter.resolve(stream);
        }
        return reply;
      });

      scope.get('/api/test/download', async (req, reply) => {
        const body = new PassThrough();
        downloads.push(body);
        const waiter = downloadWaiters.shift();
        if (waiter) {
          downloadsTaken += 1;
          waiter.resolve(body);
        }
        return sendSessionBoundDownload(req, reply, { stream: body, filename: 'statement.txt', contentType: 'text/plain' });
      });
    });
  };

  return {
    module,
    streams,
    downloads,
    nextStream() {
      if (taken < streams.length) {
        const stream = streams[taken] as SessionBoundStream;
        taken += 1;
        return Promise.resolve(stream);
      }
      const waiter = deferred<SessionBoundStream>();
      streamWaiters.push(waiter);
      return waiter.promise;
    },
    nextDownload() {
      if (downloadsTaken < downloads.length) {
        const body = downloads[downloadsTaken] as PassThrough;
        downloadsTaken += 1;
        return Promise.resolve(body);
      }
      const waiter = deferred<PassThrough>();
      downloadWaiters.push(waiter);
      return waiter.promise;
    },
    get privateHits() {
      return privateHits;
    },
  };
}
