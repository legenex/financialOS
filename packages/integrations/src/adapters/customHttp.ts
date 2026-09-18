import { CustomHttpSourceConfig } from '@financialos/contracts';
import { toLocalDate } from '@financialos/domain';
import { configString, type AdapterContext } from '../core/context';
import { InvalidConfigError, ProviderResponseError } from '../core/errors';
import { DOTTED_PATH, getPath, isRecord, str, toDecimal } from '../core/json';
import type { NormalizedTransaction } from '../core/records';
import { createJsonClient, inertText, type JsonClient } from './http';
import type { ConnectionTestResult, FetchTransactionsOptions, ProviderAdapter, TransactionPage } from './types';

/**
 * Executes an owner-defined HTTP source declaratively.
 *
 * The configuration is data, never code: paths are dotted field names resolved with `getPath` (no wildcards,
 * no filters, no expression language, no `eval`), the request is always a GET through safeFetch, and every
 * page is bounded by byte and page caps. A source can therefore describe where its fields are, but never how
 * to compute them.
 */

export const CUSTOM_HTTP_LIMITS = {
  maxBytesPerPage: 4 * 1024 * 1024,
  maxRowsPerPage: 5_000,
  maxTotalRows: 100_000,
  maxPages: 500,
  previewMaxRows: 50,
} as const;

export type CustomHttpConfig = CustomHttpSourceConfig;

function requirePath(value: string, field: string): string {
  if (value === '') throw new InvalidConfigError(`${field} must name a field`);
  if (!DOTTED_PATH.test(value)) {
    throw new InvalidConfigError(`${field} must be a dotted field path such as "data.items" — wildcards, filters, and expressions are not supported`);
  }
  return value;
}

