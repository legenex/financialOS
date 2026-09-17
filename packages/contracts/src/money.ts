import { z } from 'zod';
import {
  AccountKind,
  Confidence,
  ConvertedMoney,
  CurrencyCode,
  DecimalString,
  EntityKind,
  Freshness,
  Id,
  IsoDate,
  IsoDateTime,
  LiquidityClass,
  MaybeMoney,
  Money,
  Provenance,
  TransactionNature,
  pageOf,
} from './common';

export const Entity = z.object({
  id: Id,
  name: z.string(),
  kind: EntityKind,
  jurisdiction: z.string().nullable(),
  baseCurrency: CurrencyCode.nullable(),
  ownerControlled: z.boolean(),
  primaryOwner: z.boolean(),
  legalStatusConfirmed: z.boolean(),
  notes: z.string().nullable(),
});
export type Entity = z.infer<typeof Entity>;

export const EntityInput = Entity.omit({ id: true, primaryOwner: true });
export type EntityInput = z.infer<typeof EntityInput>;

export const Institution = z.object({
  id: Id,
  name: z.string(),
  country: z.string().nullable(),
  kind: z.enum(['bank', 'broker', 'wallet', 'fund', 'issuer', 'lender', 'other']),
  providerKey: z.string().nullable(),
});
export type Institution = z.infer<typeof Institution>;

