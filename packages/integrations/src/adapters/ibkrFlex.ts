import { XMLParser } from 'fast-xml-parser';
import { abortableSleep, configNumber, configString, withRedactedSecrets, type AdapterContext, type AdapterLogger } from '../core/context';
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
import type {
  CoverageInfo,
  NormalizedAccount,
  NormalizedBalance,
  NormalizedCashBalance,
} from '../core/records';
import { parseFlexCsv, parseFlexXml, type FlexParseResult } from '../files/ibkrFlex';
import { createJsonClient, inertText } from './http';
import type {
  ConnectionTestResult,
  FetchBalancesResult,
  FetchHoldingsResult,
  InvestmentTransactionsResult,
  ListAccountsResult,
  ProviderAdapter,
} from './types';

/**
 * Interactive Brokers Flex Web Service adapter.
 *
 * Verified against the official documentation on 2026-09-18:
 *   https://www.ibkrguides.com/clientportal/performanceandstatements/flex3.htm
 *   https://www.interactivebrokers.com/docs/web-api/flex-web-service/introduction
 *   https://www.interactivebrokers.com/docs/web-api/flex-web-service/error-codes
 *
 * The protocol is two GETs: SendRequest returns a reference code, GetStatement returns the report once IBKR
 * has generated it. The documented pacing limit is one request per second and ten per minute per token, and
 * error 1019 ("Statement generation in progress") is the documented signal to try again.
 *
 * The token travels in the query string, so every log line and every error message from this module goes
 * through a redactor that removes it, and URLs are reduced to origin plus path before they are logged.
 */

export const FLEX_BASE_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
export const FLEX_VERSION = '3';
/** IBKR requires a User-Agent header; their examples use a runtime identifier. */
export const FLEX_USER_AGENT = 'FinancialOS/0.1 (Node.js)';
/** Documented pacing: 1 request per second, 10 per minute per token. */
export const FLEX_MIN_REQUEST_INTERVAL_MS = 1_100;
export const FLEX_DEFAULT_MAX_WAIT_MS = 5 * 60_000;
export const FLEX_DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Verbatim Version 3 error codes from the official error-code page (2026-09-18). */
export const FLEX_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  '1001': 'Statement could not be generated at this time. Please try again shortly.',
  '1003': 'Statement is not available.',
  '1004': 'Statement is incomplete at this time. Please try again shortly.',
  '1005': 'Settlement data is not ready at this time. Please try again shortly.',
  '1006': 'FIFO P/L data is not ready at this time. Please try again shortly.',
  '1007': 'MTM P/L data is not ready at this time. Please try again shortly.',
  '1008': 'MTM and FIFO P/L data is not ready at this time. Please try again shortly.',
  '1009': 'The server is under heavy load. Statement could not be generated at this time. Please try again shortly.',
  '1010': 'Legacy Flex Queries are no longer supported. Please convert over to Activity Flex.',
  '1011': 'Service account is inactive.',
  '1012': 'Token has expired.',
  '1013': 'IP restriction.',
  '1014': 'Query is invalid.',
  '1015': 'Token is invalid.',
  '1016': 'Account in invalid.',
  '1017': 'Reference code is invalid.',
  '1018': 'Too many requests have been made from this token. Please try again shortly. Limited to one request per second, 10 requests per minute (per token).',
  '1019': 'Statement generation in progress. Please try again shortly.',
  '1020': 'Invalid request or unable to validate request.',
  '1021': 'Statement could not be retrieved at this time. Please try again shortly.',
};

/** Codes that mean "not ready yet, ask again". */
export const FLEX_RETRYABLE_CODES: ReadonlySet<string> = new Set(['1001', '1004', '1005', '1006', '1007', '1008', '1009', '1019', '1021']);
/** Codes that mean the stored credential must be replaced by the owner. */
export const FLEX_CREDENTIAL_CODES: ReadonlySet<string> = new Set(['1011', '1012', '1013', '1015']);
/** Codes that mean the Flex query configuration is wrong. */
export const FLEX_CONFIG_CODES: ReadonlySet<string> = new Set(['1003', '1010', '1014', '1016', '1017', '1020']);

export class FlexServiceError extends IntegrationError {
  override name = 'FlexServiceError';
  readonly flexCode: string;
  constructor(flexCode: string, message: string, retryable: boolean) {
    super(`flex_${flexCode}`, message, { retryable });
    this.flexCode = flexCode;
  }
}

