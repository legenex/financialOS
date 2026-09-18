import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { fromBaseUnits, toDecimalString, D } from '@financialos/domain';
import { configNumber, configString, type AdapterContext } from '../core/context';
import { InvalidConfigError, ProviderResponseError } from '../core/errors';
import { isRecord, str, toInteger } from '../core/json';
import type { CoverageInfo, NormalizedAccount, NormalizedBalance, NormalizedTransaction } from '../core/records';
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
 * Bitcoin watch-only adapter over an Esplora-compatible HTTP API.
 *
 * Verified against the official Esplora API reference on 2026-09-18:
 *   https://github.com/Blockstream/esplora/blob/master/API.md
 * which states "Amounts are always represented in satoshis", documents
 * `GET /address/:address` with `chain_stats`/`mempool_stats`
 * (`funded_txo_count`, `funded_txo_sum`, `spent_txo_count`, `spent_txo_sum`, `tx_count`),
 * `GET /address/:address/txs/chain[/:last_seen_txid]` (25 transactions per page, newest first),
 * `GET /address/:address/txs/mempool` (up to 50, no paging), and `GET /fee-estimates` (sat/vB).
 *
 * Nothing here can spend: the adapter only ever issues GETs for public chain data, and it never accepts a
 * seed, a private key, or a signing request. All arithmetic is in satoshi base units (bigint) and is converted
 * to an exact decimal string at the boundary.
 */

export const ESPLORA_DEFAULT_BASE_URL = 'https://blockstream.info/api';
export const BTC_CURRENCY = 'BTC';
export const ESPLORA_CHAIN_PAGE_SIZE = 25;
export const BTC_DEFAULT_GAP_LIMIT = 20;
export const BTC_MAX_DERIVED_ADDRESSES = 200;
export const BTC_MAX_WATCHED_ADDRESSES = 500;

const base58check = createBase58check(sha256);

