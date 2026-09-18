import { keccak_256 } from '@noble/hashes/sha3.js';
import { fromBaseUnits } from '@financialos/domain';
import { configBoolean, configString, type AdapterContext } from '../core/context';
import { InvalidConfigError, ProviderResponseError, UnsupportedOperationError } from '../core/errors';
import { isRecord, str, toInteger } from '../core/json';
import type { NormalizedAccount, NormalizedBalance, NormalizedCashBalance, NormalizedTransaction } from '../core/records';
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
 * Ethereum watch-only adapter over Blockscout's REST API v2, with an optional owner-configured JSON-RPC mode
 * for a node the owner runs themselves.
 *
 * Verified on 2026-09-18 against https://docs.blockscout.com/devs/apis/rest and the instance schema at
 * https://eth.blockscout.com/api-docs :
 *   GET /api/v2/addresses/{hash}                  -> { hash, coin_balance (string, wei), block_number_balance_updated_at, is_contract, ... }
 *   GET /api/v2/addresses/{hash}/transactions     -> { items: [...], next_page_params: {...} }  (keyset paging, 50 per page)
 *   GET /api/v2/addresses/{hash}/token-balances   -> a bare array of { value, token: { address_hash, decimals, name, symbol, type } }
 *   GET /api/v2/addresses/{hash}/token-transfers  -> { items: [...], next_page_params: {...} }
 *
 * Only Ethereum mainnet is enabled. Other chains are refused rather than guessed at, because token decimals,
 * native-currency minor units, and explorer response shapes differ per chain and none of that is verified here.
 */

export const BLOCKSCOUT_DEFAULT_BASE_URL = 'https://eth.blockscout.com/api/v2';
export const ETH_CURRENCY = 'ETH';
export const ETHEREUM_MAINNET_CHAIN_ID = 1;
export const BLOCKSCOUT_PAGE_SIZE = 50;

/** Chains this release deliberately does not enable, with the reason the owner sees. */
export const ETH_UNSUPPORTED_CHAINS = [
  'Only Ethereum mainnet (chain id 1) is enabled. Layer-2 and sidechain explorers publish different response shapes and different native-currency units, and none of those has been verified for this deployment.',
  'Testnets are not enabled: their balances are not money and would pollute net worth.',
] as const;

/** JSON-RPC methods the optional node mode may call. Everything else is refused. */
export const ETH_RPC_ALLOWED_METHODS = ['eth_chainId', 'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount', 'eth_call'] as const;

export interface EthAddressInfo {
  /** Lower-case 0x-prefixed address. */
  address: string;
  /** EIP-55 checksummed form. */
  checksummed: string;
}

