import type { ExtEnv } from './env';

export type HttpOutcome =
  { kind: 'response'; status: number; body: unknown } | { kind: 'network' } | { kind: 'timeout' };

export const MAX_RESPONSE_CHARS = 64_000;

export interface JsonRequest {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

/**
 * One bounded JSON request. Cookies are never sent (`credentials: 'omit'`), responses are never
 * cached, redirects are refused so a credential cannot follow a redirect elsewhere, and the whole
 * exchange (including reading the body) is abandoned after `timeoutMs`.
 */
export async function requestJson(env: ExtEnv, url: string, request: JsonRequest): Promise<HttpOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: 'application/json', ...request.headers };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await env.fetch(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = undefined;
    const contentType = response.headers.get('content-type') ?? '';
    if (text.length <= MAX_RESPONSE_CHARS && /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    return { kind: 'response', status: response.status, body };
  } catch {
    return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
