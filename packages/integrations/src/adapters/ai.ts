import type { SafeFetch, SafeResponse } from '@financialos/security/net';
import type { AdapterLogger } from '../core/context';
import {
  CredentialExpiredError,
  CredentialMissingError,
  IntegrationError,
  InvalidConfigError,
  OperationTimeoutError,
  ProviderRateLimitedError,
  ProviderRequestError,
  ProviderResponseError,
  ProviderUnavailableError,
} from '../core/errors';
import { isRecord, str, toInteger } from '../core/json';
import { redactUrl } from '../core/redact';
import { inertText } from './http';

/**
 * Model clients for the two API shapes FinancialOS supports: OpenAI-compatible chat completions (which covers
 * a local gateway as well as a cloud vendor) and the Anthropic Messages API.
 *
 * Privacy gating is the caller's responsibility, not this module's. These clients send exactly the messages
 * they are given. Deciding whether a prompt may contain identifiable financial data, whether the destination
 * is local or cloud, and whether the owner has allowed that combination happens in the worker before a call
 * is made; `AiProvider.allowIdentifiableData` and `AiProvider.locality` are the fields that decision reads.
 *
 * Verified on 2026-09-18:
 *   OpenAI     https://github.com/openai/openai-openapi (official spec): `POST {base}/chat/completions`,
 *              `Authorization: Bearer`, SSE data-only stream terminated by `data: [DONE]`, delta at
 *              `choices[0].delta.content`, `stream_options.include_usage` adds a final usage-only chunk,
 *              non-stream `usage` = { prompt_tokens, completion_tokens, total_tokens }; `GET {base}/models`
 *              returns { object: "list", data: [{ id, object, created, owned_by }] }. `max_tokens` is
 *              deprecated in favour of `max_completion_tokens`.
 *   Anthropic  https://platform.claude.com/docs/en/api/messages and .../api/versioning: `POST
 *              https://api.anthropic.com/v1/messages`, headers `x-api-key` and `anthropic-version:
 *              2023-06-01` (the current documented version), `max_tokens` is required, response content is
 *              [{ type: "text", text }], usage = { input_tokens, output_tokens, ... }, SSE events
 *              message_start / content_block_start / content_block_delta / content_block_stop /
 *              message_delta / message_stop / ping / error. `GET /v1/models` lists available models.
 */

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const AI_DEFAULT_TIMEOUT_MS = 120_000;
export const AI_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
  model: string | null;
  stopReason: string | null;
  /** Wall-clock milliseconds the request took. */
  durationMs: number;
}

