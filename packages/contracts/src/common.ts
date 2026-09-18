import { z } from 'zod';

/** Decimal number encoded as a string. Never a JS number for authoritative money. */
export const DecimalString = z
  .string()
  .regex(/^-?\d{1,20}(\.\d{1,18})?$/, 'Expected a decimal string such as "1234.56"');
export type DecimalString = z.infer<typeof DecimalString>;

export const CurrencyCode = z.string().regex(/^[A-Z0-9]{2,10}$/, 'Expected a currency code such as USD or BTC');
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export type IsoDate = z.infer<typeof IsoDate>;

export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

export const Money = z.object({ amount: DecimalString, currency: CurrencyCode });
export type Money = z.infer<typeof Money>;

/** Money whose amount may be unknown. Unknown is never coerced to zero. */
export const MaybeMoney = z.object({ amount: DecimalString.nullable(), currency: CurrencyCode.nullable() });
export type MaybeMoney = z.infer<typeof MaybeMoney>;

export const FxMethod = z.enum(['identity', 'historical', 'spot_at_valuation', 'manual', 'implied_from_transaction']);
export type FxMethod = z.infer<typeof FxMethod>;

export const FxProvenance = z.object({
  from: CurrencyCode,
  to: CurrencyCode,
  rate: DecimalString,
  rateSource: z.string(),
  rateAsOf: IsoDate,
  method: FxMethod,
});
export type FxProvenance = z.infer<typeof FxProvenance>;

/** A value converted into a reporting currency, with its original and the conversion evidence. */
export const ConvertedMoney = z.object({
  original: Money,
  converted: Money.nullable(),
  fx: FxProvenance.nullable(),
  /** Set when conversion was impossible (no rate). The value is then excluded from totals and listed. */
  unconvertedReason: z.string().nullable(),
});
export type ConvertedMoney = z.infer<typeof ConvertedMoney>;

export const ResultStatus = z.enum(['ok', 'provisional', 'insufficient_data']);
export type ResultStatus = z.infer<typeof ResultStatus>;

export const Confidence = z.enum(['high', 'medium', 'low', 'none']);
export type Confidence = z.infer<typeof Confidence>;

export const Provenance = z.object({
  source: z.string(),
  sourceKind: z.enum(['owner_reported', 'import', 'provider_api', 'manual_entry', 'derived', 'bootstrap', 'system']),
  reportedAt: IsoDateTime.nullable(),
  sourceAsOf: IsoDateTime.nullable(),
  verified: z.boolean(),
  documentId: Id.nullable().optional(),
  note: z.string().nullable().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const EntityKind = z.enum(['person', 'company', 'trust', 'third_party']);
export type EntityKind = z.infer<typeof EntityKind>;

export const LiquidityClass = z.enum([
  'cash',
  'near_cash',
  'marketable',
  'restricted',
  'illiquid',
  'property',
  'liability',
  'receivable',
  'contingent',
]);
export type LiquidityClass = z.infer<typeof LiquidityClass>;

export const AccountKind = z.enum([
  'current',
  'savings',
  'card',
  'credit_card',
  'brokerage',
  'crypto_wallet',
  'crypto_custodial',
  'private_investment',
  'restricted_equity',
  'pension',
  'property',
  'mortgage',
  'loan',
  'receivable',
  'clearing',
  'other',
]);
export type AccountKind = z.infer<typeof AccountKind>;

export const TransactionNature = z.enum([
  'consumption',
  'income',
  'salary',
  'transfer_internal',
  'transfer_external',
  'intercompany',
  'owner_contribution',
  'owner_drawing',
  'business_support',
  'third_party',
  'investment_contribution',
  'investment_withdrawal',
  'investment_trade',
  'property_purchase',
  'loan_repayment',
  'fee',
  'interest',
  'dividend',
  'refund',
  'tax',
  'payroll',
  'fx_conversion',
  'unknown',
]);
export type TransactionNature = z.infer<typeof TransactionNature>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/** A pointer from a computed number back to the records that produced it. */
export const SourceLink = z.object({
  kind: z.enum([
    'account',
    'transaction',
    'snapshot',
    'holding',
    'recurring',
    'obligation',
    'goal',
    'document',
    'exception',
    'setting',
    'arrangement',
    'restriction',
    'receivable',
    'scenario',
    'review',
    'achievement',
  ]),
  id: z.string(),
  label: z.string(),
});
export type SourceLink = z.infer<typeof SourceLink>;

/** One line in an explanation drawer. */
export const ExplanationItem = z.object({
  label: z.string(),
  value: Money.nullable(),
  role: z.enum(['input', 'subtracted', 'added', 'excluded', 'assumption', 'missing', 'result']),
  note: z.string().nullable(),
  links: z.array(SourceLink),
  fx: FxProvenance.nullable().optional(),
});
export type ExplanationItem = z.infer<typeof ExplanationItem>;

export const Explanation = z.object({
  summary: z.string(),
  formula: z.string(),
  items: z.array(ExplanationItem),
  assumptions: z.array(z.string()),
  missing: z.array(z.string()),
});
export type Explanation = z.infer<typeof Explanation>;

export const Freshness = z.object({
  label: z.string(),
  lastUpdatedAt: IsoDateTime.nullable(),
  state: z.enum(['fresh', 'aging', 'stale', 'never', 'unknown']),
});
export type Freshness = z.infer<typeof Freshness>;
