import { toLocalDate } from '@financialos/domain';
import { configString, type AdapterContext } from '../core/context';
import { CredentialMissingError, ProviderResponseError } from '../core/errors';
import { getPath, isRecord, str, toDecimal, toInteger } from '../core/json';
import { maskIdentifier } from '../core/redact';
import type {
  NormalizedAccount,
  NormalizedBalance,
  NormalizedCard,
  NormalizedTransaction,
} from '../core/records';
import { createJsonClient, inertText, type JsonClient } from './http';
import type {
  ConnectionTestResult,
  FetchBalancesResult,
  FetchTransactionsOptions,
  ListAccountsResult,
  ProviderAdapter,
  TransactionPage,
} from './types';

/**
 * Mercury read-only REST adapter.
 *
 * Verified against the official reference on 2026-09-18:
 *   https://docs.mercury.com/reference/getaccounts
 *   https://docs.mercury.com/reference/listtransactions
 *   https://docs.mercury.com/reference/getaccountcards
 *   https://docs.mercury.com/docs/getting-started
 *   https://docs.mercury.com/docs/api-token-security-policies
 *
 * The client underneath is GET-only, so none of Mercury's documented write operations (requestSendMoney,
 * createTransaction, createInternalTransfer, freezeCard, revealCardPan, and the rest) is reachable from here.
 * The owner should issue a Read Only token, which Mercury documents as not requiring an IP allowlist.
 */

export const MERCURY_BASE_URL = 'https://api.mercury.com/api/v1';
export const MERCURY_DEFAULT_TIMEZONE = 'America/New_York';
/** Mercury documents `limit` between 1 and 1000 on both transaction endpoints. */
export const MERCURY_PAGE_SIZE = 500;
export const MERCURY_MAX_PAGES = 200;

/** TransactionStatus as documented. `reversed` and `blocked` are part of the enum. */
export type MercuryStatus = 'pending' | 'sent' | 'cancelled' | 'failed' | 'reversed' | 'blocked';
const NEVER_MOVED: ReadonlySet<string> = new Set(['cancelled', 'failed', 'blocked']);

/** Mercury's Account schema documents no currency field, so the connection's configured currency is used. */
export const MERCURY_DEFAULT_CURRENCY = 'USD';

function credential(ctx: AdapterContext): string {
  const token = ctx.credentials.apiToken ?? ctx.credentials.token ?? '';
  if (!token.trim()) throw new CredentialMissingError('apiToken');
  return token.trim();
}

function currencyOf(ctx: AdapterContext): string {
  return (configString(ctx, 'currency') ?? MERCURY_DEFAULT_CURRENCY).toUpperCase();
}

function timezoneOf(ctx: AdapterContext): string {
  return configString(ctx, 'timezone') ?? MERCURY_DEFAULT_TIMEZONE;
}

export function createMercuryClient(ctx: AdapterContext): JsonClient {
  const token = credential(ctx);
  return createJsonClient({
    safeFetch: ctx.safeFetch,
    baseUrl: configString(ctx, 'baseUrl') ?? MERCURY_BASE_URL,
    headers: { authorization: `Bearer ${token}` },
    sensitiveHeaders: ['authorization'],
    secrets: [token],
    logger: ctx.logger,
    signal: ctx.signal,
    providerLabel: 'Mercury',
    maxAttempts: 4,
  });
}

function accountKind(kind: string | null, name: string | null): NormalizedAccount['kindHint'] {
  const text = `${kind ?? ''} ${name ?? ''}`.toLowerCase();
  if (/credit/.test(text)) return 'credit_card';
  if (/saving|treasury|reserve/.test(text)) return 'savings';
  return 'current';
}

function mapAccount(raw: Record<string, unknown>): NormalizedAccount {
  const accountNumber = str(raw.accountNumber);
  return {
    externalAccountId: str(raw.id) ?? '',
    name: inertText(raw.nickname ?? raw.name, 120) || 'Mercury account',
    mask: maskIdentifier(accountNumber),
    currency: null,
    kindHint: accountKind(str(raw.kind), str(raw.name)),
    status: str(raw.status),
    metadata: {
      type: str(raw.type),
      kind: str(raw.kind),
      legalBusinessName: inertText(raw.legalBusinessName, 200) || null,
      canReceiveTransactions: typeof raw.canReceiveTransactions === 'boolean' ? raw.canReceiveTransactions : null,
      createdAt: str(raw.createdAt),
    },
  };
}