export function toChecksumAddress(lowerHex: string): string {
  const body = lowerHex.replace(/^0x/, '').toLowerCase();
  const hash = Buffer.from(keccak_256(Buffer.from(body, 'ascii'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    out += /[a-f]/.test(char) && parseInt(hash[i]!, 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/**
 * Validates an Ethereum address. A mixed-case address must satisfy the EIP-55 checksum; an all-lower or
 * all-upper address has no checksum to verify and is accepted with its checksummed form computed.
 */
export function validateEthAddress(input: string): EthAddressInfo {
  const address = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new InvalidConfigError('An Ethereum address must be 0x followed by 40 hexadecimal characters.');
  }
  const body = address.slice(2);
  const mixed = /[a-f]/.test(body) && /[A-F]/.test(body);
  const checksummed = toChecksumAddress(address);
  if (mixed && checksummed !== address) {
    throw new InvalidConfigError('This Ethereum address fails its EIP-55 checksum. Copy it again from the wallet.');
  }
  return { address: address.toLowerCase(), checksummed };
}

/** Converts an integer base-unit string to an exact decimal string. No floating point is involved. */
export function unitsToDecimal(units: string, decimals: number): string {
  if (!/^-?\d+$/.test(units)) throw new ProviderResponseError('Expected an integer token amount');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new ProviderResponseError('Unsupported token decimals');
  const negative = units.startsWith('-');
  const digits = (negative ? units.slice(1) : units).replace(/^0+(?=\d)/, '');
  if (decimals === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function blockscoutClient(ctx: AdapterContext): JsonClient {
  const baseUrl = configString(ctx, 'baseUrl') ?? BLOCKSCOUT_DEFAULT_BASE_URL;
  const chainId = toInteger(ctx.config.chainId ?? null);
  if (chainId !== null && chainId !== ETHEREUM_MAINNET_CHAIN_ID) {
    throw new UnsupportedOperationError(`Chain id ${chainId} is not enabled. ${ETH_UNSUPPORTED_CHAINS[0]}`);
  }
  return createJsonClient({
    safeFetch: ctx.safeFetch,
    baseUrl,
    logger: ctx.logger,
    signal: ctx.signal,
    providerLabel: 'Blockscout',
    maxAttempts: 4,
    maxResponseBytes: 4 * 1024 * 1024,
  });
}

function watchedAddress(ctx: AdapterContext): EthAddressInfo {
  const raw = configString(ctx, 'address');
  if (!raw) throw new InvalidConfigError('No Ethereum address is configured for this connection.');
  return validateEthAddress(raw);
}

function externalIdOf(ctx: AdapterContext, address: string): string {
  return configString(ctx, 'externalAccountId') ?? `eth:${address}`;
}

// ---------------------------------------------------------------------------------------------------------
// Optional JSON-RPC mode
// ---------------------------------------------------------------------------------------------------------

export interface EthRpcResult {
  chainId: number;
  blockNumber: number;
  balanceWei: string;
}

function hexToBigInt(value: unknown, field: string): bigint {
  const text = str(value);
  if (!text || !/^0x[0-9a-fA-F]{1,64}$/.test(text)) throw new ProviderResponseError(`The JSON-RPC node returned an invalid ${field}`);
  return BigInt(text);
}

/**
 * Calls a single read-only JSON-RPC method on the owner's node. JSON-RPC is a POST protocol, so this is the
 * one place in this adapter that is not a GET; the method name is checked against a fixed read-only list
 * before the request is built, so no state-changing method (eth_sendRawTransaction and friends) is reachable.
 */
export async function ethRpcCall(ctx: AdapterContext, rpcUrl: string, method: (typeof ETH_RPC_ALLOWED_METHODS)[number], params: unknown[]): Promise<unknown> {
  if (!ETH_RPC_ALLOWED_METHODS.includes(method)) throw new UnsupportedOperationError(`JSON-RPC method ${method} is not on the read-only list`);
  const response = await ctx.safeFetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    maxResponseBytes: 1024 * 1024,
    totalTimeoutMs: 20_000,
    redirect: 'error',
  });
  const text = await response.text();
  if (!response.ok) throw new ProviderResponseError(`The JSON-RPC node returned HTTP ${response.status} at ${response.redactedUrl}`);
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderResponseError('The JSON-RPC node returned a body that is not valid JSON');
  }
  if (!isRecord(body)) throw new ProviderResponseError('The JSON-RPC node returned an unexpected body');
  if (isRecord(body.error)) throw new ProviderResponseError(`The JSON-RPC node reported an error: ${inertText(body.error.message, 200)}`);
  return body.result;
}

export async function readViaRpc(ctx: AdapterContext, rpcUrl: string, address: string): Promise<EthRpcResult> {
  const chainId = hexToBigInt(await ethRpcCall(ctx, rpcUrl, 'eth_chainId', []), 'chain id');
  if (chainId !== BigInt(ETHEREUM_MAINNET_CHAIN_ID)) {
    throw new UnsupportedOperationError(`The configured node reports chain id ${chainId}. ${ETH_UNSUPPORTED_CHAINS[0]}`);
  }
  const blockNumber = hexToBigInt(await ethRpcCall(ctx, rpcUrl, 'eth_blockNumber', []), 'block number');
  const balance = hexToBigInt(await ethRpcCall(ctx, rpcUrl, 'eth_getBalance', [address, 'latest']), 'balance');
  return { chainId: Number(chainId), blockNumber: Number(blockNumber), balanceWei: balance.toString() };
}

// ---------------------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------------------

export interface Erc20Balance {
  contract: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  rawValue: string;
  amount: string;
  type: string | null;
}

export async function fetchTokenBalances(client: JsonClient, address: string, signal?: AbortSignal): Promise<Erc20Balance[]> {
  const response = await client.get({ path: `addresses/${address}/token-balances`, ...(signal ? { signal } : {}), allowNotFound: true });
  const list = Array.isArray(response.data) ? response.data : [];
  const out: Erc20Balance[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const token = isRecord(raw.token) ? raw.token : null;
    if (!token) continue;
    const type = str(token.type);
    // Only fungible ERC-20 positions carry a meaningful decimal balance.
    if (type !== null && !/^erc-?20$/i.test(type)) continue;
    const decimalsText = str(token.decimals);
    const decimals = decimalsText !== null && /^\d{1,2}$/.test(decimalsText) ? Number(decimalsText) : null;
    const value = str(raw.value);
    const contract = str(token.address_hash) ?? str(token.address);
    if (decimals === null || value === null || contract === null) continue;
    out.push({
      contract: contract.toLowerCase(),
      symbol: inertText(token.symbol, 20) || null,
      name: inertText(token.name, 80) || null,
      decimals,
      rawValue: value,
      amount: unitsToDecimal(value, decimals),
      type,
    });
  }
  return out;
}

function encodeEthCursor(params: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(params), 'utf8').toString('base64url');
}

export function decodeEthCursor(cursor: string | null | undefined): Record<string, string> {
  if (!cursor) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new InvalidConfigError('The Ethereum sync cursor is not in the expected form.');
  }
  if (!isRecord(parsed)) throw new InvalidConfigError('The Ethereum sync cursor is not in the expected form.');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[a-z_]{1,40}$/.test(key)) continue;
    if (value === null || value === undefined) continue;
    const text = String(value);
    if (text.length <= 200) out[key] = text;
  }
  return out;
}