export interface FlexEnvelope {
  status: 'Success' | 'Fail';
  referenceCode: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

const ENVELOPE_PARSER = new XMLParser({
  ignoreAttributes: true,
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  maxNestedTags: 8,
});

/** Parses the small `<FlexStatementResponse>` envelope. Returns null when the body is not an envelope. */
export function parseFlexEnvelope(text: string): FlexEnvelope | null {
  const head = text.slice(0, 8192);
  if (!/<FlexStatementResponse\b/i.test(head)) return null;
  if (/<!DOCTYPE|<!ENTITY/i.test(head)) throw new ProviderResponseError('The Flex response declares a DOCTYPE or entities, which is not accepted');
  let doc: Record<string, unknown>;
  try {
    doc = ENVELOPE_PARSER.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderResponseError('The Flex service returned a malformed response envelope');
  }
  const body = doc.FlexStatementResponse;
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const asText = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : typeof value === 'number' ? String(value) : null);
  const status = asText(record.Status);
  return {
    status: status === 'Success' ? 'Success' : 'Fail',
    referenceCode: asText(record.ReferenceCode),
    errorCode: asText(record.ErrorCode),
    // The message is provider text: it is reported to the owner as data, never interpreted.
    errorMessage: inertText(asText(record.ErrorMessage) ?? '', 300) || null,
  };
}

function envelopeToError(envelope: FlexEnvelope): IntegrationError {
  const code = envelope.errorCode ?? 'unknown';
  const documented = FLEX_ERROR_MESSAGES[code];
  const message = documented ?? envelope.errorMessage ?? 'The Flex Web Service reported an unspecified failure.';
  if (code === '1018') return new ProviderRateLimitedError(`IBKR Flex error 1018: ${message}`, 6_000);
  if (FLEX_CREDENTIAL_CODES.has(code)) {
    return new CredentialExpiredError(`IBKR Flex error ${code}: ${message} Create a new Flex Web Service token in Client Portal and store it here.`);
  }
  if (FLEX_CONFIG_CODES.has(code)) return new InvalidConfigError(`IBKR Flex error ${code}: ${message}`);
  return new FlexServiceError(code, `IBKR Flex error ${code}: ${message}`, FLEX_RETRYABLE_CODES.has(code));
}

interface FlexCredentials {
  token: string;
  queryId: string;
}

function flexCredentials(ctx: AdapterContext): FlexCredentials {
  const token = (ctx.credentials.flexToken ?? ctx.credentials.token ?? '').trim();
  if (!token) throw new CredentialMissingError('flexToken');
  const queryId = (configString(ctx, 'queryId') ?? ctx.credentials.queryId ?? '').trim();
  if (!queryId) throw new InvalidConfigError('The Flex Query ID is not configured. Copy it from Client Portal > Performance & Reports > Flex Queries.');
  if (!/^\d{1,20}$/.test(queryId)) throw new InvalidConfigError('The Flex Query ID must be the numeric id shown in Client Portal.');
  return { token, queryId };
}

export interface FlexRunOptions {
  /** Longest total time to wait for IBKR to finish generating the statement. */
  maxWaitMs?: number;
  /** Delay between GetStatement attempts while IBKR reports 1019. */
  pollIntervalMs?: number;
  /** yyyymmdd; must be supplied together with `toDate`. */
  fromDate?: string | null;
  toDate?: string | null;
  /** Period in days (max 365). Cannot be combined with fromDate/toDate. */
  periodDays?: number | null;
  signal?: AbortSignal;
}

export interface FlexRunResult {
  referenceCode: string;
  format: 'xml' | 'csv';
  parsed: FlexParseResult;
  attempts: number;
  waitedMs: number;
}

function flexClient(ctx: AdapterContext, token: string, logger: AdapterLogger) {
  return createJsonClient({
    safeFetch: ctx.safeFetch,
    baseUrl: configString(ctx, 'baseUrl') ?? FLEX_BASE_URL,
    headers: { accept: 'application/xml, text/plain, */*', 'user-agent': FLEX_USER_AGENT },
    secrets: [token],
    logger,
    signal: ctx.signal,
    providerLabel: 'IBKR Flex',
    // IBKR statements can be large; the byte cap stays well under the file-import limit.
    maxResponseBytes: 24 * 1024 * 1024,
    totalTimeoutMs: 120_000,
    maxAttempts: 3,
  });
}

/**
 * Runs the documented two-step protocol: SendRequest, then GetStatement with backoff while IBKR answers 1019
 * (or another "try again shortly" code), up to `maxWaitMs`.
 */