/** Validates the stored configuration with the shared contract schema plus the dotted-path restrictions. */
export function parseCustomHttpConfig(raw: unknown): CustomHttpConfig {
  const parsed = CustomHttpSourceConfig.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new InvalidConfigError(`The custom HTTP source configuration is not valid${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
  }
  const config = parsed.data;
  if (config.recordsPath !== '') requirePath(config.recordsPath, 'recordsPath');
  requirePath(config.fieldMap.id, 'fieldMap.id');
  requirePath(config.fieldMap.date, 'fieldMap.date');
  requirePath(config.fieldMap.amount, 'fieldMap.amount');
  requirePath(config.fieldMap.description, 'fieldMap.description');
  if (config.fieldMap.currency) requirePath(config.fieldMap.currency, 'fieldMap.currency');
  if (config.fieldMap.status) requirePath(config.fieldMap.status, 'fieldMap.status');
  if (config.pagination.cursorPath) requirePath(config.pagination.cursorPath, 'pagination.cursorPath');
  const { kind, cursorParam, cursorPath, pageParam, pageSize } = config.pagination;
  if (kind === 'cursor' && (!cursorParam || !cursorPath)) {
    throw new InvalidConfigError('Cursor pagination needs both a cursor query parameter and the path the next cursor is read from.');
  }
  if ((kind === 'page' || kind === 'offset') && !pageParam) {
    throw new InvalidConfigError(`${kind} pagination needs the query parameter that carries the ${kind === 'page' ? 'page number' : 'offset'}.`);
  }
  if (kind === 'offset' && !pageSize) throw new InvalidConfigError('Offset pagination needs a page size so the offset can be advanced.');
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new InvalidConfigError('The base URL must be http or https.');
  return config;
}

function authHeaders(config: CustomHttpConfig, token: string | null): Record<string, string> {
  const headers: Record<string, string> = { ...config.extraHeaders };
  if (config.authScheme === 'none' || !config.authHeaderName) return headers;
  if (!token) throw new InvalidConfigError('This source needs a credential, but none is stored.');
  headers[config.authHeaderName.toLowerCase()] = config.authScheme === 'bearer' ? `Bearer ${token}` : token;
  return headers;
}

function customClient(ctx: AdapterContext, config: CustomHttpConfig): JsonClient {
  const token = ctx.credentials.token ?? ctx.credentials.apiToken ?? null;
  const headers = authHeaders(config, token);
  return createJsonClient({
    safeFetch: ctx.safeFetch,
    baseUrl: config.baseUrl,
    headers,
    sensitiveHeaders: config.authHeaderName ? [config.authHeaderName.toLowerCase()] : [],
    secrets: token ? [token] : [],
    logger: ctx.logger,
    signal: ctx.signal,
    providerLabel: 'Custom HTTP source',
    maxResponseBytes: CUSTOM_HTTP_LIMITS.maxBytesPerPage,
    maxAttempts: 3,
  });
}

interface PageState {
  cursor: string | null;
  page: number;
  offset: number;
}

function queryFor(config: CustomHttpConfig, state: PageState, window: { since?: string | null; until?: string | null }): Record<string, string | number | null> {
  const query: Record<string, string | number | null> = {};
  const { kind, cursorParam, pageParam, limitParam, pageSize } = config.pagination;
  if (limitParam && pageSize) query[limitParam] = pageSize;
  if (kind === 'cursor' && cursorParam && state.cursor) query[cursorParam] = state.cursor;
  if (kind === 'page' && pageParam) query[pageParam] = state.page;
  if (kind === 'offset' && pageParam) query[pageParam] = state.offset;
  if (window.since) query.since = window.since;
  if (window.until) query.until = window.until;
  return query;
}

function readRecords(config: CustomHttpConfig, body: unknown): unknown[] {
  const node = config.recordsPath === '' ? body : getPath(body, config.recordsPath);
  if (node === undefined) throw new ProviderResponseError(`The response has no field at "${config.recordsPath}"`);
  if (!Array.isArray(node)) throw new ProviderResponseError(`The field at "${config.recordsPath}" is not an array of records`);
  if (node.length > CUSTOM_HTTP_LIMITS.maxRowsPerPage) {
    throw new ProviderResponseError(`A page returned ${node.length} records; the limit is ${CUSTOM_HTTP_LIMITS.maxRowsPerPage}`);
  }
  return node;
}

function parseDate(value: unknown, timezone: string): string {
  const text = str(value);
  if (!text) throw new ProviderResponseError('A record has no date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const instant = new Date(text);
  if (Number.isNaN(instant.getTime())) throw new ProviderResponseError(`A record date "${inertText(text, 40)}" is not an ISO date or date-time`);
  return toLocalDate(instant, timezone);
}

const PENDING_STATUS = /^(pending|processing|authoris(ed|ation)|authoriz(ed|ation)|hold|reserved|uncleared)$/i;

export interface CustomHttpMapOptions {
  externalAccountId: string;
  currency: string;
  timezone: string;
}

export function mapCustomRecord(record: unknown, config: CustomHttpConfig, options: CustomHttpMapOptions): NormalizedTransaction {
  if (!isRecord(record)) throw new ProviderResponseError('A record is not a JSON object');
  const id = str(getPath(record, config.fieldMap.id));
  if (!id) throw new ProviderResponseError('A record has no id at the configured path');
  const amount = toDecimal(getPath(record, config.fieldMap.amount));
  if (amount === null) throw new ProviderResponseError('A record has no amount at the configured path');
  const bookedOn = parseDate(getPath(record, config.fieldMap.date), options.timezone);
  const currency = (config.fieldMap.currency ? str(getPath(record, config.fieldMap.currency)) : null) ?? options.currency;
  if (!/^[A-Z0-9]{2,10}$/.test(currency.toUpperCase())) throw new ProviderResponseError(`A record has an unusable currency code "${inertText(currency, 12)}"`);
  const status = config.fieldMap.status ? str(getPath(record, config.fieldMap.status)) : null;
  return {
    externalId: id.slice(0, 200),
    externalAccountId: options.externalAccountId,
    bookedOn,
    valueOn: null,
    sourceTimezone: options.timezone,
    createdAt: null,
    postedAt: null,
    amount: { amount, currency: currency.toUpperCase() },
    description: inertText(getPath(record, config.fieldMap.description), 300) || '(no description)',
    counterparty: null,
    reference: null,
    pending: status !== null && PENDING_STATUS.test(status.trim()),
    providerStatus: status === null ? null : inertText(status, 60) || null,
    movedMoney: true,
    categoryHint: null,
    cardExternalId: null,
    kind: null,
    raw: { id: id.slice(0, 200), status: status === null ? null : inertText(status, 60) },
  };
}

function advance(config: CustomHttpConfig, state: PageState, body: unknown, received: number): { next: PageState | null; cursor: string | null } {
  const { kind, cursorPath, pageSize } = config.pagination;
  if (kind === 'none') return { next: null, cursor: null };
  if (kind === 'cursor') {
    const nextCursor = cursorPath ? str(getPath(body, cursorPath)) : null;
    if (!nextCursor || nextCursor === state.cursor) return { next: null, cursor: null };
    return { next: { ...state, cursor: nextCursor }, cursor: nextCursor };
  }
  if (received === 0) return { next: null, cursor: null };
  if (pageSize && received < pageSize) return { next: null, cursor: null };
  if (kind === 'page') {
    const next = { ...state, page: state.page + 1 };
    return { next, cursor: String(next.page) };
  }
  const next = { ...state, offset: state.offset + (pageSize ?? received) };
  return { next, cursor: String(next.offset) };
}

function initialState(config: CustomHttpConfig, cursor: string | null | undefined): PageState {
  const { kind } = config.pagination;
  if (!cursor) return { cursor: null, page: 1, offset: 0 };
  if (kind === 'cursor') return { cursor, page: 1, offset: 0 };
  if (!/^\d{1,12}$/.test(cursor)) throw new InvalidConfigError('The custom source cursor is not in the expected form.');
  return kind === 'page' ? { cursor: null, page: Number(cursor), offset: 0 } : { cursor: null, page: 1, offset: Number(cursor) };
}

export interface CustomHttpPreview {
  /** Rows that mapped cleanly. */
  rows: NormalizedTransaction[];
  /** Records that did not map, with the reason. */
  problems: Array<{ index: number; message: string }>;
  /** Field names seen on the first record, to help the owner fix a mapping. */
  availableFields: string[];
  pagesFetched: number;
  redactedUrl: string;
}

function fieldNames(record: unknown, prefix = '', depth = 0): string[] {
  if (!isRecord(record) || depth > 2) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(record).slice(0, 80)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    if (isRecord(value)) out.push(...fieldNames(value, path, depth + 1));
  }
  return out;
}

export const customHttpAdapter: ProviderAdapter = {
  key: 'custom_http',
  method: 'custom_http',
  readOnly: true,

  async test(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const preview = await previewCustomHttp(ctx, 5);
    return {
      ok: preview.problems.length === 0,
      detail:
        preview.problems.length === 0
          ? `The source returned ${preview.rows.length} record(s) and every field mapped.`
          : `The source answered, but ${preview.problems.length} record(s) did not map: ${preview.problems[0]!.message}`,
      grantedScopes: [],
      identity: null,
      observations: [`Endpoint: ${preview.redactedUrl}`, `Fields seen: ${preview.availableFields.slice(0, 25).join(', ') || 'none'}`],
    };
  },

  fetchTransactions(ctx: AdapterContext, options: FetchTransactionsOptions): AsyncIterable<TransactionPage> {
    const config = parseCustomHttpConfig(ctx.config.source ?? ctx.config);
    const client = customClient(ctx, config);
    const mapOptions: CustomHttpMapOptions = {
      externalAccountId: configString(ctx, 'externalAccountId') ?? 'custom',
      currency: (configString(ctx, 'currency') ?? 'USD').toUpperCase(),
      timezone: configString(ctx, 'timezone') ?? 'UTC',
    };
    const signal = options.signal ?? ctx.signal;
    const maxPages = Math.min(options.maxPages ?? config.pagination.maxPages, config.pagination.maxPages, CUSTOM_HTTP_LIMITS.maxPages);

    return (async function* generate(): AsyncIterable<TransactionPage> {
      let state = initialState(config, options.cursor);
      let total = 0;
      for (let page = 0; page < maxPages; page += 1) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        const response = await client.get({
          path: config.path,
          query: queryFor(config, state, { since: options.since ?? null, until: options.until ?? null }),
          ...(signal ? { signal } : {}),
        });
        const records = readRecords(config, response.data);
        total += records.length;
        if (total > CUSTOM_HTTP_LIMITS.maxTotalRows) {
          throw new ProviderResponseError(`This source returned more than ${CUSTOM_HTTP_LIMITS.maxTotalRows} records in one run; narrow the date window.`);
        }
        const transactions = records.map((record) => mapCustomRecord(record, config, mapOptions));
        const { next, cursor } = advance(config, state, response.data, records.length);
        const done = next === null;
        yield { transactions, cursor: done ? null : cursor, done };
        if (done) return;
        state = next;
      }
      ctx.logger.warn('custom http page budget reached', { maxPages });
    })();
  },
};

/** Fetches at most `limit` records and reports exactly how each one mapped. Never commits anything. */
export async function previewCustomHttp(ctx: AdapterContext, limit = 10): Promise<CustomHttpPreview> {
  const config = parseCustomHttpConfig(ctx.config.source ?? ctx.config);
  const client = customClient(ctx, config);
  const take = Math.min(Math.max(1, limit), CUSTOM_HTTP_LIMITS.previewMaxRows);
  const mapOptions: CustomHttpMapOptions = {
    externalAccountId: configString(ctx, 'externalAccountId') ?? 'custom',
    currency: (configString(ctx, 'currency') ?? 'USD').toUpperCase(),
    timezone: configString(ctx, 'timezone') ?? 'UTC',
  };
  const rows: NormalizedTransaction[] = [];
  const problems: CustomHttpPreview['problems'] = [];
  let availableFields: string[] = [];
  let state = initialState(config, null);
  let pagesFetched = 0;
  let redactedUrl = client.describe(config.path);
  while (rows.length + problems.length < take && pagesFetched < Math.min(5, config.pagination.maxPages)) {
    const response = await client.get({ path: config.path, query: queryFor(config, state, {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
    redactedUrl = response.redactedUrl;
    pagesFetched += 1;
    const records = readRecords(config, response.data);
    if (availableFields.length === 0 && records[0] !== undefined) availableFields = fieldNames(records[0]);
    for (const [index, record] of records.entries()) {
      if (rows.length + problems.length >= take) break;
      try {
        rows.push(mapCustomRecord(record, config, mapOptions));
      } catch (err) {
        problems.push({ index, message: err instanceof Error ? err.message : 'The record could not be mapped' });
      }
    }
    const { next } = advance(config, state, response.data, records.length);
    if (!next) break;
    state = next;
  }
  return { rows, problems, availableFields, pagesFetched, redactedUrl };
}