export function mapEthTransaction(raw: Record<string, unknown>, address: string, externalAccountId: string): NormalizedTransaction | null {
  const hash = str(raw.hash);
  if (!hash) return null;
  const from = isRecord(raw.from) ? (str(raw.from.hash) ?? '').toLowerCase() : '';
  const to = isRecord(raw.to) ? (str(raw.to.hash) ?? '').toLowerCase() : '';
  const valueText = str(raw.value) ?? '0';
  if (!/^\d+$/.test(valueText)) throw new ProviderResponseError('Blockscout returned a non-integer transaction value');
  const value = BigInt(valueText);
  const feeNode = isRecord(raw.fee) ? raw.fee : null;
  const feeText = feeNode ? (str(feeNode.value) ?? '0') : '0';
  const fee = /^\d+$/.test(feeText) ? BigInt(feeText) : 0n;
  const isSender = from === address;
  const isRecipient = to === address;
  if (!isSender && !isRecipient) return null;
  const failed = str(raw.status) === 'error' || str(raw.result) === 'error';
  // The sender pays the fee whether or not the call succeeded; a failed transfer moves no value.
  const net = (isRecipient && !failed ? value : 0n) - (isSender && !failed ? value : 0n) - (isSender ? fee : 0n);
  const timestamp = str(raw.timestamp);
  const instant = timestamp ? new Date(timestamp) : null;
  if (instant && Number.isNaN(instant.getTime())) throw new ProviderResponseError('Blockscout returned an unparseable timestamp');
  const iso = instant ? instant.toISOString() : null;
  const internal = isSender && isRecipient;
  return {
    externalId: hash,
    externalAccountId,
    bookedOn: (iso ?? new Date(0).toISOString()).slice(0, 10),
    valueOn: null,
    sourceTimezone: 'UTC',
    createdAt: iso,
    postedAt: iso,
    amount: fromBaseUnits(net, ETH_CURRENCY),
    description: failed
      ? `Failed transaction ${hash.slice(0, 10)}… (fee still paid)`
      : internal
        ? 'Self-transfer (net effect is the gas fee)'
        : isRecipient
          ? `Received ${fromBaseUnits(value, ETH_CURRENCY).amount} ETH`
          : `Sent ${fromBaseUnits(value, ETH_CURRENCY).amount} ETH`,
    counterparty: internal ? null : isSender ? to || null : from || null,
    reference: hash,
    pending: toInteger(raw.block_number) === null,
    providerStatus: failed ? 'error' : (str(raw.status) ?? 'ok'),
    // A reverted transaction moved no value, but the fee it burned did leave the account.
    movedMoney: !failed || fee > 0n,
    categoryHint: internal ? 'transfer_internal' : null,
    cardExternalId: null,
    kind: inertText(raw.method, 60) || (isRecipient ? 'receive' : 'send'),
    raw: {
      hash,
      blockNumber: toInteger(raw.block_number),
      valueWei: valueText,
      feeWei: fee.toString(),
      gasUsed: str(raw.gas_used),
      gasPrice: str(raw.gas_price),
      from,
      to,
      status: str(raw.status),
      method: inertText(raw.method, 60) || null,
    },
  };
}