export type BtcScriptType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr' | 'witness_unknown';
export type BtcNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export interface BtcAddressInfo {
  address: string;
  type: BtcScriptType;
  network: BtcNetwork;
  /** Witness version for segwit addresses, otherwise null. */
  witnessVersion: number | null;
  programHex: string;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

const BECH32_HRP: Record<string, BtcNetwork> = { bc: 'mainnet', tb: 'testnet', bcrt: 'regtest' };
const BASE58_VERSIONS: Record<number, { type: BtcScriptType; network: BtcNetwork }> = {
  0x00: { type: 'p2pkh', network: 'mainnet' },
  0x05: { type: 'p2sh', network: 'mainnet' },
  0x6f: { type: 'p2pkh', network: 'testnet' },
  0xc4: { type: 'p2sh', network: 'testnet' },
};

/**
 * Validates a Bitcoin address. Segwit addresses are checked against BIP173 (bech32, witness version 0) and
 * BIP350 (bech32m, versions 1-16), including the program-length rules; legacy addresses are base58check with
 * a known version byte. Anything else is refused rather than guessed at.
 */
export function validateBtcAddress(input: string): BtcAddressInfo {
  const address = input.trim();
  if (!address || address.length > 100) throw new InvalidConfigError('A Bitcoin address must be between 1 and 100 characters.');
  if (/[A-Z]/.test(address) && /[a-z]/.test(address) && !/^[13mn2]/.test(address)) {
    throw new InvalidConfigError(`"${address.slice(0, 16)}…" mixes upper and lower case; bech32 addresses must be all one case.`);
  }
  const lower = address.toLowerCase();
  const hrp = lower.split('1')[0] ?? '';
  if (BECH32_HRP[hrp] && lower.includes('1')) {
    const network = BECH32_HRP[hrp];
    let words: number[];
    let useBech32m = false;
    try {
      words = bech32.decode(lower as `${string}1${string}`, 100).words;
    } catch {
      try {
        words = bech32m.decode(lower as `${string}1${string}`, 100).words;
        useBech32m = true;
      } catch {
        throw new InvalidConfigError(`"${address.slice(0, 16)}…" is not a valid bech32 or bech32m Bitcoin address (checksum failed).`);
      }
    }
    const version = words[0];
    if (version === undefined || version > 16) throw new InvalidConfigError('The segwit witness version is out of range.');
    const program = bech32.fromWords(words.slice(1));
    if (program.length < 2 || program.length > 40) throw new InvalidConfigError('The segwit witness program length is out of range (2-40 bytes).');
    if (version === 0) {
      if (useBech32m) throw new InvalidConfigError('Witness version 0 addresses must use bech32, not bech32m.');
      if (program.length !== 20 && program.length !== 32) throw new InvalidConfigError('A version 0 witness program must be 20 or 32 bytes.');
    } else if (!useBech32m) {
      throw new InvalidConfigError('Witness version 1 and above must use bech32m (BIP350).');
    }
    const type: BtcScriptType = version === 0 ? (program.length === 20 ? 'p2wpkh' : 'p2wsh') : version === 1 && program.length === 32 ? 'p2tr' : 'witness_unknown';
    return { address: lower, type, network, witnessVersion: version, programHex: hex(program) };
  }
  let decoded: Uint8Array;
  try {
    decoded = base58check.decode(address);
  } catch {
    throw new InvalidConfigError(`"${address.slice(0, 16)}…" is not a valid Bitcoin address (base58check checksum failed).`);
  }
  if (decoded.length !== 21) throw new InvalidConfigError('A legacy Bitcoin address must decode to 21 bytes.');
  const info = BASE58_VERSIONS[decoded[0]!];
  if (!info) throw new InvalidConfigError(`Address version byte 0x${decoded[0]!.toString(16)} is not a Bitcoin address version this deployment accepts.`);
  return { address, type: info.type, network: info.network, witnessVersion: null, programHex: hex(decoded.subarray(1)) };
}

// ---------------------------------------------------------------------------------------------------------
// Extended public key scanning (BIP44 / BIP49 / BIP84)
// ---------------------------------------------------------------------------------------------------------

/** SLIP-132 version bytes seen on extended public keys, mapped to the script type they imply. */
const XPUB_VERSIONS: Record<string, { script: 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh'; network: BtcNetwork; label: string }> = {
  '0488b21e': { script: 'p2pkh', network: 'mainnet', label: 'xpub (BIP44, legacy P2PKH)' },
  '049d7cb2': { script: 'p2sh-p2wpkh', network: 'mainnet', label: 'ypub (BIP49, P2SH-wrapped segwit)' },
  '04b24746': { script: 'p2wpkh', network: 'mainnet', label: 'zpub (BIP84, native segwit)' },
  '043587cf': { script: 'p2pkh', network: 'testnet', label: 'tpub (BIP44 testnet)' },
  '044a5262': { script: 'p2sh-p2wpkh', network: 'testnet', label: 'upub (BIP49 testnet)' },
  '045f1cf6': { script: 'p2wpkh', network: 'testnet', label: 'vpub (BIP84 testnet)' },
};
const XPUB_MAINNET_VERSION = Buffer.from('0488b21e', 'hex');
const TPUB_TESTNET_VERSION = Buffer.from('043587cf', 'hex');

export interface ExtendedKeyInfo {
  script: 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';
  network: BtcNetwork;
  label: string;
  key: HDKey;
}

/**
 * Parses an extended public key. Only the three account-level standards whose addresses can be derived from a
 * public key alone are accepted; see `BTC_UNSUPPORTED_DESCRIPTORS` for what is deliberately refused.
 */
export function parseExtendedPublicKey(input: string): ExtendedKeyInfo {
  const text = input.trim();
  let raw: Uint8Array;
  try {
    raw = base58check.decode(text);
  } catch {
    throw new InvalidConfigError('The extended public key is not valid base58check.');
  }
  if (raw.length !== 78) throw new InvalidConfigError('An extended public key must decode to 78 bytes.');
  const version = hex(raw.subarray(0, 4));
  const info = XPUB_VERSIONS[version];
  if (!info) throw new InvalidConfigError(`Extended key version 0x${version} is not supported. Use an xpub, ypub, or zpub (or the testnet equivalents).`);
  if (raw[45] !== 0x02 && raw[45] !== 0x03) throw new InvalidConfigError('This is a private extended key. FinancialOS never accepts private keys; export the public (xpub/ypub/zpub) key instead.');
  const normalised = Buffer.concat([info.network === 'mainnet' ? XPUB_MAINNET_VERSION : TPUB_TESTNET_VERSION, Buffer.from(raw.subarray(4))]);
  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(base58check.encode(new Uint8Array(normalised)));
  } catch {
    throw new InvalidConfigError('The extended public key could not be parsed.');
  }
  return { script: info.script, network: info.network, label: info.label, key };
}

