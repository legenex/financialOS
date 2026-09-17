import { z } from 'zod';
import { CurrencyCode, DecimalString, Explanation, Id, IsoDate, IsoDateTime, Money, ResultStatus, SourceLink } from './common';

export const ReceivablePayable = z.object({
  id: Id,
  entityId: Id,
  kind: z.enum(['receivable', 'payable']),
  counterparty: z.string(),
  intercompanyEntityId: Id.nullable(),
  reference: z.string().nullable(),
  amount: Money,
  outstanding: Money,
  issuedOn: IsoDate.nullable(),
  dueOn: IsoDate.nullable(),
  expectedOn: IsoDate.nullable(),
  probability: DecimalString,
  status: z.enum(['open', 'partial', 'paid', 'written_off', 'cancelled']),
  source: z.enum(['manual', 'import']),
  category: z.enum(['sales', 'payroll', 'software', 'overhead', 'refund', 'tax', 'intercompany', 'owner', 'other']),
});
export type ReceivablePayable = z.infer<typeof ReceivablePayable>;

export const ReceivablePayableInput = z.object({
  entityId: Id,
  kind: z.enum(['receivable', 'payable']),
  counterparty: z.string().min(1).max(120),
  intercompanyEntityId: Id.nullable(),
  reference: z.string().max(80).nullable(),
  amount: DecimalString,
  currency: CurrencyCode,
  outstanding: DecimalString.nullable(),
  issuedOn: IsoDate.nullable(),
  dueOn: IsoDate.nullable(),
  expectedOn: IsoDate.nullable(),
  probability: DecimalString,
  status: ReceivablePayable.shape.status,
  category: ReceivablePayable.shape.category,
});
export type ReceivablePayableInput = z.infer<typeof ReceivablePayableInput>;

export const EntityCashSummary = z.object({
  entityId: Id,
  name: z.string(),
  currency: CurrencyCode,
  cash: Money.nullable(),
  cashStatus: ResultStatus,
  basis: z.literal('cash'),
  periodIn: Money.nullable(),
  periodOut: Money.nullable(),
  categories: z.array(z.object({ label: z.string(), amount: Money, complete: z.boolean() })),
  unclassifiedCount: z.number().int(),
  receivablesOpen: Money.nullable(),
  payablesOpen: Money.nullable(),
  intercompanyIn: Money.nullable(),
  intercompanyOut: Money.nullable(),
  ownerContributions: Money.nullable(),
  ownerDrawings: Money.nullable(),
  disclaimer: z.string(),
});
export type EntityCashSummary = z.infer<typeof EntityCashSummary>;

export const ConsolidatedView = z.object({
  entityIds: z.array(Id),
  currency: CurrencyCode,
  cash: Money.nullable(),
  eliminated: z.array(z.object({ label: z.string(), amount: Money, links: z.array(SourceLink) })),
  thirdPartyExcluded: Money.nullable(),
  status: ResultStatus,
  explanation: Explanation,
});
export type ConsolidatedView = z.infer<typeof ConsolidatedView>;

export const ThirdPartyFeeMode = z.enum(['deducted_from_receipt', 'charged_on_top', 'unconfirmed']);
export type ThirdPartyFeeMode = z.infer<typeof ThirdPartyFeeMode>;

export const ClearingMovementKind = z.enum([
  'opening_balance',
  'receipt',
  'fee',
  'card_spend',
  'transfer_out',
  'reimbursement',
  'settlement',
  'adjustment',
  'held_unclassified',
]);
export type ClearingMovementKind = z.infer<typeof ClearingMovementKind>;

export const ClearingMovement = z.object({
  id: Id,
  date: IsoDate,
  kind: ClearingMovementKind,
  gross: Money,
  fee: Money.nullable(),
  /** Positive increases what is owed to the third party. */
  effectOnOwed: Money.nullable(),
  description: z.string(),
  transactionId: Id.nullable(),
  status: z.enum(['applied', 'held']),
  note: z.string().nullable(),
});
export type ClearingMovement = z.infer<typeof ClearingMovement>;

export const ClearingAccountSummary = z.object({
  arrangementId: Id,
  thirdPartyName: z.string(),
  currency: CurrencyCode,
  feeRate: DecimalString.nullable(),
  feeMode: ThirdPartyFeeMode,
  feeModeConfirmed: z.boolean(),
  feeRecipientEntityId: Id.nullable(),
  openingBalance: Money.nullable(),
  openingBalanceAsOf: IsoDate.nullable(),
  amountOwed: Money.nullable(),
  amountOwedStatus: ResultStatus,
  heldForClassification: Money,
  feeIncomeRecognised: Money,
  feeIncomeIfDeducted: Money.nullable(),
  feeIncomeIfOnTop: Money.nullable(),
  movements: z.array(ClearingMovement),
  explanation: Explanation,
});
export type ClearingAccountSummary = z.infer<typeof ClearingAccountSummary>;

export const ArrangementPolicyInput = z.object({
  feeMode: ThirdPartyFeeMode,
  feeRate: DecimalString.nullable(),
  feeRecipientEntityId: Id.nullable(),
  openingBalance: DecimalString.nullable(),
  openingBalanceAsOf: IsoDate.nullable(),
  evidenceNote: z.string().max(500).nullable(),
});
export type ArrangementPolicyInput = z.infer<typeof ArrangementPolicyInput>;

export const SupportTrackerEntry = z.object({
  date: IsoDate,
  fromEntityId: Id,
  toEntityId: Id,
  amount: Money,
  nature: z.enum(['business_support', 'owner_contribution', 'owner_drawing', 'loan_to_business', 'loan_repayment']),
  transactionId: Id.nullable(),
  note: z.string().nullable(),
});
export type SupportTrackerEntry = z.infer<typeof SupportTrackerEntry>;

export const SupportTracker = z.object({
  currency: CurrencyCode,
  entries: z.array(SupportTrackerEntry),
  totalsByEntity: z.array(z.object({ entityId: Id, name: z.string(), netSupport: Money })),
  asOf: IsoDateTime,
});
export type SupportTracker = z.infer<typeof SupportTracker>;
