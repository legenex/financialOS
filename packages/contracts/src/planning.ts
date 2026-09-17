import { z } from 'zod';
import { CurrencyCode, DecimalString, Explanation, Id, IsoDate, IsoDateTime, MaybeMoney, Money, ResultStatus, SourceLink } from './common';

export const Cadence = z.enum(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'irregular', 'unknown']);
export type Cadence = z.infer<typeof Cadence>;

export const BudgetLine = z.object({
  id: Id,
  categoryId: Id,
  categoryName: z.string(),
  kind: z.enum(['spending', 'envelope', 'sinking_fund', 'fixed']),
  planned: Money,
  actual: Money.nullable(),
  remaining: Money.nullable(),
  rollover: z.boolean(),
  carriedIn: Money.nullable(),
});
export type BudgetLine = z.infer<typeof BudgetLine>;

export const Budget = z.object({
  id: Id,
  name: z.string(),
  entityId: Id,
  currency: CurrencyCode,
  period: z.object({ start: IsoDate, end: IsoDate, label: z.string() }),
  lines: z.array(BudgetLine),
  totals: z.object({ planned: Money, actual: Money.nullable(), remaining: Money.nullable() }),
  status: ResultStatus,
  unclassifiedSpending: Money.nullable(),
  note: z.string(),
});
export type Budget = z.infer<typeof Budget>;

export const BudgetLineInput = z.object({
  categoryId: Id,
  kind: z.enum(['spending', 'envelope', 'sinking_fund', 'fixed']),
  planned: DecimalString,
  rollover: z.boolean(),
});
export type BudgetLineInput = z.infer<typeof BudgetLineInput>;

export const BudgetInput = z.object({
  name: z.string().min(1).max(80),
  entityId: Id,
  currency: CurrencyCode,
  lines: z.array(BudgetLineInput).max(200),
});
export type BudgetInput = z.infer<typeof BudgetInput>;

export const GoalKind = z.enum(['emergency_reserve', 'reserve', 'travel', 'sinking_fund', 'purchase', 'annual_bill', 'debt_payoff', 'other']);
export type GoalKind = z.infer<typeof GoalKind>;

export const Goal = z.object({
  id: Id,
  name: z.string(),
  kind: GoalKind,
  target: Money,
  targetDate: IsoDate.nullable(),
  /** Protected reserves are subtracted from safe-to-spend. */
  protected: z.boolean(),
  /** Where the money is actually held. Virtual envelopes do not move money between banks. */
  heldIn: z.enum(['eligible_cash_accounts', 'separate_accounts', 'not_yet_funded']),
  linkedAccountIds: z.array(Id),
  fundedVerified: Money,
  fundedPlanned: Money,
  progress: DecimalString,
  monthlyNeeded: Money.nullable(),
  status: z.enum(['active', 'paused', 'achieved', 'archived']),
  priority: z.number().int(),
  travel: z
    .object({ destination: z.string().nullable(), routePreference: z.string().nullable(), departOn: IsoDate.nullable() })
    .nullable(),
});
export type Goal = z.infer<typeof Goal>;

export const GoalInput = z.object({
  name: z.string().min(1).max(80),
  kind: GoalKind,
  target: Money,
  targetDate: IsoDate.nullable(),
  protected: z.boolean(),
  heldIn: z.enum(['eligible_cash_accounts', 'separate_accounts', 'not_yet_funded']),
  linkedAccountIds: z.array(Id).max(20),
  priority: z.number().int().min(0).max(100),
  travel: z
    .object({ destination: z.string().max(120).nullable(), routePreference: z.string().max(200).nullable(), departOn: IsoDate.nullable() })
    .nullable(),
});
export type GoalInput = z.infer<typeof GoalInput>;

export const GoalContribution = z.object({
  id: Id,
  goalId: Id,
  amount: Money,
  date: IsoDate,
  /** Only verified contributions (linked to a real transaction or balance) count as savings or earn achievements. */
  status: z.enum(['planned', 'verified']),
  transactionId: Id.nullable(),
  note: z.string().nullable(),
});
export type GoalContribution = z.infer<typeof GoalContribution>;

export const GoalContributionInput = z.object({
  amount: DecimalString,
  date: IsoDate,
  status: z.enum(['planned', 'verified']),
  transactionId: Id.nullable(),
  note: z.string().max(300).nullable(),
});
export type GoalContributionInput = z.infer<typeof GoalContributionInput>;

export const RecurringItem = z.object({
  id: Id,
  name: z.string(),
  entityId: Id,
  accountId: Id.nullable(),
  counterparty: z.string().nullable(),
  kind: z.enum(['bill', 'subscription', 'salary', 'income', 'transfer', 'loan_payment', 'payroll', 'overhead', 'software', 'insurance', 'annual_bill', 'intercompany_income', 'intercompany_expense', 'other']),
  direction: z.enum(['in', 'out']),
  amount: MaybeMoney,
  amountIsEstimate: z.boolean(),
  cadence: Cadence,
  dayOfMonth: z.number().int().min(1).max(31).nullable(),
  nextDueOn: IsoDate.nullable(),
  status: z.enum(['active', 'paused', 'cancelled', 'suggested']),
  detected: z.boolean(),
  confirmed: z.boolean(),
  internalCounterpartyEntityId: Id.nullable(),
  lastSeenOn: IsoDate.nullable(),
  links: z.array(SourceLink),
});
export type RecurringItem = z.infer<typeof RecurringItem>;

