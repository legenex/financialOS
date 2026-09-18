import type { AuthMethod } from '@financialos/contracts';
import type { AdapterContext } from '../core/context';
import type {
  CoverageInfo,
  IsoDateString,
  NormalizedAccount,
  NormalizedBalance,
  NormalizedCard,
  NormalizedCashBalance,
  NormalizedCorporateAction,
  NormalizedFxRate,
  NormalizedHoldingsSnapshot,
  NormalizedInvestmentTransaction,
  NormalizedTransaction,
} from '../core/records';

/**
 * The contract every provider adapter implements. Adapters are read-only by construction: there is no method
 * that could move money, place an order, change a card, or send a message, and the HTTP clients they are given
 * refuse anything but GET unless the adapter's own documented protocol requires otherwise (MCP and OAuth token
 * exchange, which are still reads of data or of a token).
 *
 * Every capability is optional. The registry declares which ones a provider/method pair actually offers, and
 * the worker calls only those. A missing method means "this provider cannot do this", never "not written yet";
 * where a capability is deliberately unimplemented the descriptor says so in `capabilities[x].note`.
 */
export interface ProviderAdapter {
  /** Provider key from the registry (e.g. 'mercury'). */
  readonly key: string;
  /** Which credential/auth method of that provider this adapter implements. */
  readonly method: AuthMethod;
  /** Structural marker: an adapter that is not read-only cannot exist in this package. */
  readonly readOnly: true;

  /** Checks the stored credential and reports what the provider says about it. Never writes. */
  test?(ctx: AdapterContext): Promise<ConnectionTestResult>;

  /** Lists the accounts the credential can see, for owner mapping. */
  listAccounts?(ctx: AdapterContext): Promise<ListAccountsResult>;

  /** Current/available balances as the provider reports them right now. */
  fetchBalances?(ctx: AdapterContext): Promise<FetchBalancesResult>;

  /**
   * Yields pages of transactions. Implementations must be resumable: each page carries the cursor that would
   * restart the stream immediately after it, and must stop promptly when `options.signal` (or `ctx.signal`)
   * aborts.
   */
  fetchTransactions?(ctx: AdapterContext, options: FetchTransactionsOptions): AsyncIterable<TransactionPage>;

  /** A point-in-time position snapshot. */
  fetchHoldings?(ctx: AdapterContext): Promise<FetchHoldingsResult>;

  /** Trades, dividends, fees, and cash movements on an investment account. */
  fetchInvestmentTransactions?(ctx: AdapterContext, options?: FetchInvestmentOptions): Promise<InvestmentTransactionsResult>;
}

export interface FetchTransactionsOptions {
  /** Inclusive lower bound on the booking date. */
  since?: IsoDateString | null;
  /** Inclusive upper bound on the booking date. */
  until?: IsoDateString | null;
  /** Opaque resume token from a previous page. */
  cursor?: string | null;
  signal?: AbortSignal;
  /** Soft cap on pages fetched in one run, so a long backfill can be split across jobs. */
  maxPages?: number;
}

export interface FetchInvestmentOptions {
  since?: IsoDateString | null;
  until?: IsoDateString | null;
  signal?: AbortSignal;
}

export interface TransactionPage {
  transactions: NormalizedTransaction[];
  /**
   * Resume token: pass it back as `options.cursor` to continue immediately after this page.
   * `null` means the stream is complete and a fresh run should start from the date window again.
   */
  cursor: string | null;
  /** True on the last page the provider has for this window. */
  done: boolean;
  /** What this page actually covers, when the provider states it. */
  coverage?: CoverageInfo;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Short, owner-readable sentence. Never contains credentials or raw provider payloads. */
  detail: string;
  /** Scopes/permissions the provider says the credential holds, when it says. */
  grantedScopes: string[];
  /** Identifier of the entity the credential belongs to, masked if it is account-like. */
  identity: string | null;
  /** Capability observations made during the test (e.g. tools an MCP server exposes). */
  observations: string[];
}

export interface ListAccountsResult {
  accounts: NormalizedAccount[];
  cards: NormalizedCard[];
  /** What the provider did not return (e.g. closed accounts, other products). */
  notes: string[];
}

export interface FetchBalancesResult {
  balances: NormalizedBalance[];
  /** Per-currency cash positions where the provider reports them separately (brokers, wallets). */
  cashBalances: NormalizedCashBalance[];
  notes: string[];
}

export interface FetchHoldingsResult {
  snapshots: NormalizedHoldingsSnapshot[];
  fxRates: NormalizedFxRate[];
  notes: string[];
}

export interface InvestmentTransactionsResult {
  transactions: NormalizedInvestmentTransaction[];
  corporateActions: NormalizedCorporateAction[];
  cashBalances: NormalizedCashBalance[];
  fxRates: NormalizedFxRate[];
  coverage: CoverageInfo;
  notes: string[];
}

/** Convenience for adapters that fetch everything in one call but must still expose a page stream. */
export async function* singlePage(transactions: NormalizedTransaction[], coverage?: CoverageInfo): AsyncIterable<TransactionPage> {
  yield { transactions, cursor: null, done: true, ...(coverage ? { coverage } : {}) };
}

/** Drains an adapter page stream into one array. Used by tests and small syncs; not for large backfills. */
export async function collectTransactions(pages: AsyncIterable<TransactionPage>): Promise<NormalizedTransaction[]> {
  const out: NormalizedTransaction[] = [];
  for await (const page of pages) out.push(...page.transactions);
  return out;
}
