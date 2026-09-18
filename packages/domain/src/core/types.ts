/**
 * Plain input types shared by the domain-core modules. Output types come from @financialos/contracts
 * wherever a contract exists. Everything here is data only: no behaviour, no I/O.
 *
 * Conventions
 * - Money is `{ amount: decimal string, currency }`. Amounts are never JS numbers.
 * - Signed amounts are from the holder's perspective: positive = inflow / asset, negative = outflow / debt.
 * - `null` means unknown. Unknown is never coerced to zero.
 */
import type { AccountKind, EntityKind, ExceptionKind, LiquidityClass, MaybeMoney, Money } from '@financialos/contracts';
import type { IsoDate } from '../dates';

/** ISO-8601 instant with offset, e.g. `2026-01-31T10:00:00Z`. */
export type IsoDateTime = string;

/** An entity as the engine needs it (person, company, trust, third party). */
export interface EntityInfo {
  id: string;
  name: string;
  kind: EntityKind;
  /** Controlled by the owner (companies the owner runs, the owner themself). */
  ownerControlled: boolean;
  /** The single primary owner (the person whose personal finances this is). */
  primaryOwner: boolean;
  /**
   * Optional explicit owner-group key. When absent, the primary owner and every owner-controlled entity form
   * the group `"owner"`; every other entity is its own group.
   */
  ownerGroupId?: string | null;
}

/** An account as the engine needs it. */
export interface AccountInfo {
  id: string;
  name: string;
  kind: AccountKind;
  /** Null for multi-currency accounts. */
  currency: string | null;
  /** Null when the legal holder is unconfirmed. */
  legalEntityId: string | null;
  /** Null when the economic owner is unknown. */
  economicOwnerEntityId: string | null;
  ownershipConfirmed: boolean;
  liquidityClass: LiquidityClass;
  includeInSafeToSpend: boolean;
  status: 'active' | 'closed';
  /** Masked identifier such as `****1234`, used only as a description hint. */
  maskedIdentifier?: string | null;
}

/** Severity used by exception descriptors. */
export type ExceptionSeverity = 'info' | 'warning' | 'critical';

/**
 * A request to open (or keep open) an item in the single exception inbox. The persistence layer turns it into an
 * `ExceptionItem`; `dedupeKey` makes repeated computations idempotent.
 */
export interface ExceptionDescriptor {
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  title: string;
  detail: string;
  subject: { type: string; id: string | null; label: string | null };
  entityId: string | null;
  dedupeKey: string;
}

/** Minimal transaction shape used by classification, transfer matching and dedupe. */
export interface TransactionLike {
  id: string;
  accountId: string;
  bookedOn: IsoDate;
  /** Signed: negative = money left the account. */
  amount: Money;
  description: string;
  counterparty?: string | null;
  status?: 'pending' | 'posted' | 'reversed' | 'superseded';
}

/** A known-or-unknown valuation reduced to what aggregation needs. */
export interface ValueInput {
  value: MaybeMoney;
  /** Calendar date the value applies to (used for FX lookups). Null = unknown. */
  asOf: IsoDate | null;
  approximate: boolean;
  completeness: 'complete' | 'partial' | 'unknown';
}