export interface ChatRequest {
  /** Always supplied by the caller. There is no default model: a stale hardcoded id would be a lie. */
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number | null;
  /** Receives text as it arrives. Its presence turns on streaming. */
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ModelInfo {
  id: string;
  displayName: string | null;
  createdAt: string | null;
}

export interface AiTestResult {
  ok: boolean;
  detail: string;
  models: ModelInfo[];
}

export interface AiClient {
  readonly kind: 'openai_compatible' | 'anthropic';
  readonly baseUrl: string;
  /** Lists models. Used as the connection test, because it proves the credential without spending tokens. */
  listModels(options?: { signal?: AbortSignal }): Promise<ModelInfo[]>;
  test(options?: { signal?: AbortSignal }): Promise<AiTestResult>;
  chat(request: ChatRequest): Promise<ChatResult>;
}

export interface AiClientConfig {
  safeFetch: SafeFetch;
  baseUrl: string;
  apiKey: string;
  logger?: AdapterLogger;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Extra headers, e.g. an organisation id or a gateway route. Credential headers are set by the client. */
  headers?: Record<string, string>;
}

function requireKey(apiKey: string, field: string): string {
  const trimmed = apiKey?.trim() ?? '';
  if (!trimmed) throw new CredentialMissingError(field);
  return trimmed;
}

function normaliseBase(baseUrl: string, label: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new InvalidConfigError(`The ${label} base URL is not a valid absolute URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new InvalidConfigError(`The ${label} base URL must be http or https.`);
  return url.href.replace(/\/+$/, '');
}

function mapStatus(label: string, response: { status: number; retryAfterMs: number | null }, redacted: string): IntegrationError {
  if (response.status === 401 || response.status === 403) return new CredentialExpiredError(`${label} rejected the API key (HTTP ${response.status}).`);
  if (response.status === 429) return new ProviderRateLimitedError(`${label} rate-limited the request (HTTP 429) at ${redacted}`, response.retryAfterMs);
  if (response.status >= 500) return new ProviderUnavailableError(`${label} returned HTTP ${response.status} at ${redacted}`);
  return new ProviderRequestError(`${label} returned HTTP ${response.status} at ${redacted}`, response.status);
}

async function post(config: AiClientConfig, label: string, path: string, headers: Record<string, string>, payload: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<SafeResponse> {
  const url = `${normaliseBase(config.baseUrl, label)}${path}`;
  const redacted = redactUrl(url);
  let response: SafeResponse;
  try {
    // Inference is a POST by API design. It is not a financial action: no adapter method here can move money.
    response = await config.safeFetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...config.headers, ...headers },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
      totalTimeoutMs: timeoutMs,
      bodyTimeoutMs: timeoutMs,
      headersTimeoutMs: timeoutMs,
      maxResponseBytes: AI_MAX_RESPONSE_BYTES,
      redirect: 'error',
      sensitiveHeaders: ['authorization', 'x-api-key'],
    });
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    const name = err instanceof Error ? err.name : 'Error';
    if (name === 'AbortError') throw err;
    if (name === 'TimeoutError') throw new OperationTimeoutError(`${label} did not answer within ${Math.round(timeoutMs / 1000)} s`);
    throw new ProviderUnavailableError(`${label} could not be reached (${name}) at ${redacted}`, err);
  }
  if (!response.ok) {
    await response.cancel();
    throw mapStatus(label, response, redacted);
  }
  return response;
}

async function getJson(config: AiClientConfig, label: string, path: string, headers: Record<string, string>, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
  const url = `${normaliseBase(config.baseUrl, label)}${path}`;
  const redacted = redactUrl(url);
  let response: SafeResponse;
  try {
    response = await config.safeFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...config.headers, ...headers },
      ...(signal ? { signal } : {}),
      totalTimeoutMs: timeoutMs,
      maxResponseBytes: 4 * 1024 * 1024,
      redirect: 'follow',
      sensitiveHeaders: ['authorization', 'x-api-key'],
      retry: { maxAttempts: 2, idempotent: true },
    });
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    const name = err instanceof Error ? err.name : 'Error';
    if (name === 'AbortError') throw err;
    throw new ProviderUnavailableError(`${label} could not be reached (${name}) at ${redacted}`, err);
  }
  if (!response.ok) {
    await response.cancel();
    throw mapStatus(label, response, redacted);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderResponseError(`${label} returned a body that is not valid JSON at ${redacted}`);
  }
}

/**
 * Reads a `text/event-stream` body and yields each `data:` payload. Stops on `[DONE]`, honours the abort
 * signal through the underlying stream, and bounds a single event so a server cannot force unbounded memory.
 */
export async function* readSseEvents(response: SafeResponse, maxEventBytes = 1024 * 1024): AsyncIterable<{ event: string | null; data: string }> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > maxEventBytes * 4) throw new ProviderResponseError('The model stream sent an oversized event');
      let index = buffer.search(/\r?\n\r?\n/);
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + (/\r\n\r\n/.test(buffer.slice(index, index + 4)) ? 4 : 2));
        let eventName: string | null = null;
        const dataLines: string[] = [];
        for (const line of chunk.split(/\r?\n/)) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        const data = dataLines.join('\n');
        if (data === '[DONE]') return;
        if (data !== '' || eventName !== null) {
          if (data.length > maxEventBytes) throw new ProviderResponseError('The model stream sent an oversized event');
          yield { event: eventName, data };
        }
        index = buffer.search(/\r?\n\r?\n/);
      }
    }
  } finally {
    reader.releaseLock();
    await response.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------------------------------------

export function openAiCompatibleClient(config: AiClientConfig): AiClient {
  const label = 'The OpenAI-compatible endpoint';
  const apiKey = requireKey(config.apiKey, 'apiKey');
  const baseUrl = normaliseBase(config.baseUrl, label);
  const authHeaders = { authorization: `Bearer ${apiKey}` };
  const defaultTimeout = config.timeoutMs ?? AI_DEFAULT_TIMEOUT_MS;

  return {
    kind: 'openai_compatible',
    baseUrl,
    async listModels(options = {}) {
      const body = await getJson(config, label, '/models', authHeaders, options.signal ?? config.signal, defaultTimeout);
      if (!isRecord(body) || !Array.isArray(body.data)) throw new ProviderResponseError(`${label} did not return a model list`);
      const out: ModelInfo[] = [];
      for (const raw of body.data) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (!id) continue;
        const created = toInteger(raw.created ?? null);
        out.push({ id: inertText(id, 120), displayName: null, createdAt: created === null ? null : new Date(created * 1000).toISOString() });
      }
      return out;
    },
    async test(options = {}) {
      const models = await this.listModels(options);
      return { ok: true, detail: `The endpoint answered and lists ${models.length} model(s).`, models };
    },
    async chat(request) {
      if (!request.model.trim()) throw new InvalidConfigError('A model id is required.');
      if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1) throw new InvalidConfigError('maxTokens must be a positive integer.');
      const started = Date.now();
      const streaming = typeof request.onDelta === 'function';
      const payload: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        max_completion_tokens: request.maxTokens,
      };
      if (typeof request.temperature === 'number') payload.temperature = request.temperature;
      if (streaming) {
        payload.stream = true;
        payload.stream_options = { include_usage: true };
      }
      const timeout = request.timeoutMs ?? defaultTimeout;
      const signal = request.signal ?? config.signal;
      const response = await post(config, label, '/chat/completions', authHeaders, payload, signal, timeout);
      if (!streaming) {
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new ProviderResponseError(`${label} returned a body that is not valid JSON`);
        }
        if (!isRecord(body) || !Array.isArray(body.choices)) throw new ProviderResponseError(`${label} returned no choices`);
        const first = body.choices[0];
        const message = isRecord(first) && isRecord(first.message) ? str(first.message.content) : null;
        const usage = isRecord(body.usage) ? body.usage : null;
        return {
          text: message ?? '',
          usage: {
            inputTokens: usage ? toInteger(usage.prompt_tokens ?? null) : null,
            outputTokens: usage ? toInteger(usage.completion_tokens ?? null) : null,
            totalTokens: usage ? toInteger(usage.total_tokens ?? null) : null,
          },
          model: str(body.model),
          stopReason: isRecord(first) ? str(first.finish_reason) : null,
          durationMs: Date.now() - started,
        };
      }
      let text = '';
      let model: string | null = null;
      let stopReason: string | null = null;
      let usage: ChatUsage = { inputTokens: null, outputTokens: null, totalTokens: null };
      for await (const event of readSseEvents(response)) {
        if (event.data === '') continue;
        let chunk: unknown;
        try {
          chunk = JSON.parse(event.data) as unknown;
        } catch {
          continue;
        }
        if (!isRecord(chunk)) continue;
        model ??= str(chunk.model);
        if (isRecord(chunk.usage)) {
          usage = {
            inputTokens: toInteger(chunk.usage.prompt_tokens ?? null),
            outputTokens: toInteger(chunk.usage.completion_tokens ?? null),
            totalTokens: toInteger(chunk.usage.total_tokens ?? null),
          };
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const choice of choices) {
          if (!isRecord(choice)) continue;
          const finish = str(choice.finish_reason);
          if (finish) stopReason = finish;
          const delta = isRecord(choice.delta) ? str(choice.delta.content) : null;
          if (delta) {
            text += delta;
            request.onDelta?.(delta);
          }
        }
      }
      return { text, usage, model, stopReason, durationMs: Date.now() - started };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------------------------------------

export function anthropicClient(config: AiClientConfig): AiClient {
  const label = 'The Anthropic API';
  const apiKey = requireKey(config.apiKey, 'apiKey');
  const baseUrl = normaliseBase(config.baseUrl || ANTHROPIC_DEFAULT_BASE_URL, label);
  const authHeaders = { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  const defaultTimeout = config.timeoutMs ?? AI_DEFAULT_TIMEOUT_MS;

  return {
    kind: 'anthropic',
    baseUrl,
    async listModels(options = {}) {
      const body = await getJson(config, label, '/v1/models', authHeaders, options.signal ?? config.signal, defaultTimeout);
      if (!isRecord(body) || !Array.isArray(body.data)) throw new ProviderResponseError(`${label} did not return a model list`);
      const out: ModelInfo[] = [];
      for (const raw of body.data) {
        if (!isRecord(raw)) continue;
        const id = str(raw.id);
        if (!id) continue;
        out.push({ id: inertText(id, 120), displayName: inertText(raw.display_name, 120) || null, createdAt: str(raw.created_at) });
      }
      return out;
    },
    async test(options = {}) {
      const models = await this.listModels(options);
      return { ok: true, detail: `The Anthropic API answered and lists ${models.length} model(s).`, models };
    },
    async chat(request) {
      // There is no default model id here on purpose: a hardcoded one goes stale and quietly misroutes work.
      if (!request.model.trim()) throw new InvalidConfigError('A model id is required; the Anthropic client has no default.');
      if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1) throw new InvalidConfigError('maxTokens is required by the Messages API and must be a positive integer.');
      const started = Date.now();
      const streaming = typeof request.onDelta === 'function';
      const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const messages = request.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
      if (messages.length === 0) throw new InvalidConfigError('At least one user or assistant message is required.');
      const payload: Record<string, unknown> = { model: request.model, max_tokens: request.maxTokens, messages };
      if (system) payload.system = system;
      if (typeof request.temperature === 'number') payload.temperature = request.temperature;
      if (streaming) payload.stream = true;
      const timeout = request.timeoutMs ?? defaultTimeout;
      const signal = request.signal ?? config.signal;
      const response = await post(config, label, '/v1/messages', authHeaders, payload, signal, timeout);
      if (!streaming) {
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new ProviderResponseError(`${label} returned a body that is not valid JSON`);
        }
        if (!isRecord(body) || !Array.isArray(body.content)) throw new ProviderResponseError(`${label} returned no content array`);
        let out = '';
        for (const block of body.content) {
          if (isRecord(block) && block.type === 'text') out += str(block.text) ?? '';
        }
        const usage = isRecord(body.usage) ? body.usage : null;
        const inputTokens = usage ? toInteger(usage.input_tokens ?? null) : null;
        const outputTokens = usage ? toInteger(usage.output_tokens ?? null) : null;
        return {
          text: out,
          usage: { inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens },
          model: str(body.model),
          stopReason: str(body.stop_reason),
          durationMs: Date.now() - started,
        };
      }
      let text = '';
      let model: string | null = null;
      let stopReason: string | null = null;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      for await (const event of readSseEvents(response)) {
        if (event.data === '') continue;
        let chunk: unknown;
        try {
          chunk = JSON.parse(event.data) as unknown;
        } catch {
          continue;
        }
        if (!isRecord(chunk)) continue;
        const type = str(chunk.type) ?? event.event;
        if (type === 'error') {
          const message = isRecord(chunk.error) ? inertText(chunk.error.message, 200) : 'unknown error';
          throw new ProviderResponseError(`${label} reported a stream error: ${message}`);
        }
        if (type === 'message_start' && isRecord(chunk.message)) {
          model = str(chunk.message.model);
          if (isRecord(chunk.message.usage)) inputTokens = toInteger(chunk.message.usage.input_tokens ?? null);
        }
        if (type === 'content_block_delta' && isRecord(chunk.delta)) {
          const delta = str(chunk.delta.text);
          if (delta) {
            text += delta;
            request.onDelta?.(delta);
          }
        }
        if (type === 'message_delta') {
          if (isRecord(chunk.delta)) stopReason = str(chunk.delta.stop_reason) ?? stopReason;
          // The Messages API documents message_delta usage counts as cumulative, so the last one wins.
          if (isRecord(chunk.usage)) outputTokens = toInteger(chunk.usage.output_tokens ?? null) ?? outputTokens;
        }
      }
      return {
        text,
        usage: { inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens },
        model,
        stopReason,
        durationMs: Date.now() - started,
      };
    },
  };
}