export async function runFlexStatement(ctx: AdapterContext, options: FlexRunOptions = {}): Promise<FlexRunResult> {
  const { token, queryId } = flexCredentials(ctx);
  const logger = withRedactedSecrets(ctx.logger, [token]);
  const client = flexClient(ctx, token, logger);
  const signal = options.signal ?? ctx.signal;
  const maxWaitMs = options.maxWaitMs ?? configNumber(ctx, 'maxWaitMs') ?? FLEX_DEFAULT_MAX_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? configNumber(ctx, 'pollIntervalMs') ?? FLEX_DEFAULT_POLL_INTERVAL_MS;
  if (options.periodDays != null && (options.fromDate || options.toDate)) {
    throw new InvalidConfigError('IBKR Flex accepts either a period or a from/to date pair, never both.');
  }
  if (options.periodDays != null && (options.periodDays < 1 || options.periodDays > 365)) {
    throw new InvalidConfigError('The Flex period must be between 1 and 365 days.');
  }
  if (Boolean(options.fromDate) !== Boolean(options.toDate)) {
    throw new InvalidConfigError('IBKR Flex requires fromDate and toDate together (yyyymmdd).');
  }

  const started = ctx.clock.now().getTime();
  const sendQuery: Record<string, string | number | null> = { t: token, q: queryId, v: FLEX_VERSION };
  if (options.fromDate && options.toDate) {
    sendQuery.fd = options.fromDate;
    sendQuery.td = options.toDate;
  } else if (options.periodDays != null) {
    sendQuery.p = options.periodDays;
  }

  const send = await client.getText({ path: 'SendRequest', query: sendQuery, ...(signal ? { signal } : {}) });
  const sendEnvelope = parseFlexEnvelope(send.text);
  if (!sendEnvelope) throw new ProviderResponseError('SendRequest did not return a FlexStatementResponse envelope');
  if (sendEnvelope.status !== 'Success' || !sendEnvelope.referenceCode) throw envelopeToError(sendEnvelope);
  const referenceCode = sendEnvelope.referenceCode;
  logger.info('flex statement requested', { queryId, referenceCode });

  let attempts = 0;
  let delay = pollIntervalMs;
  for (;;) {
    attempts += 1;
    const elapsed = ctx.clock.now().getTime() - started;
    if (elapsed >= maxWaitMs) {
      throw new OperationTimeoutError(`IBKR did not finish generating the Flex statement within ${Math.round(maxWaitMs / 1000)} s. Try again later or shorten the query period.`);
    }
    // The pacing limit is one request per second per token.
    await abortableSleep(attempts === 1 ? FLEX_MIN_REQUEST_INTERVAL_MS : delay, signal);
    const statement = await client.getText({
      path: 'GetStatement',
      query: { t: token, q: referenceCode, v: FLEX_VERSION },
      ...(signal ? { signal } : {}),
    });
    let envelope: FlexEnvelope | null;
    try {
      envelope = parseFlexEnvelope(statement.text);
    } catch (err) {
      throw err instanceof IntegrationError ? err : new ProviderResponseError('The Flex statement could not be read');
    }
    if (envelope && envelope.status === 'Fail') {
      const error = envelopeToError(envelope);
      const retryable = error instanceof ProviderRateLimitedError || (error instanceof FlexServiceError && error.retryable);
      if (!retryable) throw error;
      logger.info('flex statement not ready', { referenceCode, code: envelope.errorCode, attempt: attempts });
      delay = error instanceof ProviderRateLimitedError ? Math.max(delay, error.retryAfterMs ?? 6_000) : Math.min(delay * 2, 30_000);
      continue;
    }
    // A Success envelope with no statement body should not happen; treat it as not ready.
    if (envelope && envelope.status === 'Success' && !/<FlexQueryResponse\b/.test(statement.text)) {
      delay = Math.min(delay * 2, 30_000);
      continue;
    }
    const isXml = /<FlexQueryResponse\b/.test(statement.text.slice(0, 4096));
    const parsed = isXml ? parseFlexXml(statement.text) : parseFlexCsv(statement.text);
    logger.info('flex statement retrieved', { referenceCode, format: parsed.format, statements: parsed.statements.length, attempts });
    return { referenceCode, format: parsed.format, parsed, attempts, waitedMs: ctx.clock.now().getTime() - started };
  }
}

function coverageOfStatements(parsed: FlexParseResult): CoverageInfo {
  const froms = parsed.statements.map((s) => s.coverage.from).filter((d): d is string => d !== null).sort();
  const tos = parsed.statements.map((s) => s.coverage.to).filter((d): d is string => d !== null).sort();
  const note = parsed.statements.map((s) => s.coverage.note).find((n) => n !== null) ?? 'Coverage is the Flex statement period.';
  return { from: froms[0] ?? null, to: tos[tos.length - 1] ?? null, note };
}