function mapCard(raw: Record<string, unknown>): NormalizedCard {
  // /account/{id}/cards uses cardId + lastFourDigits; /cards uses id + lastFour. Both spellings are read.
  return {
    externalCardId: str(raw.cardId) ?? str(raw.id) ?? '',
    lastFour: str(raw.lastFourDigits) ?? str(raw.lastFour),
    network: str(raw.network),
    status: str(raw.status),
    kind: str(raw.type) ?? str(raw.kind),
    nameOnCard: inertText(raw.nameOnCard, 120) || null,
  };
}

function instantOf(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function describe(raw: Record<string, unknown>): string {
  const candidates = [raw.bankDescription, raw.externalMemo, raw.counterpartyNickname, raw.counterpartyName, raw.note, raw.kind];
  for (const candidate of candidates) {
    const text = inertText(candidate, 300);
    if (text) return text;
  }
  return '(no description)';
}

/** Keeps evidence fields only. URLs, attachments, card details, and routing data are dropped. */
function rawEvidence(raw: Record<string, unknown>): Record<string, unknown> {
  const merchant = isRecord(raw.merchant) ? raw.merchant : null;
  const fx = isRecord(raw.currencyExchangeInfo) ? raw.currencyExchangeInfo : null;
  const out: Record<string, unknown> = {
    kind: str(raw.kind),
    status: str(raw.status),
    mercuryCategory: str(raw.mercuryCategory),
    counterpartyId: str(raw.counterpartyId),
    reasonForFailure: inertText(raw.reasonForFailure, 300) || null,
    checkNumber: str(raw.checkNumber),
    requestId: str(raw.requestId),
    feeId: str(raw.feeId),
  };
  if (merchant) {
    out.merchant = { category: str(merchant.category), categoryCode: str(merchant.categoryCode), currency: str(merchant.currency) };
  }
  if (fx) {
    out.currencyExchange = {
      convertedFromCurrency: str(fx.convertedFromCurrency),
      convertedToCurrency: str(fx.convertedToCurrency),
      convertedFromAmount: fx.convertedFromAmount === undefined ? null : toDecimal(fx.convertedFromAmount),
      convertedToAmount: fx.convertedToAmount === undefined ? null : toDecimal(fx.convertedToAmount),
      exchangeRate: fx.exchangeRate === undefined ? null : toDecimal(fx.exchangeRate),
      feeAmount: fx.feeAmount === undefined ? null : toDecimal(fx.feeAmount),
    };
  }
  return out;
}

export function mapTransaction(raw: Record<string, unknown>, currency: string, timezone: string): NormalizedTransaction {
  const id = str(raw.id);
  if (!id) throw new ProviderResponseError('Mercury returned a transaction without an id');
  const amount = toDecimal(raw.amount);
  if (amount === null) throw new ProviderResponseError('Mercury returned a transaction without an amount');
  const status = (str(raw.status) ?? 'pending') as MercuryStatus;
  const createdAt = instantOf(raw.createdAt);
  const postedAt = instantOf(raw.postedAt);
  const pending = status === 'pending' || postedAt === null;
  const basis = postedAt ?? createdAt;
  if (!basis) throw new ProviderResponseError('Mercury returned a transaction with neither createdAt nor postedAt');
  const counterparty = inertText(raw.counterpartyName, 200) || null;
  return {
    externalId: id,
    externalAccountId: str(raw.accountId) ?? '',
    // Posted transactions book on their posted date; pending ones book on the date Mercury created them.
    bookedOn: toLocalDate(new Date(basis), timezone),
    valueOn: null,
    sourceTimezone: timezone,
    createdAt,
    postedAt,
    amount: { amount, currency },
    description: describe(raw),
    counterparty,
    reference: str(raw.requestId) ?? str(raw.checkNumber),
    pending,
    providerStatus: status,
    movedMoney: !NEVER_MOVED.has(status),
    categoryHint: inertText(raw.mercuryCategory, 100) || (isRecord(raw.categoryData) ? inertText(raw.categoryData.name, 100) || null : null),
    cardExternalId: str(raw.cardId),
    kind: str(raw.kind),
    raw: rawEvidence(raw),
  };
}

function encodeCursor(startAfter: string): string {
  return `after:${startAfter}`;
}

function decodeCursor(cursor: string | null | undefined): string | null {
  if (!cursor) return null;
  const match = /^after:(.+)$/.exec(cursor);
  return match?.[1] ?? null;
}

async function readAccounts(client: JsonClient, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let startAfter: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const response: { data: unknown } = await client.get({
      path: 'accounts',
      query: { limit: 500, order: 'asc', start_after: startAfter },
      ...(signal ? { signal } : {}),
    });
    const body = response.data;
    if (!isRecord(body) || !Array.isArray(body.accounts)) throw new ProviderResponseError('Mercury /accounts did not return an accounts array');
    for (const item of body.accounts) if (isRecord(item)) out.push(item);
    const next = isRecord(body.page) ? str(body.page.nextPage) : null;
    if (!next || next === startAfter || body.accounts.length === 0) break;
    startAfter = next;
  }
  return out;
}

