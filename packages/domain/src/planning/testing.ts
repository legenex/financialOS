/**
 * Synthetic fixture helpers for planning tests. Not exported from the package index.
 * All names and amounts are obviously synthetic.
 */
import type { Money, RecurringItem } from '@financialos/contracts';
import { money } from '../money';
import type { CashFlowItem } from './cashflow';
import type { PlanningAccount, PlanningEntity } from './types';

/** Deterministic UUID for fixtures: uid(7) → 00000000-0000-4000-8000-000000000007. */
export function uid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const OWNER_ID = uid(1);
export const COMPANY_ID = uid(2);
export const THIRD_PARTY_ID = uid(3);

export const ENTITIES: PlanningEntity[] = [
  { id: OWNER_ID, name: 'Example Owner', kind: 'person', primaryOwner: true },
  { id: COMPANY_ID, name: 'Example Holdings Ltd', kind: 'company', primaryOwner: false },
  { id: THIRD_PARTY_ID, name: 'Sample Third Party', kind: 'third_party', primaryOwner: false },
];

export const NOW = '2026-03-10T08:00:00Z';
export const TODAY = '2026-03-10';

export function zar(amount: string): Money {
  return money(amount, 'ZAR');
}

export function usd(amount: string): Money {
  return money(amount, 'USD');
}

export function gbp(amount: string): Money {
  return money(amount, 'GBP');
}

export function account(overrides: Partial<PlanningAccount> & { id: string; name: string }): PlanningAccount {
  return {
    kind: 'current',
    liquidityClass: 'cash',
    includeInSafeToSpend: true,
    legalEntityId: OWNER_ID,
    economicOwnerEntityId: OWNER_ID,
    status: 'active',
    balance: zar('0'),
    balanceAsOf: '2026-03-10T06:00:00Z',
    ...overrides,
  };
}

export function flow(overrides: Partial<CashFlowItem> & { id: string; date: string }): CashFlowItem {
  return {
    label: overrides.id,
    direction: 'out',
    amount: zar('100'),
    certainty: 'committed',
    probability: null,
    source: 'other',
    kind: null,
    entityId: null,
    recurringItemId: null,
    links: [],
    ...overrides,
  };
}

export function recurring(overrides: Partial<RecurringItem> & { id: string; name: string }): RecurringItem {
  return {
    entityId: OWNER_ID,
    accountId: null,
    counterparty: null,
    kind: 'bill',
    direction: 'out',
    amount: { amount: '100', currency: 'ZAR' },
    amountIsEstimate: false,
    cadence: 'monthly',
    dayOfMonth: null,
    nextDueOn: '2026-03-15',
    status: 'active',
    detected: false,
    confirmed: true,
    internalCounterpartyEntityId: null,
    lastSeenOn: null,
    links: [],
    ...overrides,
  };
}

/** Recursively freezes a value so tests can prove inputs are never mutated. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
