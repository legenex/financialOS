import type { Money } from '@financialos/contracts';

/**
 * Normalised records returned by adapters and file parsers. The worker writes them to the database as
 * immutable source records; nothing here is a ledger entry yet.
 */

export type IsoDateString = string;
export type IsoDateTimeString = string;

export interface CoverageInfo {
  from: IsoDateString | null;
  to: IsoDateString | null;
  /** Human-readable caveat (e.g. "single address; change addresses may be missing"). */
  note: string | null;
}

export interface NormalizedAccount {
  externalAccountId: string;
  name: string;
  /** Masked identifier only, e.g. "****1234". */
  mask: string | null;
  currency: string | null;
  kindHint: 'current' | 'savings' | 'card' | 'credit_card' | 'brokerage' | 'crypto_wallet' | 'other';
  status: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

export interface NormalizedBalance {
  externalAccountId: string;
  kind: 'provider_current' | 'provider_available' | 'statement_opening' | 'statement_closing' | 'provider_pending';
  balance: Money;
  /** When the provider says the balance applies, if it says. */
  sourceAsOf: IsoDateTimeString | null;
  reportedAt: IsoDateTimeString;
}

export interface NormalizedCard {
  externalCardId: string;
  lastFour: string | null;
  network: string | null;
  status: string | null;
  kind: string | null;
  nameOnCard: string | null;
}

export interface NormalizedTransaction {
  externalId: string;
  externalAccountId: string;
  /** Local calendar date the transaction is booked on (posted date when posted, created date when pending). */
  bookedOn: IsoDateString;
  valueOn: IsoDateString | null;
  sourceTimezone: string;
  createdAt: IsoDateTimeString | null;
  postedAt: IsoDateTimeString | null;
  /** Signed amount: positive is money in, negative is money out. */
  amount: Money;
  description: string;
  counterparty: string | null;
  reference: string | null;
  pending: boolean;
  /** Provider status verbatim (e.g. "sent", "failed"). */
  providerStatus: string | null;
  /** Failed/cancelled/blocked provider transactions never moved money and must not be posted. */
  movedMoney: boolean;
  categoryHint: string | null;
  cardExternalId: string | null;
  kind: string | null;
  /** Provider payload with secrets removed, kept for evidence and re-processing. */
  raw: Record<string, unknown>;
}

export type InvestmentTransactionKind =
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'payment_in_lieu'
  | 'withholding_tax'
  | 'interest_received'
  | 'interest_paid'
  | 'fee'
  | 'deposit'
  | 'withdrawal'
  | 'corporate_action'
  | 'transfer_in'
  | 'transfer_out'
  | 'other';

export interface NormalizedInvestmentTransaction {
  externalId: string;
  externalAccountId: string;
  kind: InvestmentTransactionKind;
  tradeDate: IsoDateString;
  settleDate: IsoDateString | null;
  symbol: string | null;
  instrumentId: string | null;
  isin: string | null;
  assetClass: string | null;
  description: string;
  /** Signed quantity (negative for sells) or null when not applicable. */
  quantity: string | null;
  price: string | null;
  /** Gross trade value or cash amount, signed from the account's perspective. */
  grossAmount: string | null;
  commission: string | null;
  /** Net cash effect on the account, signed. */
  netAmount: string | null;
  currency: string;
  raw: Record<string, unknown>;
}

export interface NormalizedHoldingLine {
  symbol: string;
  name: string | null;
  instrumentId: string | null;
  isin: string | null;
  assetClass: string | null;
  quantity: string | null;
  price: string | null;
  value: string | null;
  costBasis: string | null;
  currency: string;
  fxRateToBase: string | null;
  priceKind: 'end_of_day' | 'statement' | 'delayed' | 'real_time' | 'unknown';
}

export interface NormalizedHoldingsSnapshot {
  externalAccountId: string;
  asOf: IsoDateString | null;
  /** 'complete' only when the source states the full position list was included. */
  completeness: 'complete' | 'partial' | 'unknown';
  source: string;
  lines: NormalizedHoldingLine[];
}

export interface NormalizedCashBalance {
  externalAccountId: string;
  currency: string;
  amount: string;
  asOf: IsoDateString | null;
  source: string;
}

export interface NormalizedFxRate {
  base: string;
  quote: string;
  /** 1 base = rate quote */
  rate: string;
  asOf: IsoDateString;
  source: string;
}

export interface NormalizedPrice {
  assetId: string;
  currency: string;
  price: string;
  asOf: IsoDateTimeString | null;
  source: string;
  priceKind: 'end_of_day' | 'delayed' | 'real_time' | 'unknown';
}

export interface NormalizedCorporateAction {
  externalId: string;
  externalAccountId: string;
  type: string;
  description: string;
  symbol: string | null;
  quantity: string | null;
  reportDate: IsoDateString | null;
  raw: Record<string, unknown>;
}