export const ibkrFlexAdapter: ProviderAdapter = {
  key: 'ibkr',
  method: 'flex_web_service',
  readOnly: true,

  async test(ctx: AdapterContext): Promise<ConnectionTestResult> {
    // The shortest possible request that still proves the token and query id work.
    const result = await runFlexStatement(ctx, { periodDays: 1, maxWaitMs: configNumber(ctx, 'testMaxWaitMs') ?? 90_000 });
    const accounts = result.parsed.statements.map((s) => s.accountMask ?? 'unknown');
    return {
      ok: true,
      detail: `IBKR generated the Flex statement (${result.format.toUpperCase()}) after ${result.attempts} poll(s) for ${accounts.length} account(s).`,
      grantedScopes: [],
      identity: accounts[0] ?? null,
      observations: [
        `Sections present: ${[...new Set(result.parsed.statements.flatMap((s) => s.sectionsPresent))].join(', ') || 'none'}`,
        'The Flex token is never logged and never appears in an error message.',
      ],
    };
  },

  async listAccounts(ctx: AdapterContext): Promise<ListAccountsResult> {
    const result = await runFlexStatement(ctx, { periodDays: 1 });
    const accounts: NormalizedAccount[] = result.parsed.statements.map((s) => ({
      externalAccountId: s.externalAccountId,
      name: `Interactive Brokers ${s.accountMask ?? ''}`.trim(),
      mask: s.accountMask,
      currency: s.baseCurrency,
      kindHint: 'brokerage',
      status: null,
      metadata: { baseCurrency: s.baseCurrency, sections: s.sectionsPresent.join(','), generatedAt: s.generatedAt },
    }));
    return {
      accounts,
      cards: [],
      notes: ['Flex statements describe the accounts included in the configured query only. Add accounts to the query in Client Portal to see more.'],
    };
  },

  async fetchBalances(ctx: AdapterContext): Promise<FetchBalancesResult> {
    const result = await runFlexStatement(ctx, { periodDays: configNumber(ctx, 'balancePeriodDays') ?? 1 });
    const reportedAt = ctx.clock.now().toISOString();
    const cashBalances: NormalizedCashBalance[] = [];
    const balances: NormalizedBalance[] = [];
    for (const statement of result.parsed.statements) {
      for (const cash of statement.cashBalances) {
        cashBalances.push(cash);
        balances.push({
          externalAccountId: cash.externalAccountId,
          kind: 'statement_closing',
          balance: { amount: cash.amount, currency: cash.currency },
          sourceAsOf: cash.asOf,
          reportedAt,
        });
      }
    }
    return {
      balances,
      cashBalances,
      notes: [
        'Flex cash balances are statement ending cash per currency, not a live provider balance.',
        result.parsed.statements.some((s) => s.sectionsPresent.includes('CashReport'))
          ? 'CashReport section present.'
          : 'The configured Flex query has no Cash Report section, so no cash balances were returned.',
      ],
    };
  },

  async fetchHoldings(ctx: AdapterContext): Promise<FetchHoldingsResult> {
    const result = await runFlexStatement(ctx, { periodDays: configNumber(ctx, 'holdingsPeriodDays') ?? 1 });
    const snapshots = result.parsed.statements.map((s) => s.holdings).filter((h): h is NonNullable<typeof h> => h !== null);
    const fxRates = result.parsed.statements.flatMap((s) => s.fxRates);
    const notes = result.parsed.statements.flatMap((s) => s.notes);
    if (snapshots.length === 0) notes.push('No Open Positions section was present in the Flex query, so no holdings snapshot was produced.');
    notes.push('Flex prices are statement marks, not real-time quotes.');
    return { snapshots, fxRates, notes };
  },

  async fetchInvestmentTransactions(ctx, options = {}): Promise<InvestmentTransactionsResult> {
    const fromDate = options.since ? options.since.replace(/-/g, '') : null;
    const toDate = options.until ? options.until.replace(/-/g, '') : null;
    const run: FlexRunOptions = fromDate && toDate ? { fromDate, toDate } : { periodDays: configNumber(ctx, 'periodDays') ?? 365 };
    if (options.signal) run.signal = options.signal;
    const result = await runFlexStatement(ctx, run);
    const transactions = result.parsed.statements.flatMap((s) => [...s.investmentTransactions, ...s.cashMovements]);
    return {
      transactions,
      corporateActions: result.parsed.statements.flatMap((s) => s.corporateActions),
      cashBalances: result.parsed.statements.flatMap((s) => s.cashBalances),
      fxRates: result.parsed.statements.flatMap((s) => s.fxRates),
      coverage: coverageOfStatements(result.parsed),
      notes: [
        ...result.parsed.statements.flatMap((s) => s.notes),
        ...result.parsed.errors.slice(0, 20).map((e) => `Row ${e.rowNumber}${e.field ? ` (${e.field})` : ''}: ${e.message}`),
        'A Flex period may not exceed 365 days; longer histories need several runs with explicit from/to dates.',
      ],
    };
  },
};

/** Re-exported so callers can distinguish a transport failure from a Flex protocol failure. */
export { ProviderRequestError, ProviderUnavailableError };