/** Descriptor forms this release deliberately does not scan, with the reason the owner sees. */
export const BTC_UNSUPPORTED_DESCRIPTORS = [
  'Output descriptors (`wpkh(...)`, `sh(wpkh(...))`, `tr(...)`, `multi(...)`) are not parsed: the descriptor language, its checksum, and its key-origin syntax are a separate specification and this release does not implement them.',
  'Taproot accounts (BIP86 / `tr(...)`) are not derived: deriving a P2TR address needs a secp256k1 point tweak, and no elliptic-curve library is a dependency of this package.',
  'Multisignature and script-path accounts are not derived for the same reason.',
] as const;

export function addressFromPublicKey(publicKey: Uint8Array, script: ExtendedKeyInfo['script'], network: BtcNetwork): string {
  const pubHash = hash160(publicKey);
  if (script === 'p2wpkh') {
    const hrp = network === 'mainnet' ? 'bc' : network === 'regtest' ? 'bcrt' : 'tb';
    return bech32.encode(hrp, [0, ...bech32.toWords(pubHash)], 100);
  }
  if (script === 'p2sh-p2wpkh') {
    const redeem = new Uint8Array(22);
    redeem[0] = 0x00;
    redeem[1] = 0x14;
    redeem.set(pubHash, 2);
    const payload = new Uint8Array(21);
    payload[0] = network === 'mainnet' ? 0x05 : 0xc4;
    payload.set(hash160(redeem), 1);
    return base58check.encode(payload);
  }
  const payload = new Uint8Array(21);
  payload[0] = network === 'mainnet' ? 0x00 : 0x6f;
  payload.set(pubHash, 1);
  return base58check.encode(payload);
}