export const Valuation = z.object({
  value: MaybeMoney,
  reporting: ConvertedMoney.nullable(),
  basis: z.enum([
    'verified_holdings',
    'provider_balance',
    'statement_closing',
    'ledger_balance',
    'owner_reported_total',
    'unknown',
  ]),
  asOf: IsoDateTime.nullable(),
  reportedAt: IsoDateTime.nullable(),
  approximate: z.boolean(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  provenance: Provenance.nullable(),
});
export type Valuation = z.infer<typeof Valuation>;

export const Account = z.object({
  id: Id,
  name: z.string(),
  kind: AccountKind,
  currency: CurrencyCode.nullable(),
  institution: Institution.pick({ id: true, name: true, kind: true }).nullable(),
  legalEntityId: Id.nullable(),
  legalEntityName: z.string().nullable(),
  economicOwnerEntityId: Id.nullable(),
  economicOwnerName: z.string().nullable(),
  ownershipConfirmed: z.boolean(),
  liquidityClass: LiquidityClass,
  includeInSafeToSpend: z.boolean(),
  status: z.enum(['active', 'closed']),
  maskedIdentifier: z.string().nullable(),
  connectionId: Id.nullable(),
  valuation: Valuation,
  freshness: Freshness,
  notes: z.string().nullable(),
  openExceptions: z.number().int(),
});
export type Account = z.infer<typeof Account>;

export const AccountInput = z.object({
  name: z.string().min(1).max(120),
  kind: AccountKind,
  currency: CurrencyCode.nullable(),
  institutionId: Id.nullable(),
  legalEntityId: Id.nullable(),
  economicOwnerEntityId: Id.nullable(),
  ownershipConfirmed: z.boolean(),
  liquidityClass: LiquidityClass,
  includeInSafeToSpend: z.boolean(),
  maskedIdentifier: z
    .string()
    .regex(/^[*•xX\d ]{0,12}$/, 'Only store a masked identifier such as ****1234')
    .nullable(),
  notes: z.string().max(2000).nullable(),
});
export type AccountInput = z.infer<typeof AccountInput>;

export const BalanceSnapshot = z.object({
  id: Id,
  accountId: Id,
  kind: z.enum([
    'owner_reported_total',
    'statement_opening',
    'statement_closing',
    'provider_current',
    'provider_available',
    'opening',
    'manual',
  ]),
  balance: Money,
  approximate: z.boolean(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  reportedAt: IsoDateTime,
  sourceAsOf: IsoDateTime.nullable(),
  provenance: Provenance,
  composition: z
    .array(z.object({ instrumentSymbol: z.string(), quantity: DecimalString.nullable(), approximate: z.boolean() }))
    .nullable(),
  supersededBy: Id.nullable(),
});
export type BalanceSnapshot = z.infer<typeof BalanceSnapshot>;

export const BalanceSnapshotInput = z.object({
  accountId: Id,
  kind: z.enum(['owner_reported_total', 'statement_closing', 'manual', 'opening']),
  balance: Money,
  approximate: z.boolean(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  sourceAsOf: IsoDateTime.nullable(),
  source: z.string().max(200),
  documentId: Id.nullable(),
});
export type BalanceSnapshotInput = z.infer<typeof BalanceSnapshotInput>;

export const SplitLine = z.object({
  amount: DecimalString,
  categoryId: Id.nullable(),
  nature: TransactionNature,
  economicOwnerEntityId: Id.nullable(),
  memo: z.string().max(500).nullable(),
});
export type SplitLine = z.infer<typeof SplitLine>;

export const Transaction = z.object({
  id: Id,
  accountId: Id,
  accountName: z.string(),
  entityId: Id.nullable(),
  bookedOn: IsoDate,
  valueOn: IsoDate.nullable(),
  sourceTimezone: z.string().nullable(),
  status: z.enum(['pending', 'posted', 'reversed', 'superseded']),
  amount: Money,
  reporting: ConvertedMoney.nullable(),
  description: z.string(),
  counterparty: z.string().nullable(),
  category: z.object({ id: Id, name: z.string() }).nullable(),
  nature: TransactionNature,
  economicOwnerEntityId: Id.nullable(),
  classification: z.object({
    version: z.number().int(),
    method: z.enum(['rule', 'user', 'model', 'provider', 'transfer_match', 'bootstrap', 'none']),
    confidence: Confidence,
    needsReview: z.boolean(),
  }),
  splits: z.array(SplitLine).nullable(),
  transferMatch: z
    .object({ matchId: Id, otherTransactionId: Id, confidence: Confidence, status: z.enum(['suggested', 'confirmed', 'rejected']) })
    .nullable(),
  tags: z.array(z.string()),
  source: z.object({ kind: z.enum(['import', 'provider_api', 'manual']), batchId: Id.nullable(), externalId: z.string().nullable() }),
  documentIds: z.array(Id),
});
export type Transaction = z.infer<typeof Transaction>;

export const TransactionPage = pageOf(Transaction);
export type TransactionPage = z.infer<typeof TransactionPage>;

export const TransactionQuery = z.object({
  q: z.string().max(200).optional(),
  accountId: Id.optional(),
  entityId: Id.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  nature: TransactionNature.optional(),
  categoryId: Id.optional(),
  needsReview: z.coerce.boolean().optional(),
  status: z.enum(['pending', 'posted', 'reversed', 'superseded']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TransactionQuery = z.infer<typeof TransactionQuery>;

export const ClassificationInput = z.object({
  categoryId: Id.nullable(),
  nature: TransactionNature,
  economicOwnerEntityId: Id.nullable(),
  counterpartyId: Id.nullable().optional(),
  splits: z.array(SplitLine).max(20).nullable(),
  note: z.string().max(500).nullable(),
  createRule: z
    .object({ matchDescription: z.string().max(200).nullable(), matchCounterparty: z.string().max(200).nullable() })
    .nullable()
    .optional(),
});
export type ClassificationInput = z.infer<typeof ClassificationInput>;

export const Category = z.object({
  id: Id,
  parentId: Id.nullable(),
  name: z.string(),
  kind: z.enum(['expense', 'income', 'transfer', 'other']),
  essential: z.boolean(),
});
export type Category = z.infer<typeof Category>;

export const Instrument = z.object({
  id: Id,
  symbol: z.string(),
  name: z.string(),
  kind: z.enum(['equity', 'etf', 'fund', 'crypto', 'bond', 'cash', 'private_note', 'restricted_equity', 'other']),
  currency: CurrencyCode.nullable(),
  exchange: z.string().nullable(),
  isin: z.string().nullable(),
});
export type Instrument = z.infer<typeof Instrument>;

export const HoldingLine = z.object({
  instrument: Instrument,
  quantity: DecimalString.nullable(),
  price: Money.nullable(),
  priceAsOf: IsoDateTime.nullable(),
  priceSource: z.string().nullable(),
  priceKind: z.enum(['real_time', 'delayed', 'end_of_day', 'manual', 'statement', 'unknown']).nullable(),
  value: MaybeMoney,
  reporting: ConvertedMoney.nullable(),
  costBasis: Money.nullable(),
  costBasisComplete: z.boolean(),
  unrealisedGain: Money.nullable(),
  restricted: z.boolean(),
});
export type HoldingLine = z.infer<typeof HoldingLine>;

export const Holdings = z.object({
  accountId: Id,
  asOf: IsoDateTime.nullable(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  source: z.string(),
  lines: z.array(HoldingLine),
});
export type Holdings = z.infer<typeof Holdings>;

export const PortfolioSummary = z.object({
  currency: CurrencyCode,
  status: z.enum(['ok', 'provisional', 'insufficient_data']),
  totalMarketable: Money.nullable(),
  allocation: z.array(z.object({ label: z.string(), value: Money, share: DecimalString })),
  currencyExposure: z.array(z.object({ currency: CurrencyCode, value: Money, share: DecimalString })),
  concentration: z.array(z.object({ label: z.string(), share: DecimalString, warning: z.boolean() })),
  costBasisCompleteness: DecimalString.nullable(),
  income: z.object({ dividends: Money.nullable(), interest: Money.nullable(), fees: Money.nullable() }),
  performance: z.object({
    method: z.enum(['time_weighted', 'money_weighted', 'none']),
    value: DecimalString.nullable(),
    marketChange: Money.nullable(),
    netContributions: Money.nullable(),
    reasonUnavailable: z.string().nullable(),
  }),
  restricted: z.array(
    z.object({
      accountId: Id,
      instrument: z.string(),
      quantity: DecimalString.nullable(),
      indicativeValue: Money.nullable(),
      restrictionStatus: z.enum(['verified', 'reported_unverified', 'none_recorded']),
      note: z.string(),
    }),
  ),
});
export type PortfolioSummary = z.infer<typeof PortfolioSummary>;

export const Restriction = z.object({
  id: Id,
  accountId: Id,
  instrumentId: Id.nullable(),
  kind: z.enum(['volume_cap', 'lockup', 'vesting', 'transfer_restriction', 'other']),
  status: z.enum(['reported_unverified', 'verified', 'expired', 'rejected']),
  terms: z.record(z.string(), z.unknown()),
  effectiveFrom: IsoDate.nullable(),
  effectiveTo: IsoDate.nullable(),
  documentId: Id.nullable(),
  notes: z.string().nullable(),
});
export type Restriction = z.infer<typeof Restriction>;

export const SaleScheduleRequest = z.object({
  accountId: Id,
  quantity: DecimalString,
  volumeSource: z.enum(['actual', 'hypothetical']),
  averageDailyVolume: DecimalString,
  hypotheticalPrice: DecimalString.nullable(),
  priceCurrency: CurrencyCode.nullable(),
  tradingDaysPerWeek: z.number().int().min(1).max(7).default(5),
});
export type SaleScheduleRequest = z.infer<typeof SaleScheduleRequest>;

export const SaleScheduleResult = z.object({
  status: z.enum(['ok', 'blocked_unverified_terms', 'insufficient_data']),
  maxSharesPerDay: DecimalString.nullable(),
  tradingDaysRequired: z.number().int().nullable(),
  indicativeGross: Money.nullable(),
  caveats: z.array(z.string()),
});
export type SaleScheduleResult = z.infer<typeof SaleScheduleResult>;

export const FixedIncomeTerms = z.object({
  accountId: Id,
  principal: Money.nullable(),
  statedAnnualRate: DecimalString.nullable(),
  rateBasis: z.enum(['nominal', 'effective', 'unverified']),
  compounding: z.enum(['monthly', 'quarterly', 'annually', 'daily', 'simple', 'unknown']),
  fees: z.string().nullable(),
  withdrawalTerms: z.string().nullable(),
  counterparty: z.string().nullable(),
  startDate: IsoDate.nullable(),
  maturityDate: IsoDate.nullable(),
  verified: z.boolean(),
});
export type FixedIncomeTerms = z.infer<typeof FixedIncomeTerms>;

export const InterestProjection = z.object({
  basisScenarios: z.array(
    z.object({
      basis: z.enum(['nominal', 'effective']),
      monthlyRate: DecimalString,
      effectiveAnnualRate: DecimalString,
      projectedBalance: Money.nullable(),
      accruedInterest: Money.nullable(),
    }),
  ),
  postedInterestToDate: Money.nullable(),
  caveats: z.array(z.string()),
});
export type InterestProjection = z.infer<typeof InterestProjection>;

export const Reconciliation = z.object({
  id: Id,
  accountId: Id,
  periodStart: IsoDate,
  periodEnd: IsoDate,
  openingBalance: Money.nullable(),
  movements: Money,
  expectedClosing: Money.nullable(),
  actualClosing: Money.nullable(),
  difference: Money.nullable(),
  status: z.enum(['balanced', 'discrepancy', 'incomplete']),
  batchId: Id.nullable(),
  resolvedAt: IsoDateTime.nullable(),
  resolution: z.string().nullable(),
});
export type Reconciliation = z.infer<typeof Reconciliation>;

export const CoverageGap = z.object({
  accountId: Id,
  from: IsoDate,
  to: IsoDate,
  reason: z.string(),
});
export type CoverageGap = z.infer<typeof CoverageGap>;
