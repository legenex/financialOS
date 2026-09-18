/**
 * Read model for third-party arrangements (money held on behalf of someone else).
 *
 * The API records movements; `computeClearingAccount` in @financialos/domain decides what is owed,
 * what is held because the fee policy is unconfirmed, and which exceptions to raise. This module
 * never recognises fee income on its own.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { ClearingAccountSummary } from '@financialos/contracts';
import { accounts as accountsTable, entities as entitiesTable, thirdPartyArrangements, type DbOrTx } from '@financialos/db';
import {
  attributableThirdPartyBalance,
  computeClearingAccount,
  type AttributableThirdPartyResult,
  type AttributionAccount,
  type AttributionArrangement,
  type EntityInfo,
  type ExceptionDescriptor,
  type ThirdPartyArrangement,
  type ThirdPartyMovement,
  type ThirdPartyMovementKind,
} from '@financialos/domain';
import { normalizeDecimal } from './common';
import { loadClassifiedRows, type TransactionRow } from './transactions';

export type ArrangementRow = typeof thirdPartyArrangements.$inferSelect;

export async function listArrangementRows(db: DbOrTx): Promise<ArrangementRow[]> {
  return db.select().from(thirdPartyArrangements).where(eq(thirdPartyArrangements.status, 'active')).orderBy(asc(thirdPartyArrangements.createdAt)).limit(200);
}

export function arrangementInput(row: ArrangementRow, thirdPartyName: string, fallbackCurrency: string): ThirdPartyArrangement {
  return {
    id: row.id,
    thirdPartyEntityId: row.thirdPartyEntityId,
    thirdPartyName,
    currency: row.currency ?? fallbackCurrency,
    feeRate: normalizeDecimal(row.feeRate),
    feeMode: row.feeMode,
    feeRecipientEntityId: row.feeRecipientEntityId,
    openingBalance: normalizeDecimal(row.openingBalance),
    openingAsOf: row.openingBalanceAsOf,
    holderEntityId: row.holdingEntityIds[0] ?? null,
    holdingAccountId: row.clearingAccountIds[0] ?? null,
  };
}

/**
 * Movement kind from the recorded facts alone:
 * money in is a receipt; money out of a card account is card spend; money out to the third party
 * itself is a settlement; anything else out is a transfer out. Nothing is inferred beyond this.
 */
function movementKind(row: TransactionRow, amount: string, accountKind: string, thirdPartyEntityId: string, counterpartyEntityId: string | null): ThirdPartyMovementKind {
  if (!amount.startsWith('-')) return 'receipt';
  if (accountKind === 'card' || accountKind === 'credit_card') return 'card_spend';
  if (counterpartyEntityId === thirdPartyEntityId) return 'settlement';
  return 'transfer_out';
}

export interface ClearingBundle {
  row: ArrangementRow;
  summary: ClearingAccountSummary;
  exceptions: ExceptionDescriptor[];
}

export async function loadClearingSummaries(
  db: DbOrTx,
  options: { fallbackCurrency: string; arrangementIds?: readonly string[]; counterpartyEntityByRecord?: ReadonlyMap<string, string | null> },
): Promise<ClearingBundle[]> {
  const rows = (await listArrangementRows(db)).filter((r) => !options.arrangementIds || options.arrangementIds.includes(r.id));
  if (rows.length === 0) return [];
  const entityIds = [...new Set(rows.map((r) => r.thirdPartyEntityId))];
  const entityRows = await db.select({ id: entitiesTable.id, name: entitiesTable.name }).from(entitiesTable).where(inArray(entitiesTable.id, entityIds));
  const nameById = new Map(entityRows.map((e) => [e.id, e.name]));

  const accountIds = [...new Set(rows.flatMap((r) => [...r.clearingAccountIds, ...r.economicallyOwnedAccountIds]))];
  const accountKinds = new Map<string, string>();
  if (accountIds.length > 0) {
    const accountRows = await db.select({ id: accountsTable.id, kind: accountsTable.kind }).from(accountsTable).where(inArray(accountsTable.id, accountIds));
    for (const a of accountRows) accountKinds.set(a.id, a.kind);
  }

  const out: ClearingBundle[] = [];
  for (const row of rows) {
    const ids = [...new Set([...row.clearingAccountIds, ...row.economicallyOwnedAccountIds])];
    const records = ids.length > 0 ? await loadClassifiedRows(db, { accountIds: ids, nature: 'third_party' }, 5000) : [];
    const movements: ThirdPartyMovement[] = [];
    for (const record of records) {
      const currency = record.record.currency ?? record.accountCurrency;
      if (record.record.amount === null || currency === null || !record.record.bookedOn) continue;
      const amount = normalizeDecimal(record.record.amount);
      const kind = movementKind(
        record,
        amount,
        accountKinds.get(record.record.accountId) ?? 'other',
        row.thirdPartyEntityId,
        options.counterpartyEntityByRecord?.get(record.record.id) ?? null,
      );
      movements.push({
        id: record.record.id,
        date: record.record.bookedOn,
        kind,
        amount: { amount: amount.startsWith('-') ? amount.slice(1) : amount, currency },
        description: record.record.description ?? 'Movement',
        transactionId: record.record.id,
      });
    }
    const result = computeClearingAccount(arrangementInput(row, nameById.get(row.thirdPartyEntityId) ?? 'Third party', options.fallbackCurrency), movements);
    out.push({ row, summary: result.summary, exceptions: result.exceptions });
  }
  return out;
}

/** Money inside owner accounts that belongs to third parties, for wealth and safe-to-spend exclusions. */
export async function loadAttributableThirdParty(
  db: DbOrTx,
  options: {
    entities: readonly EntityInfo[];
    accounts: ReadonlyArray<{ id: string; name: string; legalEntityId: string | null; economicOwnerEntityId: string | null; value: { amount: string; currency: string } | null }>;
    clearing: readonly ClearingBundle[];
  },
): Promise<AttributableThirdPartyResult> {
  const arrangements: AttributionArrangement[] = options.clearing.map((bundle) => ({
    arrangementId: bundle.row.id,
    thirdPartyEntityId: bundle.row.thirdPartyEntityId,
    thirdPartyName: bundle.summary.thirdPartyName,
    holderEntityId: bundle.row.holdingEntityIds[0] ?? null,
    holdingAccountId: bundle.row.clearingAccountIds[0] ?? null,
    amountOwed: bundle.summary.amountOwed,
  }));
  const accounts: AttributionAccount[] = options.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    legalEntityId: a.legalEntityId,
    economicOwnerEntityId: a.economicOwnerEntityId,
    value: a.value,
  }));
  return attributableThirdPartyBalance(accounts, arrangements, { entities: options.entities });
}

export { and, asc, eq, inArray, isNull };