/** Derives `count` addresses on one chain (0 = receive, 1 = change) of an account-level extended key. */
export function deriveAddresses(info: ExtendedKeyInfo, chain: 0 | 1, start: number, count: number): string[] {
  const branch = info.key.deriveChild(chain);
  const out: string[] = [];
  for (let i = start; i < start + count; i += 1) {
    const child = branch.deriveChild(i);
    if (!child.publicKey) throw new InvalidConfigError('The extended key produced no public key.');
    out.push(addressFromPublicKey(child.publicKey, info.script, info.network));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Esplora client
// ---------------------------------------------------------------------------------------------------------

export interface EsploraAddressStats {
  address: string;
  confirmedSats: bigint;
  mempoolSats: bigint;
  chainTxCount: number;
  mempoolTxCount: number;
  fundedSats: bigint;
  spentSats: bigint;
}

function statsSum(node: unknown, field: string): bigint {
  if (!isRecord(node)) return 0n;
  const value = node[field];
  if (value === undefined || value === null) return 0n;
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new ProviderResponseError(`Esplora returned a non-integer ${field}`);
  return BigInt(text);
}

function esploraClient(ctx: AdapterContext): JsonClient {
  return createJsonClient({
    safeFetch: ctx.safeFetch,
    baseUrl: configString(ctx, 'baseUrl') ?? ESPLORA_DEFAULT_BASE_URL,
    logger: ctx.logger,
    signal: ctx.signal,
    providerLabel: 'Esplora',
    maxAttempts: 4,
    maxResponseBytes: 4 * 1024 * 1024,
  });
}

export async function fetchAddressStats(client: JsonClient, address: string, signal?: AbortSignal): Promise<EsploraAddressStats> {
  const response = await client.get({ path: `address/${encodeURIComponent(address)}`, ...(signal ? { signal } : {}) });
  const body = response.data;
  if (!isRecord(body)) throw new ProviderResponseError('Esplora returned no address object');
  const chain = body.chain_stats;
  const mempool = body.mempool_stats;
  const fundedChain = statsSum(chain, 'funded_txo_sum');
  const spentChain = statsSum(chain, 'spent_txo_sum');
  const fundedPool = statsSum(mempool, 'funded_txo_sum');
  const spentPool = statsSum(mempool, 'spent_txo_sum');
  return {
    address,
    confirmedSats: fundedChain - spentChain,
    mempoolSats: fundedPool - spentPool,
    chainTxCount: toInteger(isRecord(chain) ? chain.tx_count : null) ?? 0,
    mempoolTxCount: toInteger(isRecord(mempool) ? mempool.tx_count : null) ?? 0,
    fundedSats: fundedChain + fundedPool,
    spentSats: spentChain + spentPool,
  };
}

/** Current fee estimates in sat/vB, keyed by confirmation target in blocks. */
export async function fetchFeeEstimates(ctx: AdapterContext): Promise<Record<string, string>> {
  const client = esploraClient(ctx);
  const response = await client.get({ path: 'fee-estimates', ...(ctx.signal ? { signal: ctx.signal } : {}) });
  const out: Record<string, string> = {};
  if (!isRecord(response.data)) return out;
  for (const [target, value] of Object.entries(response.data)) {
    if (!/^\d{1,5}$/.test(target)) continue;
    const text = String(value);
    if (/^\d+(\.\d+)?$/.test(text)) out[target] = toDecimalString(new D(text));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------------------

function watchedAddresses(ctx: AdapterContext): { addresses: string[]; derived: number; source: string } {
  const listed = (configString(ctx, 'addresses') ?? configString(ctx, 'address') ?? '')
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean);
  const xpub = configString(ctx, 'extendedPublicKey');
  const addresses: string[] = [];
  let derived = 0;
  let source = 'address list';
  for (const entry of listed) addresses.push(validateBtcAddress(entry).address);
  if (xpub) {
    const info = parseExtendedPublicKey(xpub);
    const count = Math.min(configNumber(ctx, 'derivedAddresses') ?? BTC_DEFAULT_GAP_LIMIT * 2, BTC_MAX_DERIVED_ADDRESSES);
    const receive = deriveAddresses(info, 0, 0, count);
    const change = deriveAddresses(info, 1, 0, count);
    addresses.push(...receive, ...change);
    derived = receive.length + change.length;
    source = `${info.label}, first ${count} receive and ${count} change addresses`;
  }
  const unique = [...new Set(addresses)];
  if (unique.length === 0) throw new InvalidConfigError('No Bitcoin address or extended public key is configured for this connection.');
  if (unique.length > BTC_MAX_WATCHED_ADDRESSES) throw new InvalidConfigError(`This connection watches ${unique.length} addresses; the limit is ${BTC_MAX_WATCHED_ADDRESSES}.`);
  return { addresses: unique, derived, source };
}

export function coverageNote(addressCount: number, derived: number): string {
  const label = addressCount === 1 ? 'single address' : `${addressCount} addresses`;
  if (derived > 0) {
    return `${label} (derived from an extended public key). Addresses beyond the derived range are not watched, so balances and history may be incomplete.`;
  }
  return `${label}. Change addresses created by the owner's wallet are not watched unless they are listed here, so balances and history may be incomplete.`;
}

interface TxSummary {
  txid: string;
  inflow: bigint;
  outflow: bigint;
  fee: bigint;
  allInputsWatched: boolean;
  allOutputsWatched: boolean;
  hasWatchedInput: boolean;
  counterparty: string | null;
  confirmed: boolean;
  blockTime: number | null;
  blockHeight: number | null;
}

export function summariseTransaction(tx: Record<string, unknown>, watched: ReadonlySet<string>): TxSummary {
  const txid = str(tx.txid);
  if (!txid) throw new ProviderResponseError('Esplora returned a transaction without a txid');
  const vin = Array.isArray(tx.vin) ? tx.vin : [];
  const vout = Array.isArray(tx.vout) ? tx.vout : [];
  let inflow = 0n;
  let outflow = 0n;
  let allInputsWatched = vin.length > 0;
  let allOutputsWatched = vout.length > 0;
  let hasWatchedInput = false;
  let counterpartyIn: string | null = null;
  let counterpartyOut: string | null = null;
  for (const raw of vin) {
    if (!isRecord(raw)) continue;
    if (raw.is_coinbase === true) {
      allInputsWatched = false;
      counterpartyIn ??= 'coinbase';
      continue;
    }
    const prevout = isRecord(raw.prevout) ? raw.prevout : null;
    const address = prevout ? str(prevout.scriptpubkey_address) : null;
    const value = statsSum(prevout, 'value');
    if (address && watched.has(address)) {
      outflow += value;
      hasWatchedInput = true;
    } else {
      allInputsWatched = false;
      if (address) counterpartyIn ??= address;
    }
  }
  for (const raw of vout) {
    if (!isRecord(raw)) continue;
    const address = str(raw.scriptpubkey_address);
    const value = statsSum(raw, 'value');
    if (address && watched.has(address)) inflow += value;
    else {
      allOutputsWatched = false;
      if (address) counterpartyOut ??= address;
    }
  }
  const status = isRecord(tx.status) ? tx.status : null;
  return {
    txid,
    inflow,
    outflow,
    fee: statsSum(tx, 'fee'),
    allInputsWatched,
    allOutputsWatched,
    hasWatchedInput,
    counterparty: hasWatchedInput ? counterpartyOut : counterpartyIn,
    confirmed: status?.confirmed === true,
    blockTime: status ? toInteger(status.block_time) : null,
    blockHeight: status ? toInteger(status.block_height) : null,
  };
}

function isoDateOf(seconds: number | null, clock: Date): string {
  const instant = seconds === null ? clock : new Date(seconds * 1000);
  return instant.toISOString().slice(0, 10);
}

export function toNormalizedTransaction(summary: TxSummary, externalAccountId: string, now: Date): NormalizedTransaction {
  const net = summary.inflow - summary.outflow;
  const internal = summary.hasWatchedInput && summary.allInputsWatched && summary.allOutputsWatched;
  const instant = summary.blockTime === null ? null : new Date(summary.blockTime * 1000).toISOString();
  const amount = fromBaseUnits(net, BTC_CURRENCY);
  const description = internal
    ? 'Internal transfer between watched addresses (net effect is the miner fee)'
    : net >= 0n
      ? `Received ${fromBaseUnits(summary.inflow, BTC_CURRENCY).amount} BTC`
      : `Sent ${fromBaseUnits(summary.outflow - summary.inflow, BTC_CURRENCY).amount} BTC`;
  return {
    externalId: summary.txid,
    externalAccountId,
    bookedOn: isoDateOf(summary.blockTime, now),
    valueOn: null,
    // Bitcoin block times are UTC; the booking date is the UTC calendar date of the block.
    sourceTimezone: 'UTC',
    createdAt: instant,
    postedAt: summary.confirmed ? instant : null,
    amount,
    description,
    counterparty: summary.counterparty,
    reference: summary.txid,
    pending: !summary.confirmed,
    providerStatus: summary.confirmed ? 'confirmed' : 'mempool',
    movedMoney: true,
    categoryHint: internal ? 'transfer_internal' : null,
    cardExternalId: null,
    kind: internal ? 'internal_transfer' : net >= 0n ? 'receive' : 'send',
    raw: {
      txid: summary.txid,
      blockHeight: summary.blockHeight,
      feeSats: summary.fee.toString(),
      inflowSats: summary.inflow.toString(),
      outflowSats: summary.outflow.toString(),
      internalTransfer: internal,
      confirmed: summary.confirmed,
    },
  };
}

export const btcWatchOnlyAdapter: ProviderAdapter = {
  key: 'crypto_btc',
  method: 'watch_only_address',
  readOnly: true,

  async test(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const { addresses, derived, source } = watchedAddresses(ctx);
    const client = esploraClient(ctx);
    const tip = await client.getText({ path: 'blocks/tip/height', ...(ctx.signal ? { signal: ctx.signal } : {}) });
    const stats = await fetchAddressStats(client, addresses[0]!, ctx.signal);
    return {
      ok: true,
      detail: `The Esplora endpoint answered at block height ${inertText(tip.text, 20)}; the first watched address has ${stats.chainTxCount} confirmed transaction(s).`,
      grantedScopes: [],
      identity: addresses.length === 1 ? addresses[0]! : `${addresses.length} addresses`,
      observations: [
        `Address source: ${source}.`,
        coverageNote(addresses.length, derived),
        'Watch-only: this connection never holds a key and cannot sign or spend.',
      ],
    };
  },

  async listAccounts(ctx: AdapterContext): Promise<ListAccountsResult> {
    const { addresses, derived } = watchedAddresses(ctx);
    const first = validateBtcAddress(addresses[0]!);
    const account: NormalizedAccount = {
      externalAccountId: configString(ctx, 'externalAccountId') ?? `btc:${addresses[0]!}`,
      name: addresses.length === 1 ? `Bitcoin ${addresses[0]!.slice(0, 10)}…` : `Bitcoin wallet (${addresses.length} addresses)`,
      mask: `…${addresses[0]!.slice(-6)}`,
      currency: BTC_CURRENCY,
      kindHint: 'crypto_wallet',
      status: 'active',
      metadata: {
        addressCount: addresses.length,
        derivedAddresses: derived,
        scriptType: first.type,
        network: first.network,
        coverage: coverageNote(addresses.length, derived),
      },
    };
    return { accounts: [account], cards: [], notes: [coverageNote(addresses.length, derived), ...BTC_UNSUPPORTED_DESCRIPTORS] };
  },

  async fetchBalances(ctx: AdapterContext): Promise<FetchBalancesResult> {
    const { addresses, derived } = watchedAddresses(ctx);
    const client = esploraClient(ctx);
    const externalAccountId = configString(ctx, 'externalAccountId') ?? `btc:${addresses[0]!}`;
    const reportedAt = ctx.clock.now().toISOString();
    let confirmed = 0n;
    let mempool = 0n;
    for (const address of addresses) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
      const stats = await fetchAddressStats(client, address, ctx.signal);
      confirmed += stats.confirmedSats;
      mempool += stats.mempoolSats;
    }
    const balances: NormalizedBalance[] = [
      { externalAccountId, kind: 'provider_current', balance: fromBaseUnits(confirmed, BTC_CURRENCY), sourceAsOf: reportedAt, reportedAt },
    ];
    if (mempool !== 0n) {
      balances.push({ externalAccountId, kind: 'provider_pending', balance: fromBaseUnits(mempool, BTC_CURRENCY), sourceAsOf: reportedAt, reportedAt });
      balances.push({ externalAccountId, kind: 'provider_available', balance: fromBaseUnits(confirmed + mempool, BTC_CURRENCY), sourceAsOf: reportedAt, reportedAt });
    }
    return {
      balances,
      cashBalances: [{ externalAccountId, currency: BTC_CURRENCY, amount: fromBaseUnits(confirmed, BTC_CURRENCY).amount, asOf: reportedAt.slice(0, 10), source: 'Esplora chain_stats' }],
      notes: [
        'Confirmed and unconfirmed (mempool) balances are reported separately and never added together silently.',
        coverageNote(addresses.length, derived),
      ],
    };
  },

  fetchTransactions(ctx: AdapterContext, options: FetchTransactionsOptions): AsyncIterable<TransactionPage> {
    const { addresses, derived } = watchedAddresses(ctx);
    const watched = new Set(addresses);
    const client = esploraClient(ctx);
    const externalAccountId = configString(ctx, 'externalAccountId') ?? `btc:${addresses[0]!}`;
    const signal = options.signal ?? ctx.signal;
    const maxPages = options.maxPages ?? 400;
    const coverage: CoverageInfo = { from: options.since ?? null, to: options.until ?? null, note: coverageNote(addresses.length, derived) };

    return (async function* generate(): AsyncIterable<TransactionPage> {
      const seen = new Set<string>();
      const [startIndex, startTxid] = decodeBtcCursor(options.cursor);
      let pages = 0;
      for (let index = startIndex; index < addresses.length; index += 1) {
        const address = addresses[index]!;
        let lastSeen: string | null = index === startIndex ? startTxid : null;
        // The mempool is only read on the first page for an address, and only when resuming from the start.
        if (lastSeen === null) {
          const pool = await client.get({ path: `address/${encodeURIComponent(address)}/txs/mempool`, ...(signal ? { signal } : {}) });
          const transactions = collect(pool.data, watched, seen, externalAccountId, ctx.clock.now(), options);
          if (transactions.length > 0) yield { transactions, cursor: encodeBtcCursor(index, null), done: false, coverage };
        }
        for (;;) {
          if (signal?.aborted) throw signal.reason ?? new Error('aborted');
          pages += 1;
          if (pages > maxPages) {
            yield { transactions: [], cursor: encodeBtcCursor(index, lastSeen), done: false, coverage };
            return;
          }
          const path = lastSeen
            ? `address/${encodeURIComponent(address)}/txs/chain/${encodeURIComponent(lastSeen)}`
            : `address/${encodeURIComponent(address)}/txs/chain`;
          const page = await client.get({ path, ...(signal ? { signal } : {}) });
          const list = Array.isArray(page.data) ? page.data : [];
          const transactions = collect(page.data, watched, seen, externalAccountId, ctx.clock.now(), options);
          const lastEntry = list[list.length - 1];
          const nextSeen = isRecord(lastEntry) ? str(lastEntry.txid) : null;
          const addressDone = list.length < ESPLORA_CHAIN_PAGE_SIZE || !nextSeen;
          const streamDone = addressDone && index === addresses.length - 1;
          if (transactions.length > 0 || streamDone) {
            yield {
              transactions,
              cursor: streamDone ? null : encodeBtcCursor(addressDone ? index + 1 : index, addressDone ? null : nextSeen),
              done: streamDone,
              coverage,
            };
          }
          if (addressDone) break;
          lastSeen = nextSeen;
        }
      }
    })();
  },
};

function collect(
  payload: unknown,
  watched: ReadonlySet<string>,
  seen: Set<string>,
  externalAccountId: string,
  now: Date,
  options: FetchTransactionsOptions,
): NormalizedTransaction[] {
  if (!Array.isArray(payload)) throw new ProviderResponseError('Esplora returned a transaction list that is not an array');
  const out: NormalizedTransaction[] = [];
  for (const raw of payload) {
    if (!isRecord(raw)) continue;
    const summary = summariseTransaction(raw, watched);
    // The same transaction appears under every watched address it touches; it becomes one record.
    if (seen.has(summary.txid)) continue;
    seen.add(summary.txid);
    const record = toNormalizedTransaction(summary, externalAccountId, now);
    if (options.since && record.bookedOn < options.since) continue;
    if (options.until && record.bookedOn > options.until) continue;
    out.push(record);
  }
  return out;
}

export function encodeBtcCursor(addressIndex: number, lastSeenTxid: string | null): string {
  return `${addressIndex}:${lastSeenTxid ?? ''}`;
}

export function decodeBtcCursor(cursor: string | null | undefined): [number, string | null] {
  if (!cursor) return [0, null];
  const match = /^(\d{1,4}):([0-9a-f]{64})?$/.exec(cursor);
  if (!match) throw new InvalidConfigError('The Bitcoin sync cursor is not in the expected form.');
  return [Number(match[1]), match[2] ?? null];
}
