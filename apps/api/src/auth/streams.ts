/**
 * Session-bound streaming: server-sent events and file downloads stop at session expiry.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { securityHeaders } from '@financialos/security/headers';
import { errors } from '../errors';
import { assertSessionStillValid } from './guards';

export const SSE_HEARTBEAT_MS = 15_000;
const EVENT_NAME = /^[a-z][a-z0-9_-]{0,40}$/;

export interface SessionBoundStream {
  /** Re-checks the session, then writes one event. Returns false when the stream is closed. */
  send(event: string, data: unknown, id?: string): Promise<boolean>;
  close(): void;
  readonly closed: boolean;
  onClose(listener: () => void): void;
}

function deadlineOf(req: FastifyRequest): number {
  const s = req.session;
  if (!s) return 0;
  return Math.min(s.absoluteExpiresAt.getTime(), s.idleExpiresAt.getTime());
}

/**
 * Opens an SSE response tied to the owner session. The stream
 * - closes at the absolute or idle deadline (whichever is first) with `event: session-expired`,
 * - re-checks the session before every event and heartbeat (heartbeats are not activity),
 * - never writes anything after expiry.
 */
export async function openSessionBoundStream(
  req: FastifyRequest,
  reply: FastifyReply,
  options: { heartbeatMs?: number } = {},
): Promise<SessionBoundStream> {
  await assertSessionStillValid(req, reply);
  const { clock } = req.server.fos;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': String(req.id),
  });
  res.write(': stream open\n\n');

  let closed = false;
  let cancelDeadline: (() => void) | null = null;
  let cancelHeartbeat: (() => void) | null = null;
  const listeners: Array<() => void> = [];
  let queue: Promise<unknown> = Promise.resolve();

  const finish = () => {
    if (closed) return;
    closed = true;
    cancelDeadline?.();
    cancelHeartbeat?.();
    for (const listener of listeners.splice(0)) {
      try {
        listener();
      } catch (err) {
        req.log.warn({ err }, 'stream close listener failed');
      }
    }
  };

  const expire = () => {
    if (closed) return;
    try {
      res.write('event: session-expired\ndata: {"code":"session_expired"}\n\n');
    } finally {
      finish();
      res.end();
    }
  };

  /** True when the session is still valid right now (database re-check plus local deadline). */
  const stillValid = async (): Promise<boolean> => {
    try {
      await assertSessionStillValid(req);
    } catch {
      return false;
    }
    return clock.now().getTime() < deadlineOf(req);
  };

  const scheduleDeadline = () => {
    cancelDeadline?.();
    const delay = Math.max(0, deadlineOf(req) - clock.now().getTime());
    cancelDeadline = clock.setTimer(delay, () => {
      queue = queue.then(async () => {
        if (closed) return;
        if (await stillValid()) scheduleDeadline();
        else expire();
      });
    });
  };

  const scheduleHeartbeat = () => {
    if (heartbeatMs <= 0) return;
    cancelHeartbeat = clock.setTimer(heartbeatMs, () => {
      queue = queue.then(async () => {
        if (closed) return;
        if (!(await stillValid())) return expire();
        res.write(': heartbeat\n\n');
        scheduleHeartbeat();
      });
    });
  };

  res.on('close', finish);
  scheduleDeadline();
  scheduleHeartbeat();

  return {
    get closed() {
      return closed;
    },
    onClose(listener) {
      if (closed) listener();
      else listeners.push(listener);
    },
    close() {
      if (closed) return;
      finish();
      res.end();
    },
    send(event, data, id) {
      if (!EVENT_NAME.test(event)) return Promise.reject(new Error('invalid SSE event name'));
      const result = queue.then(async () => {
        if (closed) return false;
        if (!(await stillValid())) {
          expire();
          return false;
        }
        if (closed) return false;
        const payload = JSON.stringify(data ?? null);
        const idLine = id && /^[A-Za-z0-9_.:-]{1,64}$/.test(id) ? `id: ${id}\n` : '';
        res.write(`${idLine}event: ${event}\ndata: ${payload}\n\n`);
        scheduleDeadline();
        return true;
      });
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename.slice(0, 200))}`;
}

/**
 * Streams a file to the owner. The session is re-checked immediately before sending, and the
 * transfer is aborted if the session reaches its deadline while bytes are still flowing.
 */
export async function sendSessionBoundDownload(
  req: FastifyRequest,
  reply: FastifyReply,
  options: { stream: Readable; filename: string; contentType: string; size?: number },
): Promise<FastifyReply> {
  try {
    await assertSessionStillValid(req, reply);
  } catch (err) {
    options.stream.destroy();
    throw err;
  }
  const { clock } = req.server.fos;
  let cancel: (() => void) | null = null;
  const arm = () => {
    const delay = Math.max(0, deadlineOf(req) - clock.now().getTime());
    cancel = clock.setTimer(delay, () => {
      void (async () => {
        if (options.stream.destroyed) return;
        try {
          await assertSessionStillValid(req);
          if (clock.now().getTime() < deadlineOf(req)) return arm();
        } catch {
          // fall through: the session is no longer valid
        }
        options.stream.destroy(errors.sessionExpired());
      })();
    });
  };
  arm();
  options.stream.once('close', () => cancel?.());
  reply.header('content-type', options.contentType).header('content-disposition', contentDisposition(options.filename));
  if (options.size !== undefined) reply.header('content-length', String(options.size));
  return reply.send(options.stream);
}