export const RecurringItemInput = z.object({
  name: z.string().min(1).max(120),
  entityId: Id,
  accountId: Id.nullable(),
  counterparty: z.string().max(120).nullable(),
  kind: RecurringItem.shape.kind,
  direction: z.enum(['in', 'out']),
  amount: DecimalString.nullable(),
  currency: CurrencyCode,
  amountIsEstimate: z.boolean(),
  cadence: Cadence,
  dayOfMonth: z.number().int().min(1).max(31).nullable(),
  nextDueOn: IsoDate.nullable(),
  status: z.enum(['active', 'paused', 'cancelled']),
  internalCounterpartyEntityId: Id.nullable(),
});
export type RecurringItemInput = z.infer<typeof RecurringItemInput>;

export const Obligation = z.object({
  id: Id,
  entityId: Id,
  dueOn: IsoDate,
  amount: MaybeMoney,
  label: z.string(),
  kind: z.enum(['bill', 'tax', 'purchase', 'loan', 'transfer', 'other']),
  status: z.enum(['upcoming', 'paid', 'cancelled']),
});
export type Obligation = z.infer<typeof Obligation>;

export const ObligationInput = z.object({
  entityId: Id,
  dueOn: IsoDate,
  amount: DecimalString.nullable(),
  currency: CurrencyCode,
  label: z.string().min(1).max(120),
  kind: Obligation.shape.kind,
  status: Obligation.shape.status,
});
export type ObligationInput = z.infer<typeof ObligationInput>;

export const PurchaseImpactInput = z.object({
  amount: DecimalString,
  currency: CurrencyCode,
  date: IsoDate,
  categoryId: Id.nullable(),
  label: z.string().max(120),
  paymentAccountId: Id.nullable(),
  installments: z.number().int().min(1).max(60).default(1),
});
export type PurchaseImpactInput = z.infer<typeof PurchaseImpactInput>;

export const PurchaseImpactResult = z.object({
  status: ResultStatus,
  safeToSpendBefore: Money.nullable(),
  safeToSpendAfter: Money.nullable(),
  budgetLineBefore: Money.nullable(),
  budgetLineAfter: Money.nullable(),
  reserveShortfallAfter: Money.nullable(),
  commitmentsAtRisk: z.array(z.object({ label: z.string(), dueOn: IsoDate, amount: Money.nullable() })),
  goalsDelayed: z.array(z.object({ goalId: Id, name: z.string(), delayDays: z.number().int().nullable() })),
  verdict: z.enum(['fits', 'tight', 'does_not_fit', 'unknown']),
  explanation: Explanation,
});
export type PurchaseImpactResult = z.infer<typeof PurchaseImpactResult>;

export const ScenarioAdjustment = z.discriminatedUnion('type', [
  z.object({ type: z.literal('income_change'), percent: DecimalString, from: IsoDate, entityId: Id.nullable() }),
  z.object({ type: z.literal('delay_receivables'), days: z.number().int().min(1).max(365), entityId: Id.nullable() }),
  z.object({ type: z.literal('one_off'), amount: DecimalString, currency: CurrencyCode, date: IsoDate, direction: z.enum(['in', 'out']), label: z.string().max(120), entityId: Id.nullable() }),
  z.object({ type: z.literal('cost_change'), percent: DecimalString, from: IsoDate, kind: z.string().max(40).nullable(), entityId: Id.nullable() }),
  z.object({ type: z.literal('pause_recurring'), recurringItemId: Id, from: IsoDate, to: IsoDate.nullable() }),
]);
export type ScenarioAdjustment = z.infer<typeof ScenarioAdjustment>;

export const Scenario = z.object({
  id: Id,
  name: z.string(),
  description: z.string().nullable(),
  adjustments: z.array(ScenarioAdjustment),
  version: z.number().int(),
  archived: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Scenario = z.infer<typeof Scenario>;

export const ScenarioInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).nullable(),
  adjustments: z.array(ScenarioAdjustment).max(50),
});
export type ScenarioInput = z.infer<typeof ScenarioInput>;

export const RewardProduct = z.object({
  id: Id,
  name: z.string(),
  issuer: z.string(),
  termsAsOf: IsoDate,
  sourceUrl: z.string().nullable(),
  eligibility: z.string().nullable(),
  annualFee: Money.nullable(),
  earnRate: DecimalString.nullable(),
  earnUnit: z.enum(['cashback_percent', 'points_per_currency_unit']),
  pointValue: Money.nullable(),
  fxFeePercent: DecimalString.nullable(),
  paymentFeePercent: DecimalString.nullable(),
  notes: z.string().nullable(),
});
export type RewardProduct = z.infer<typeof RewardProduct>;

export const RewardComparisonInput = z.object({
  monthlySpend: z.array(z.object({ currency: CurrencyCode, amount: DecimalString, category: z.string().max(40) })).max(20),
  productIds: z.array(Id).max(10),
  paysFullBalance: z.boolean(),
  homeCurrency: CurrencyCode,
});
export type RewardComparisonInput = z.infer<typeof RewardComparisonInput>;

export const RewardComparisonResult = z.object({
  rows: z.array(
    z.object({
      productId: Id,
      name: z.string(),
      termsAsOf: IsoDate,
      annualRewards: Money.nullable(),
      annualFees: Money.nullable(),
      annualFxCosts: Money.nullable(),
      netAnnualValue: Money.nullable(),
      warnings: z.array(z.string()),
    }),
  ),
  caveats: z.array(z.string()),
});
export type RewardComparisonResult = z.infer<typeof RewardComparisonResult>;
