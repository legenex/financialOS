import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors';
import { pathOf } from '../auth/guards';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const FASTIFY_CODES: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'payload_too_large', message: 'The request body is too large.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'unsupported_media_type', message: 'Send JSON with Content-Type: application/json.' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { status: 400, code: 'invalid_request', message: 'The request body is not valid.' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'invalid_json', message: 'The request body is empty.' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'invalid_json', message: 'The request body is not valid JSON.' },
  FST_ERR_VALIDATION: { status: 400, code: 'invalid_request', message: 'The request is not valid.' },
};

function wantsHtml(req: FastifyRequest): boolean {
  const path = pathOf(req.url);
  if (path.startsWith('/api/') || path === '/mcp') return false;
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

function htmlPage(status: number, message: string): string {
  const safe = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>FinancialOS</title></head><body><main><h1>${status}</h1><p>${safe}</p><p><a href="/">Open FinancialOS</a></p></main></body></html>`;
}

export function sendError(req: FastifyRequest, reply: FastifyReply, status: number, body: ErrorBody): FastifyReply {
  reply.code(status);
  if (wantsHtml(req)) return reply.type('text/html; charset=utf-8').send(htmlPage(status, body.error.message));
  return reply.type('application/json; charset=utf-8').send(body);
}

/** Uniform `{ error: { code, message } }` responses. No stack traces, SQL, or internal messages. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError | Error, req, reply) => {
    if (err instanceof ApiError) {
      for (const [name, value] of Object.entries(err.headers)) reply.header(name, value);
      if (err.statusCode >= 500) req.log.error({ err }, 'request failed');
      const body: ErrorBody = { error: { code: err.code, message: err.message } };
      if (err.details !== undefined) body.error.details = err.details;
      return sendError(req, reply, err.statusCode, body);
    }
    const code = (err as FastifyError).code;
    const mapped = code ? FASTIFY_CODES[code] : undefined;
    if (mapped) return sendError(req, reply, mapped.status, { error: { code: mapped.code, message: mapped.message } });
    const status = (err as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      req.log.info({ err }, 'client error');
      return sendError(req, reply, status, { error: { code: 'invalid_request', message: 'The request could not be processed.' } });
    }
    req.log.error({ err }, 'unhandled error');
    return sendError(req, reply, 500, { error: { code: 'internal_error', message: 'Something went wrong. Try again later.' } });
  });
}