export const ethWatchOnlyAdapter: ProviderAdapter = {
  key: 'crypto_eth',
  method: 'watch_only_address',
  readOnly: true,

  async test(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const { address, checksummed } = watchedAddress(ctx);
    const rpcUrl = configString(ctx, 'rpcUrl');
    const observations: string[] = [];
    if (rpcUrl && configBoolean(ctx, 'useRpc') === true) {
      const rpc = await readViaRpc(ctx, rpcUrl, address);
      observations.push(`JSON-RPC node mode: chain id ${rpc.chainId}, block ${rpc.blockNumber}.`);
      return {
        ok: true,
        detail: `The configured node answered for ${checksummed} at block ${rpc.blockNumber}.`,
        grantedScopes: [],
        identity: checksummed,
        observations: [...observations, 'Read-only JSON-RPC methods only; no signing method is reachable.'],
      };
    }
    const client = blockscoutClient(ctx);
    const response = await client.get({ path: `addresses/${address}`, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    if (!isRecord(response.data)) throw new ProviderResponseError('Blockscout returned no address object');
    const isContract = response.data.is_contract === true;
    const tokens = await fetchTokenBalances(client, address, ctx.signal);
    return {
      ok: true,
      detail: `Blockscout answered for ${checksummed}${isContract ? ' (this address is a contract)' : ''} and lists ${tokens.length} ERC-20 position(s).`,
      grantedScopes: [],
      identity: checksummed,
      observations: [
        `Explorer: ${client.describe(`addresses/${address}`)}`,
        'Ethereum mainnet only.',
        'Watch-only: this connection never holds a key and cannot sign or spend.',
      ],
    };
  },

  async listAccounts(ctx: AdapterContext): Promise<ListAccountsResult> {
    const { address, checksummed } = watchedAddress(ctx);
    const account: NormalizedAccount = {
      externalAccountId: externalIdOf(ctx, address),
      name: `Ethereum ${checksummed.slice(0, 10)}…`,
      mask: `…${checksummed.slice(-6)}`,
      currency: ETH_CURRENCY,
      kindHint: 'crypto_wallet',
      status: 'active',
      metadata: { address: checksummed, chainId: ETHEREUM_MAINNET_CHAIN_ID, network: 'ethereum-mainnet' },
    };
    return { accounts: [account], cards: [], notes: [...ETH_UNSUPPORTED_CHAINS, 'Only this one address is watched; funds held at other addresses of the same wallet are not counted.'] };
  },

  async fetchBalances(ctx: AdapterContext): Promise<FetchBalancesResult> {
    const { address, checksummed } = watchedAddress(ctx);
    const externalAccountId = externalIdOf(ctx, address);
    const reportedAt = ctx.clock.now().toISOString();
    const rpcUrl = configString(ctx, 'rpcUrl');
    const balances: NormalizedBalance[] = [];
    const cashBalances: NormalizedCashBalance[] = [];
    const notes: string[] = [];
    if (rpcUrl && configBoolean(ctx, 'useRpc') === true) {
      const rpc = await readViaRpc(ctx, rpcUrl, address);
      balances.push({ externalAccountId, kind: 'provider_current', balance: fromBaseUnits(BigInt(rpc.balanceWei), ETH_CURRENCY), sourceAsOf: reportedAt, reportedAt });
      notes.push(`Native balance read from the owner's JSON-RPC node at block ${rpc.blockNumber}. ERC-20 balances are not read in node mode (that needs per-token contract calls).`);
      return { balances, cashBalances, notes };
    }
    const client = blockscoutClient(ctx);
    const response = await client.get({ path: `addresses/${address}`, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    if (!isRecord(response.data)) throw new ProviderResponseError('Blockscout returned no address object');
    const coin = str(response.data.coin_balance);
    if (coin === null || !/^\d+$/.test(coin)) throw new ProviderResponseError('Blockscout returned no integer coin_balance');
    balances.push({ externalAccountId, kind: 'provider_current', balance: fromBaseUnits(BigInt(coin), ETH_CURRENCY), sourceAsOf: reportedAt, reportedAt });
    cashBalances.push({ externalAccountId, currency: ETH_CURRENCY, amount: fromBaseUnits(BigInt(coin), ETH_CURRENCY).amount, asOf: reportedAt.slice(0, 10), source: 'Blockscout coin_balance' });
    const tokens = await fetchTokenBalances(client, address, ctx.signal);
    for (const token of tokens) {
      const currency = token.symbol && /^[A-Z0-9]{2,10}$/.test(token.symbol.toUpperCase()) ? token.symbol.toUpperCase() : null;
      if (!currency) {
        notes.push(`An ERC-20 position at ${token.contract} has no usable symbol and was reported without a currency code.`);
        continue;
      }
      cashBalances.push({ externalAccountId: `${externalAccountId}:${token.contract}`, currency, amount: token.amount, asOf: reportedAt.slice(0, 10), source: `Blockscout ERC-20 ${token.contract}` });
    }
    notes.push(`${tokens.length} ERC-20 position(s) read with their contract decimals; amounts are exact base-unit conversions.`);
    notes.push(`Balance as reported for ${checksummed}. Blockscout is a public explorer, not the owner's node; enable node mode for an independent reading.`);
    return { balances, cashBalances, notes };
  },

  fetchTransactions(ctx: AdapterContext, options: FetchTransactionsOptions): AsyncIterable<TransactionPage> {
    const { address } = watchedAddress(ctx);
    const externalAccountId = externalIdOf(ctx, address);
    const client = blockscoutClient(ctx);
    const signal = options.signal ?? ctx.signal;
    const maxPages = options.maxPages ?? 200;

    return (async function* generate(): AsyncIterable<TransactionPage> {
      let params = decodeEthCursor(options.cursor);
      for (let page = 0; page < maxPages; page += 1) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        const response = await client.get({
          path: `addresses/${address}/transactions`,
          query: params,
          ...(signal ? { signal } : {}),
        });
        const body = response.data;
        if (!isRecord(body) || !Array.isArray(body.items)) throw new ProviderResponseError('Blockscout did not return a transactions items array');
        const transactions: NormalizedTransaction[] = [];
        for (const raw of body.items) {
          if (!isRecord(raw)) continue;
          const record = mapEthTransaction(raw, address, externalAccountId);
          if (!record) continue;
          if (options.since && record.bookedOn < options.since) continue;
          if (options.until && record.bookedOn > options.until) continue;
          transactions.push(record);
        }
        const next = isRecord(body.next_page_params) ? body.next_page_params : null;
        const done = next === null || Object.keys(next).length === 0 || body.items.length === 0;
        yield {
          transactions,
          cursor: done || !next ? null : encodeEthCursor(next),
          done,
          coverage: { from: options.since ?? null, to: options.until ?? null, note: 'Native ETH transfers for this one address. ERC-20 transfers are read separately.' },
        };
        if (done) return;
        params = decodeEthCursor(encodeEthCursor(next!));
      }
      ctx.logger.warn('ethereum page budget reached', { maxPages });
    })();
  },
};

/** ERC-20 transfer history for the watched address. Kept separate from the native-transfer stream. */
export async function fetchTokenTransfers(ctx: AdapterContext, options: { cursor?: string | null; maxPages?: number } = {}): Promise<{ items: Array<Record<string, unknown>>; cursor: string | null }> {
  const { address } = watchedAddress(ctx);
  const client = blockscoutClient(ctx);
  const items: Array<Record<string, unknown>> = [];
  let params = decodeEthCursor(options.cursor);
  for (let page = 0; page < (options.maxPages ?? 20); page += 1) {
    const response = await client.get({ path: `addresses/${address}/token-transfers`, query: { ...params, type: 'ERC-20' }, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    const body = response.data;
    if (!isRecord(body) || !Array.isArray(body.items)) break;
    for (const raw of body.items) if (isRecord(raw)) items.push(raw);
    const next = isRecord(body.next_page_params) ? body.next_page_params : null;
    if (!next || Object.keys(next).length === 0) return { items, cursor: null };
    params = decodeEthCursor(encodeEthCursor(next));
  }
  return { items, cursor: Object.keys(params).length ? encodeEthCursor(params) : null };
}
