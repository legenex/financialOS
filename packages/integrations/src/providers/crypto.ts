import type { ProviderDescriptor } from '@financialos/contracts';
import { BTC_UNSUPPORTED_DESCRIPTORS, ESPLORA_DEFAULT_BASE_URL } from '../adapters/btcWatchOnly';
import { BLOCKSCOUT_DEFAULT_BASE_URL, ETH_UNSUPPORTED_CHAINS } from '../adapters/ethWatchOnly';
import {
  CHECKED_ON,
  booleanField,
  capabilities,
  no,
  numberField,
  readOnlyMethod,
  textField,
  unverifiedHistory,
  urlField,
  yes,
} from './support';

const WATCH_ONLY_NOTE =
  'Watch-only. FinancialOS never asks for, stores, or accepts a seed phrase, a private key, or a signing request, and no code path in this package can construct or broadcast a transaction.';

export const cryptoBtcProvider: ProviderDescriptor = {
  key: 'crypto_btc',
  name: 'Bitcoin (watch-only)',
  category: 'wallet',
  regions: ['Global'],
  summary: 'Balances and history for Bitcoin addresses you own, read from an Esplora-compatible public API. Watch-only: no key ever enters FinancialOS.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Verified on 2026-09-18 against https://github.com/Blockstream/esplora/blob/master/API.md, which states "Amounts are always represented in satoshis" and documents GET /address/:address with chain_stats and mempool_stats (funded_txo_sum, spent_txo_sum, tx_count), GET /address/:address/txs/chain[/:last_seen_txid] returning 25 transactions per page newest first, GET /address/:address/txs/mempool returning up to 50 with no paging, and GET /fee-estimates in sat/vB. All arithmetic is done in satoshi base units as bigint and converted to an exact decimal string at the boundary. Confirmed and mempool balances are reported separately and never silently added. A transaction whose inputs and outputs are all watched addresses is labelled an internal transfer, and its net effect is the miner fee. Coverage is labelled explicitly ("single address" or "N addresses") with a standing caveat that wallet change addresses are invisible unless they are watched. No rate limit is published for the default public instance.',
  methods: [
    readOnlyMethod({
      method: 'watch_only_address',
      label: 'Watch-only addresses or extended public key',
      description: 'One or more addresses, or an account-level xpub/ypub/zpub, read through an Esplora-compatible endpoint.',
      fields: [
        textField('addresses', 'Addresses', 'One or more Bitcoin addresses, separated by spaces, commas, or new lines. Bech32, bech32m, and base58check addresses are validated before anything is fetched.', false),
        textField('extendedPublicKey', 'Extended public key', 'Optional account-level xpub (BIP44), ypub (BIP49), or zpub (BIP84). Receive and change addresses are derived from it. A private key is refused.', false),
        numberField('derivedAddresses', 'Addresses to derive per chain', 'How many receive and change addresses to derive from an extended key. Default 40 each; the maximum watched in total is 500.'),
        urlField('baseUrl', 'Esplora base URL', `The Esplora-compatible API to read from. Default ${ESPLORA_DEFAULT_BASE_URL}. Point it at your own instance to avoid a third party seeing your addresses.`, false),
        textField('externalAccountId', 'Account identifier', 'Optional stable id for this wallet. Defaults to btc:<first address>.', false),
      ],
      ownerActivationSteps: [
        'In your wallet, copy the receiving address, or (better) the account-level extended public key: xpub for a legacy account, ypub for a P2SH-wrapped segwit account, zpub for a native segwit account.',
        'Never copy the seed phrase or a private key. FinancialOS refuses an extended private key and has no use for either.',
        'Paste the value into this connection.',
        'Add the Esplora host to the outbound allowlist in Settings if it is not already there. Point it at your own Esplora or mempool instance if you prefer not to reveal your addresses to a public explorer.',
        'Press Test. The coverage line tells you how many addresses are watched and warns that change addresses outside the watched set are invisible.',
      ],
      capabilities: capabilities({
        balances: yes('Confirmed (chain_stats) and unconfirmed (mempool_stats) sums, reported separately, exact in satoshis.'),
        transactions: yes('Paged confirmed history (25 per page) plus mempool transactions, deduplicated across watched addresses, with internal transfers labelled.'),
        pendingTransactions: yes('Mempool transactions are recorded as pending until they confirm.'),
        holdings: no('A Bitcoin address holds one asset. The balance is the position; there is no separate holdings snapshot.'),
        statements: no('A public chain API publishes no statements.'),
      }),
      historyLimit: unverifiedHistory(null, 'The full chain history of each watched address. Depth is limited only by how many pages the sync is allowed to walk.'),
      fileKinds: [],
      verificationLevel: 'implemented',
      documentationUrls: ['https://github.com/Blockstream/esplora/blob/master/API.md', 'https://mempool.space/docs/api/rest'],
      unsupportedProducts: [
        WATCH_ONLY_NOTE,
        ...BTC_UNSUPPORTED_DESCRIPTORS,
        'Fiat valuation is not part of this connection; enable public market data separately if you want a fiat figure.',
      ],
      scheduleSupported: true,
    }),
  ],
};

