import { configBoolean, configString, type AdapterContext } from '../core/context';
import { InvalidConfigError, ProviderResponseError } from '../core/errors';
import { isRecord, str, toDecimal, toInteger } from '../core/json';
import type { NormalizedFxRate, NormalizedPrice } from '../core/records';
import { createJsonClient, type JsonClient } from './http';

/**
 * Public market data: foreign-exchange reference rates and crypto spot prices.
 *
 * Two rules hold here. First, this is opt-in: nothing in this module runs unless the owner has switched
 * `publicMarketData` on for the deployment, because it means talking to a third party. Second, the request
 * carries currency codes and asset identifiers and nothing else - never a balance, a quantity, a holding, an
 * account, or anything derived from them. A rate request is indistinguishable from any other visitor's.
 *
 * Verified on 2026-09-18:
 *   Frankfurter  https://frankfurter.dev/  - host api.frankfurter.dev (api.frankfurter.app 301-redirects to
 *                it), `GET /v1/latest?base=USD&symbols=EUR` -> { amount, base, date, rates }, no API key,
 *                "no monthly or daily caps", rate-limited to prevent abuse.
 *   CoinGecko    https://docs.coingecko.com/reference/introduction - public host
 *                https://api.coingecko.com/api/v3, `GET /simple/price?ids=&vs_currencies=&include_last_updated_at=true`
 *                -> { "<id>": { "<vs>": number, last_updated_at: number } }. The demo key header
 *                `x-cg-demo-api-key` is optional on that host; keyless traffic is rate-limited per IP and the
 *                documented demo limit is 100 calls per minute with a 60-second update interval.
 */

export const FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v1';
export const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';
export const FRANKFURTER_SOURCE = 'Frankfurter (ECB reference rates)';
export const COINGECKO_SOURCE = 'CoinGecko public API';

const CURRENCY = /^[A-Z]{3}$/;
const ASSET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Throws unless the owner has explicitly enabled outbound public market-data requests. */
export function assertPublicMarketDataEnabled(ctx: AdapterContext): void {
  if (configBoolean(ctx, 'publicMarketData') !== true) {
    throw new InvalidConfigError(
      'Public market data is switched off. Turn on "Allow public market-data requests" in Settings to let FinancialOS ask a third party for exchange rates or crypto prices.',
    );
  }
}

function fxClient(ctx: AdapterContext): JsonClient {
  return createJsonClient({
    safeFetch: ctx.safeFetch,
    baseUrl: configString(ctx, 'fxBaseUrl') ?? FRANKFURTER_BASE_URL,
    logger: ctx.logger,
    signal: ctx.signal,
    providerLabel: 'Frankfurter',
    maxAttempts: 3,
    maxResponseBytes: 512 * 1024,
  });
}

function cryptoClient(ctx: AdapterContext): JsonClient {
  const key = ctx.credentials.coingeckoDemoKey ?? null;
  return createJsonClient({
    safeFetch: ctx.safeFetch,
    baseUrl: configString(ctx, 'cryptoBaseUrl') ?? COINGECKO_BASE_URL,
    // The demo key is optional on the public host; it raises the shared per-IP limit to the documented demo tier.
    headers: key ? { 'x-cg-demo-api-key': key } : {},
    sensitiveHeaders: ['x-cg-demo-api-key'],
    secrets: key ? [key] : [],
    logger: ctx.logger,
    signal: ctx.signal,
    providerLabel: 'CoinGecko',
    maxAttempts: 3,
    maxResponseBytes: 1024 * 1024,
  });
}

function assertCurrencies(base: string, quotes: readonly string[]): void {
  if (!CURRENCY.test(base)) throw new InvalidConfigError(`"${base}" is not a three-letter currency code.`);
  if (quotes.length === 0) throw new InvalidConfigError('At least one quote currency is required.');
  if (quotes.length > 50) throw new InvalidConfigError('At most 50 quote currencies may be requested at once.');
  for (const quote of quotes) if (!CURRENCY.test(quote)) throw new InvalidConfigError(`"${quote}" is not a three-letter currency code.`);
}

export interface FxOptions {
  /** ISO date for a historical rate. Omit for the latest published rates. */
  date?: string | null;
}

/**
 * Fetches reference rates. Only the currency codes travel: `base` and `symbols` are validated against a strict
 * pattern before the URL is built, so nothing else can be smuggled into the query.
 */
