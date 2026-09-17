import { z } from 'zod';
import {
  Confidence,
  CurrencyCode,
  DecimalString,
  Explanation,
  Freshness,
  Id,
  IsoDate,
  IsoDateTime,
  LiquidityClass,
  Money,
  ResultStatus,
  SourceLink,
} from './common';

/** One dated point in a cash-flow projection. */
export const TimelinePoint = z.object({
  date: IsoDate,
  label: z.string(),
  change: Money,
  balanceAfter: Money,
  kind: z.enum(['opening', 'inflow', 'outflow', 'reserve', 'unknown_amount']),
  confidence: Confidence,
  links: z.array(SourceLink),
});
export type TimelinePoint = z.infer<typeof TimelinePoint>;

export const SafeToSpendResult = z.object({
  status: ResultStatus,
  /** Null when status is insufficient_data. Never a fabricated precise figure. */
  amount: Money.nullable(),
  /** Shortfall is set when obligations and reserves exceed eligible cash (amount is then 0). */
  shortfall: Money.nullable(),
  currency: CurrencyCode,
  horizon: z.object({ from: IsoDate, to: IsoDate, days: z.number().int(), basis: z.string() }),
  eligibleCash: Money.nullable(),
  lowestProjectedBalance: Money.nullable(),
  lowestProjectedOn: IsoDate.nullable(),
  protectedReserves: Money,
  obligationsInHorizon: Money,
  expectedInflowsInHorizon: Money,
  unknownAmountObligations: z.number().int(),
  confidence: Confidence,
  timeline: z.array(TimelinePoint),
  explanation: Explanation,
  computedAt: IsoDateTime,
});
export type SafeToSpendResult = z.infer<typeof SafeToSpendResult>;

export const RunwayResult = z.object({
  scope: z.object({ kind: z.enum(['personal', 'entity']), entityId: Id.nullable(), label: z.string() }),
  status: z.enum(['finite', 'not_depleting', 'insufficient_history', 'insufficient_data']),
  months: DecimalString.nullable(),
  depletionDate: IsoDate.nullable(),
  liquidBalance: Money.nullable(),
  averageMonthlyNetOutflow: Money.nullable(),
  historyMonths: z.number().int(),
  minimumHistoryMonths: z.number().int(),
  explanation: Explanation,
});
export type RunwayResult = z.infer<typeof RunwayResult>;

export const ForecastWeek = z.object({
  weekStart: IsoDate,
  weekEnd: IsoDate,
  openingBalance: Money,
  inflows: Money,
  outflows: Money,
  closingBalance: Money,
  unknownItems: z.number().int(),
  items: z.array(
    z.object({
      date: IsoDate,
      label: z.string(),
      amount: Money,
      direction: z.enum(['in', 'out']),
      source: z.enum(['recurring', 'receivable', 'payable', 'obligation', 'scenario']),
      probability: DecimalString.nullable(),
      links: z.array(SourceLink),
    }),
  ),
});
export type ForecastWeek = z.infer<typeof ForecastWeek>;

export const CashForecast = z.object({
  entityId: Id.nullable(),
  label: z.string(),
  currency: CurrencyCode,
  status: ResultStatus,
  scenarioId: Id.nullable(),
  weeks: z.array(ForecastWeek),
  lowestClosing: Money.nullable(),
  lowestClosingWeek: IsoDate.nullable(),
  warnings: z.array(z.string()),
  explanation: Explanation,
});
export type CashForecast = z.infer<typeof CashForecast>;

/** Balance-sheet style segmentation. Net worth is secondary and always segmented. */
export const WealthSegment = z.object({
  liquidityClass: LiquidityClass,
  label: z.string(),
  total: Money.nullable(),
  accountsCounted: z.number().int(),
  accountsUnknown: z.number().int(),
  unconvertedCount: z.number().int(),
  links: z.array(SourceLink),
});
export type WealthSegment = z.infer<typeof WealthSegment>;

export const WealthSummary = z.object({
  scope: z.enum(['personal', 'consolidated', 'entity']),
  entityIds: z.array(Id),
  currency: CurrencyCode,
  segments: z.array(WealthSegment),
  netWorthKnown: Money.nullable(),
  status: ResultStatus,
  excludedThirdParty: Money.nullable(),
  explanation: Explanation,
});
export type WealthSummary = z.infer<typeof WealthSummary>;

export const NextAction = z.object({
  id: z.string(),
  title: z.string(),
  why: z.string(),
  impact: z.enum(['high', 'medium', 'low']),
  href: z.string(),
  kind: z.enum(['connect', 'import', 'classify', 'reconcile', 'review', 'fund_goal', 'confirm_policy', 'verify', 'plan']),
});
export type NextAction = z.infer<typeof NextAction>;

export const UpcomingCommitment = z.object({
  id: z.string(),
  date: IsoDate,
  label: z.string(),
  amount: Money.nullable(),
  entityId: Id.nullable(),
  kind: z.string(),
  links: z.array(SourceLink),
});
export type UpcomingCommitment = z.infer<typeof UpcomingCommitment>;

export const BusinessCashWarning = z.object({
  entityId: Id,
  entityName: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  href: z.string(),
});
export type BusinessCashWarning = z.infer<typeof BusinessCashWarning>;

export const TodayResponse = z.object({
  asOf: IsoDateTime,
  reportingCurrency: CurrencyCode,
  budgetCurrency: CurrencyCode,
  safeToSpend: SafeToSpendResult,
  personalRunway: RunwayResult,
  upcoming: z.array(UpcomingCommitment),
  businessWarnings: z.array(BusinessCashWarning),
  freshness: z.array(Freshness),
  nextActions: z.array(NextAction).max(3),
  wealth: WealthSummary,
  openExceptions: z.number().int(),
  budgetProgress: z
    .object({
      period: z.string(),
      planned: Money.nullable(),
      spent: Money.nullable(),
      status: ResultStatus,
    })
    .nullable(),
});
export type TodayResponse = z.infer<typeof TodayResponse>;