export const mercuryAdapter: ProviderAdapter = {
  key: 'mercury',
  method: 'api_token',
  readOnly: true,

  async test(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const client = createMercuryClient(ctx);
    const accounts = await readAccounts(client, ctx.signal);
    const own = accounts.filter((a) => str(a.type) === 'mercury');
    return {
      ok: true,
      detail:
        own.length > 0
          ? `Mercury accepted the token and returned ${own.length} Mercury account(s).`
          : 'Mercury accepted the token but returned no Mercury-held accounts. Check that the token belongs to the right business.',
      // Mercury does not return the token's scopes on any documented endpoint.
      grantedScopes: [],
      identity: own[0] ? inertText(own[0].legalBusinessName, 200) || null : null,
      observations: [
        `Accounts endpoint reachable: ${client.describe('accounts')}`,
        'Mercury does not document rate-limit headers or a scopes endpoint; scope shown as unknown.',
      ],
    };
  },

  async listAccounts(ctx: AdapterContext): Promise<ListAccountsResult> {
    const client = createMercuryClient(ctx);
    const raw = await readAccounts(client, ctx.signal);
    const own = raw.filter((a) => str(a.type) === 'mercury');
    const accounts = own.map(mapAccount).filter((a) => a.externalAccountId !== '');
    const cards: NormalizedCard[] = [];
    for (const account of accounts) {
      const response = await client.get({
        path: `account/${encodeURIComponent(account.externalAccountId)}/cards`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        allowNotFound: true,
      });
      const body = response.data;
      if (!isRecord(body) || !Array.isArray(body.cards)) continue;
      for (const item of body.cards) {
        if (!isRecord(item)) continue;
        const card = mapCard(item);
        if (card.externalCardId) cards.push(card);
      }
    }
    const notes = [
      `${raw.length - own.length} counterparty record(s) of type "external"/"recipient" were not treated as accounts.`,
      'Mercury does not document a currency on the Account schema; the connection currency is applied.',
    ];
    return { accounts, cards, notes };
  },

  async fetchBalances(ctx: AdapterContext): Promise<FetchBalancesResult> {
    const client = createMercuryClient(ctx);
    const currency = currencyOf(ctx);
    const reportedAt = ctx.clock.now().toISOString();
    const raw = await readAccounts(client, ctx.signal);
    const balances: NormalizedBalance[] = [];
    for (const account of raw) {
      if (str(account.type) !== 'mercury') continue;
      const id = str(account.id);
      if (!id) continue;
      const current = account.currentBalance === undefined ? null : toDecimal(account.currentBalance);
      const available = account.availableBalance === undefined ? null : toDecimal(account.availableBalance);
      if (current !== null) {
        balances.push({ externalAccountId: id, kind: 'provider_current', balance: { amount: current, currency }, sourceAsOf: null, reportedAt });
      }
      if (available !== null) {
        balances.push({ externalAccountId: id, kind: 'provider_available', balance: { amount: available, currency }, sourceAsOf: null, reportedAt });
      }
    }
    return {
      balances,
      cashBalances: [],
      notes: ['Mercury does not document an as-of timestamp for balances, so sourceAsOf stays unknown.'],
    };
  },

  fetchTransactions(ctx: AdapterContext, options: FetchTransactionsOptions): AsyncIterable<TransactionPage> {
    const client = createMercuryClient(ctx);
    const currency = currencyOf(ctx);
    const timezone = timezoneOf(ctx);
    const accountFilter = configString(ctx, 'accountId');
    const signal = options.signal ?? ctx.signal;
    const maxPages = Math.min(options.maxPages ?? MERCURY_MAX_PAGES, MERCURY_MAX_PAGES);

    return (async function* generate(): AsyncIterable<TransactionPage> {
      let startAfter = decodeCursor(options.cursor);
      for (let page = 0; page < maxPages; page += 1) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        const response = await client.get({
          path: 'transactions',
          query: {
            limit: MERCURY_PAGE_SIZE,
            order: 'asc',
            start: options.since ?? null,
            end: options.until ?? null,
            start_after: startAfter,
            accountId: accountFilter,
          },
          ...(signal ? { signal } : {}),
        });
        const body = response.data;
        if (!isRecord(body) || !Array.isArray(body.transactions)) {
          throw new ProviderResponseError('Mercury /transactions did not return a transactions array');
        }
        const transactions = body.transactions.filter(isRecord).map((item) => mapTransaction(item, currency, timezone));
        const next = isRecord(body.page) ? str(body.page.nextPage) : null;
        const done = !next || next === startAfter || body.transactions.length === 0;
        yield {
          transactions,
          cursor: done || !next ? null : encodeCursor(next),
          done,
          coverage: { from: options.since ?? null, to: options.until ?? null, note: 'Window requested from Mercury; Mercury does not state a history limit.' },
        };
        if (done) return;
        startAfter = next;
      }
      ctx.logger.warn('mercury page budget reached', { maxPages });
    })();
  },
};