export async function fetchFxRates(ctx: AdapterContext, base: string, quotes: readonly string[], options: FxOptions = {}): Promise<NormalizedFxRate[]> {
  assertPublicMarketDataEnabled(ctx);
  const upperBase = base.toUpperCase();
  const upperQuotes = quotes.map((q) => q.toUpperCase()).filter((q) => q !== upperBase);
  assertCurrencies(upperBase, upperQuotes.length ? upperQuotes : [upperBase]);
  if (upperQuotes.length === 0) return [];
  if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new InvalidConfigError('The rate date must be YYYY-MM-DD.');
  const client = fxClient(ctx);
  const response = await client.get({
    path: options.date ?? 'latest',
    query: { base: upperBase, symbols: upperQuotes.join(',') },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const body = response.data;
  if (!isRecord(body) || !isRecord(body.rates)) throw new ProviderResponseError('Frankfurter returned no rates object');
  const asOf = str(body.date);
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new ProviderResponseError('Frankfurter returned no usable rate date');
  const returnedBase = str(body.base) ?? upperBase;
  const out: NormalizedFxRate[] = [];
  for (const [quote, value] of Object.entries(body.rates)) {
    if (!CURRENCY.test(quote)) continue;
    // The response carries JSON numbers; the lossless parser keeps their exact source text.
    const rate = toDecimal(value);
    if (rate === null) continue;
    out.push({ base: returnedBase, quote, rate, asOf, source: FRANKFURTER_SOURCE });
  }
  if (out.length === 0) throw new ProviderResponseError('Frankfurter returned no usable rates for the requested currencies');
  return out;
}

export interface CryptoPriceOptions {
  /** Fiat or crypto codes to price in, lower-cased by the caller or here. */
  vsCurrencies?: readonly string[];
}

/**
 * Fetches crypto spot prices by asset id. Ids are CoinGecko's own slugs (`bitcoin`, `ethereum`); they are
 * validated against a strict pattern. No quantity or holding is ever part of the request.
 */
export async function fetchCryptoPrices(ctx: AdapterContext, assetIds: readonly string[], options: CryptoPriceOptions = {}): Promise<NormalizedPrice[]> {
  assertPublicMarketDataEnabled(ctx);
  const ids = [...new Set(assetIds.map((id) => id.trim().toLowerCase()))].filter(Boolean);
  if (ids.length === 0) throw new InvalidConfigError('At least one asset id is required.');
  if (ids.length > 100) throw new InvalidConfigError('At most 100 asset ids may be requested at once.');
  for (const id of ids) if (!ASSET_ID.test(id)) throw new InvalidConfigError(`"${id}" is not a valid asset identifier.`);
  const vs = (options.vsCurrencies ?? [configString(ctx, 'currency') ?? 'USD']).map((c) => c.trim().toLowerCase());
  for (const currency of vs) if (!/^[a-z]{3,10}$/.test(currency)) throw new InvalidConfigError(`"${currency}" is not a valid quote currency.`);
  const client = cryptoClient(ctx);
  const response = await client.get({
    path: 'simple/price',
    query: { ids: ids.join(','), vs_currencies: vs.join(','), include_last_updated_at: 'true' },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const body = response.data;
  if (!isRecord(body)) throw new ProviderResponseError('CoinGecko returned no price object');
  const out: NormalizedPrice[] = [];
  for (const [assetId, node] of Object.entries(body)) {
    if (!isRecord(node)) continue;
    const updated = node.last_updated_at === undefined ? null : toInteger(node.last_updated_at);
    const asOf = updated === null ? null : new Date(updated * 1000).toISOString();
    for (const currency of vs) {
      const value = node[currency];
      if (value === undefined) continue;
      const price = toDecimal(value);
      if (price === null) continue;
      out.push({
        assetId,
        currency: currency.toUpperCase(),
        price,
        asOf,
        source: COINGECKO_SOURCE,
        // The public tier updates at most once a minute, so a spot price is delayed, never real time.
        priceKind: 'delayed',
      });
    }
  }
  if (out.length === 0) throw new ProviderResponseError('CoinGecko returned no usable prices for the requested assets');
  return out;
}

/** Lists the currencies Frankfurter publishes, so the UI can offer only rates that exist. */
export async function listFxCurrencies(ctx: AdapterContext): Promise<Array<{ code: string; name: string }>> {
  assertPublicMarketDataEnabled(ctx);
  const client = fxClient(ctx);
  const response = await client.get({ path: 'currencies', ...(ctx.signal ? { signal: ctx.signal } : {}) });
  if (!isRecord(response.data)) throw new ProviderResponseError('Frankfurter returned no currency list');
  return Object.entries(response.data)
    .filter(([code]) => CURRENCY.test(code))
    .map(([code, name]) => ({ code, name: str(name) ?? code }));
}

export interface PublicMarketDataTest {
  ok: boolean;
  detail: string;
  fx: NormalizedFxRate | null;
  crypto: NormalizedPrice | null;
}

/** Connection test for the public market-data sources. Sends only currency codes and one asset id. */
export async function testPublicMarketData(ctx: AdapterContext): Promise<PublicMarketDataTest> {
  assertPublicMarketDataEnabled(ctx);
  const base = (configString(ctx, 'currency') ?? 'USD').toUpperCase();
  const quote = base === 'EUR' ? 'USD' : 'EUR';
  const fx = (await fetchFxRates(ctx, base, [quote]))[0] ?? null;
  let crypto: NormalizedPrice | null = null;
  try {
    crypto = (await fetchCryptoPrices(ctx, ['bitcoin'], { vsCurrencies: [base] }))[0] ?? null;
  } catch (err) {
    ctx.logger.warn('crypto price source unavailable', { error: err instanceof Error ? err.name : 'unknown' });
  }
  return {
    ok: fx !== null,
    detail: fx
      ? `Reference rate ${fx.base}/${fx.quote} for ${fx.asOf} received${crypto ? `; BTC spot price in ${crypto.currency} received` : '; the crypto price source did not answer'}.`
      : 'No reference rate was returned.',
    fx,
    crypto,
  };
}
