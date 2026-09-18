import type { Cadence, Entity, GoalKind, RecurringItem } from '@financialos/contracts';
import { useEntities, useSettings } from '../../lib/endpoints';

export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: 'Weekly',
  fortnightly: 'Every two weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Yearly',
  irregular: 'Irregular',
  unknown: 'Unknown cadence',
};

export const GOAL_KIND_LABEL: Record<GoalKind, string> = {
  emergency_reserve: 'Emergency reserve',
  reserve: 'Reserve',
  travel: 'Travel',
  sinking_fund: 'Sinking fund',
  purchase: 'Planned purchase',
  annual_bill: 'Annual bill',
  debt_payoff: 'Debt payoff',
  other: 'Other',
};

export const RECURRING_KIND_LABEL: Record<RecurringItem['kind'], string> = {
  bill: 'Bill',
  subscription: 'Subscription',
  salary: 'Salary',
  income: 'Income',
  transfer: 'Transfer',
  loan_payment: 'Loan payment',
  payroll: 'Payroll',
  overhead: 'Overhead',
  software: 'Software',
  insurance: 'Insurance',
  annual_bill: 'Annual bill',
  intercompany_income: 'Intercompany income',
  intercompany_expense: 'Intercompany expense',
  other: 'Other',
};

export const FALLBACK_CURRENCIES = ['USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD'];

/** Decimal places a currency allows, from the platform's currency data (used for input validation only). */
export function minorUnits(currency: string | null | undefined): number {
  if (!currency) return 2;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 8;
  }
}

export function useCurrencyOptions(): { options: Array<{ value: string; label: string }>; defaultCurrency: string | null; budgetCurrency: string | null } {
  const settings = useSettings();
  const entities = useEntities();
  const reporting = settings.data?.reportingCurrency ?? null;
  const budget = settings.data?.budgetCurrency ?? null;
  const all = [...new Set([budget, reporting, ...(entities.data ?? []).map((e) => e.baseCurrency), ...FALLBACK_CURRENCIES].filter((c): c is string => !!c))];
  return { options: all.map((c) => ({ value: c, label: c })), defaultCurrency: reporting, budgetCurrency: budget ?? reporting };
}

export function primaryEntity(entities: Entity[] | undefined): Entity | null {
  if (!entities) return null;
  return entities.find((e) => e.primaryOwner) ?? entities.find((e) => e.kind === 'person' && e.ownerControlled) ?? null;
}

export function entityOptions(entities: Entity[] | undefined): Array<{ value: string; label: string }> {
  return (entities ?? [])
    .filter((e) => e.ownerControlled)
    .map((e) => ({ value: e.id, label: e.primaryOwner ? `${e.name} (personal)` : e.name }));
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
