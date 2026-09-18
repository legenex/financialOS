/**
 * @financialos/integrations
 *
 * File parsers, provider adapters, and the capability registry. Everything here is read-only: no export can
 * initiate a payment, a transfer, a card change, or a trade, and no adapter accepts a key, a seed, or a
 * signature. All outbound HTTP goes through the SSRF-guarded fetch the worker supplies.
 */

// Core types shared by parsers and adapters.
export * from './core/records';
export * from './core/context';
export * from './core/errors';
export * from './core/json';
export * from './core/redact';

// File parsing.
export * from './files/sniff';
export * from './files/zip';
export * from './files/csv';
export * from './files/xlsx';
export * from './files/ofx';
export * from './files/ibkrFlex';
export * from './files/pdf';
export * from './files/normalize';
export * from './files/templates';
export * from './files/pipeline';

// Adapter contract and HTTP support.
export * from './adapters/types';
export { createJsonClient, inertText, joinUrl, statusToError, type JsonClient, type JsonRequest, type JsonResponse, type JsonClientConfig } from './adapters/http';

// Provider adapters.
export { mercuryAdapter, createMercuryClient, fetchAccountTransactions, mapTransaction as mapMercuryTransaction, MERCURY_BASE_URL } from './adapters/mercury';
export {
  ibkrFlexAdapter,
  runFlexStatement,
  parseFlexEnvelope,
  FlexServiceError,
  FLEX_BASE_URL,
  FLEX_ERROR_MESSAGES,
  FLEX_RETRYABLE_CODES,
  FLEX_CREDENTIAL_CODES,
  FLEX_CONFIG_CODES,
} from './adapters/ibkrFlex';
export * from './adapters/mcpClient';
export * from './adapters/mcpOAuth';
export * from './adapters/customMcp';
export * from './adapters/customHttp';
export * from './adapters/btcWatchOnly';
export {
  ethWatchOnlyAdapter,
  validateEthAddress,
  toChecksumAddress,
  unitsToDecimal,
  fetchTokenBalances,
  fetchTokenTransfers,
  mapEthTransaction,
  decodeEthCursor,
  readViaRpc,
  ethRpcCall,
  BLOCKSCOUT_DEFAULT_BASE_URL,
  ETH_CURRENCY,
  ETH_RPC_ALLOWED_METHODS,
  ETH_UNSUPPORTED_CHAINS,
  type Erc20Balance,
  type EthAddressInfo,
} from './adapters/ethWatchOnly';
export * from './adapters/prices';
export * from './adapters/ai';
export * from './adapters/email';

// Registry.
export * from './registry';
export { CHECKED_ON } from './providers/support';