export const cryptoEthProvider: ProviderDescriptor = {
  key: 'crypto_eth',
  name: 'Ethereum (watch-only)',
  category: 'wallet',
  regions: ['Global'],
  summary: 'Native ETH and ERC-20 balances plus transaction history for one Ethereum mainnet address, read from Blockscout or from your own node.',
  checkedOn: CHECKED_ON,
  capabilityNotes:
    'Verified on 2026-09-18 against https://docs.blockscout.com/devs/apis/rest and the live schema at https://eth.blockscout.com/api-docs. GET /api/v2/addresses/{hash} returns coin_balance as a decimal string in wei; GET /api/v2/addresses/{hash}/transactions returns { items, next_page_params } with keyset paging (50 per page) and per-item fee { type, value }; GET /api/v2/addresses/{hash}/token-balances returns a bare array whose token object uses address_hash and a string decimals. Amounts are converted from wei and from token base units by exact string arithmetic; no floating point is involved. Mixed-case addresses are checked against the EIP-55 checksum. Only Ethereum mainnet is enabled. An optional JSON-RPC mode reads eth_chainId, eth_blockNumber, and eth_getBalance from a node the owner runs; the method name is checked against a fixed read-only list, so no signing or broadcast method is reachable.',
  methods: [
    readOnlyMethod({
      method: 'watch_only_address',
      label: 'Watch-only address',
      description: 'One Ethereum mainnet address, read through Blockscout or, optionally, through your own JSON-RPC node.',
      fields: [
        textField('address', 'Ethereum address', 'The 0x address to watch. A mixed-case address must pass its EIP-55 checksum.', true, '^0x[0-9a-fA-F]{40}$'),
        urlField('baseUrl', 'Blockscout base URL', `The Blockscout v2 API to read from. Default ${BLOCKSCOUT_DEFAULT_BASE_URL}.`, false),
        urlField('rpcUrl', 'JSON-RPC URL', 'Optional. Your own Ethereum node. Only eth_chainId, eth_blockNumber, eth_getBalance, eth_getTransactionCount, and eth_call are ever called.', false),
        booleanField('useRpc', 'Prefer the JSON-RPC node', 'When on, balances are read from your node instead of the public explorer. History still comes from the explorer.'),
        textField('externalAccountId', 'Account identifier', 'Optional stable id for this wallet. Defaults to eth:<address>.', false),
      ],
      ownerActivationSteps: [
        'Copy the 0x address from your wallet. Never copy the seed phrase or a private key.',
        'Paste it into this connection.',
        'Add the explorer host (and your node, if you use one) to the outbound allowlist in Settings.',
        'If you run your own node, fill in the JSON-RPC URL and switch "Prefer the JSON-RPC node" on so balances come from a source you control.',
        'Press Test. The result says whether the address is a contract and how many ERC-20 positions the explorer lists.',
      ],
      capabilities: capabilities({
        balances: yes('Native balance in wei converted exactly to ETH, plus ERC-20 balances converted with each token\'s own decimals.'),
        transactions: yes('Native transfers for this address with keyset paging. The sender\'s fee is included in the net amount; a reverted transaction moves no value but still costs its fee.'),
        pendingTransactions: yes('A transaction with no block number is recorded as pending.'),
        holdings: no('ERC-20 positions are reported as per-token cash balances, not as a brokerage holdings snapshot with prices.'),
        statements: no('A public chain API publishes no statements.'),
      }),
      historyLimit: unverifiedHistory(null, 'The full history the explorer indexes for this address. Depth is limited only by how many pages the sync is allowed to walk.'),
      fileKinds: [],
      verificationLevel: 'implemented',
      documentationUrls: ['https://docs.blockscout.com/devs/apis/rest', 'https://eth.blockscout.com/api-docs'],
      unsupportedProducts: [
        WATCH_ONLY_NOTE,
        ...ETH_UNSUPPORTED_CHAINS,
        'ERC-721 and ERC-1155 positions are listed by the explorer but are not valued or recorded; only fungible ERC-20 balances are read.',
        'Internal transactions (contract-initiated value transfers) are not read in this release; only top-level transactions and ERC-20 transfers are.',
        'In JSON-RPC node mode, ERC-20 balances are not read: that needs a per-token contract call, which this release does not perform.',
      ],
      scheduleSupported: true,
    }),
  ],
};