/**
 * Reads one account's transactions through the offset-paginated endpoint Mercury documents separately
 * (`/account/{id}/transactions` returns `{ total, transactions }`). Kept for reconciliation against the
 * cursor-paginated feed and for accounts whose ids the owner has mapped individually.
 */
export async function fetchAccountTransactions(
  ctx: AdapterContext,
  accountId: string,
  options: { since?: string | null; until?: string | null; maxPages?: number; pageSize?: number } = {},
): Promise<{ transactions: NormalizedTransaction[]; total: number | null }> {
  const client = createMercuryClient(ctx);
  const currency = currencyOf(ctx);
  const timezone = timezoneOf(ctx);
  const out: NormalizedTransaction[] = [];
  let total: number | null = null;
  let offset = 0;
  const maxPages = Math.min(options.maxPages ?? MERCURY_MAX_PAGES, MERCURY_MAX_PAGES);
  const pageSize = Math.min(Math.max(1, options.pageSize ?? MERCURY_PAGE_SIZE), 1000);
  for (let page = 0; page < maxPages; page += 1) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
    const response = await client.get({
      path: `account/${encodeURIComponent(accountId)}/transactions`,
      query: { limit: pageSize, offset, order: 'asc', start: options.since ?? null, end: options.until ?? null },
      signal: ctx.signal,
    });
    const body = response.data;
    if (!isRecord(body) || !Array.isArray(body.transactions)) {
      throw new ProviderResponseError('Mercury account transactions did not return a transactions array');
    }
    if (total === null && body.total !== undefined) total = toInteger(body.total);
    for (const item of body.transactions) if (isRecord(item)) out.push(mapTransaction(item, currency, timezone));
    if (body.transactions.length < pageSize) break;
    offset += body.transactions.length;
    if (total !== null && offset >= total) break;
  }
  return { transactions: out, total };
}

/** Exposed for tests: reads a dotted path out of a Mercury payload without evaluating anything. */
export const mercuryPath = getPath;
