/**
 * Minimal, already-classified inputs used across planning calculations. They are structural subsets of the
 * contracts records so callers can pass database rows or API objects after a light mapping.
 */
import type { Account, AccountKind, EntityKind, LiquidityClass, Money, SourceLink } from '@financialos/contracts';

export interface PlanningEntity {
  id: string;
  name: string;
  kind: EntityKind;
  primaryOwner: boolean;
}

export interface PlanningAccount {
  id: string;
  name: string;
  kind: AccountKind;
  liquidityClass: LiquidityClass;
  includeInSafeToSpend: boolean;
  /** Legal holder of the account. Null = unconfirmed. */
  legalEntityId: string | null;
  /** Whose money it is. Null = unconfirmed. */
  economicOwnerEntityId: string | null;
  status: 'active' | 'closed';
  /** Known balance (in the account's currency), or null when unknown. Never zero for unknown. */
  balance: Money | null;
  /** When the balance was true (ISO date-time or date). Null = unknown age. */
  balanceAsOf: string | null;
  /** Credit limit or buying power is never cash; recorded only so exclusions can be explained. */
  creditLimit?: Money | null;
}

/** Money inside an owner account that belongs to a third party (from the clearing account). */
export interface ThirdPartyHolding {
  accountId: string;
  arrangementId: string;
  label: string;
  /** Amount attributable to the third party. Null = unknown. */
  amount: Money | null;
}

/** Maps a contracts Account onto the planning shape (valuation value/asOf become balance/balanceAsOf). */
export function planningAccountFromContract(account: Account): PlanningAccount {
  const value = account.valuation.value;
  const balance = value.amount !== null && value.currency !== null ? { amount: value.amount, currency: value.currency } : null;
  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    liquidityClass: account.liquidityClass,
    includeInSafeToSpend: account.includeInSafeToSpend,
    legalEntityId: account.legalEntityId,
    economicOwnerEntityId: account.economicOwnerEntityId,
    status: account.status,
    balance,
    balanceAsOf: account.valuation.asOf ?? account.valuation.reportedAt,
  };
}

export function accountLink(account: { id: string; name: string }): SourceLink {
  return { kind: 'account', id: account.id, label: account.name };
}

export const BUSINESS_ENTITY_KINDS: readonly EntityKind[] = ['company', 'trust'];
