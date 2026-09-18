/**
 * Owner bootstrap loader (`cli.mjs bootstrap --file <path>`).
 *
 * The bootstrap file is a private, deployment-specific JSON document (never checked into the
 * repo) that seeds the database with the owner's real entities, accounts, balances, etc. Each
 * section is a list of items keyed by their own `key` string (or, where the schema already has a
 * more natural identity — `fixedIncomeTerms` by account, `ownershipInterests` by holder/held pair
 * — a key derived from that). Loading is idempotent two ways:
 *
 *  1. Fast path: if `bootstrap_runs` already has a row for this exact `bootstrapId` with the same
 *     file hash, nothing is re-applied.
 *  2. Slow path (first run, or the file changed under the same id): every section is upserted by
 *     its key, via `onConflictDoUpdate` on each table's unique `bootstrap_key` (or natural key),
 *     so re-running an unchanged file updates nothing and a changed field updates the row instead
 *     of duplicating it.
 *
 * This module is intentionally generic: no name, amount, institution, or key from any real
 * deployment's bootstrap file is hardcoded here.
 */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ACCOUNT_KINDS,
  COMPLETENESS,
  COMPOUNDING,
  CADENCES,
  COUNTERPARTY_KINDS,
  ENTITY_KINDS,
  INSTITUTION_KINDS,
  INSTRUMENT_KINDS,
  LIQUIDITY_CLASSES,
  RATE_BASES,
  RECURRING_KINDS,
  RECURRING_STATUSES,
  RESTRICTION_KINDS,
  RESTRICTION_STATUSES,
  SNAPSHOT_KINDS,
  THIRD_PARTY_FEE_MODES,
  WATCH_EVENT_STATUSES,
  accounts,
  balanceSnapshots,
  bootstrapRuns,
  counterparties,
  entities,
  fixedIncomeTerms,
  holdingLines,
  holdingsSnapshots,
  institutions,
  instruments,
  ownershipInterests,
  recurringItems,
  restrictions,
  settings,
  thirdPartyArrangements,
  watchEvents,
  type DbOrTx,
} from '@financialos/db';
import { redactText } from '@financialos/security/redact';
import { raiseException } from './exceptions';
import type { Logger } from 'pino';

const money = z.string().regex(/^-?\d{1,20}(\.\d{1,18})?$/);
const currency = z.string().regex(/^[A-Z0-9]{2,10}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const key = z.string().min(1).max(200);
const note = z.string().max(4000).nullable().optional();

const EntityItem = z.object({
  key,
  name: z.string().min(1),
  kind: z.enum(ENTITY_KINDS),
  jurisdiction: z.string().nullable().optional(),
  baseCurrency: currency.nullable().optional(),
  ownerControlled: z.boolean().default(false),
  primaryOwner: z.boolean().default(false),
  legalStatusConfirmed: z.boolean().default(false),
  notes: note,
});

const OwnershipInterestItem = z.object({
  holder: key,
  held: key,
  percent: z.string().regex(/^\d{1,3}(\.\d+)?$/).nullable().optional(),
  confirmed: z.boolean().default(false),
  notes: note,
});

const InstitutionItem = z.object({
  key,
  name: z.string().min(1),
  country: z.string().nullable().optional(),
  kind: z.enum(INSTITUTION_KINDS),
  providerKey: z.string().nullable().optional(),
  notes: note,
});

const CounterpartyItem = z.object({
  key,
  name: z.string().min(1),
  kind: z.enum(COUNTERPARTY_KINDS).default('unknown'),
  notes: note,
});

const AccountItem = z.object({
  key,
  institution: key.nullable().optional(),
  name: z.string().min(1),
  kind: z.enum(ACCOUNT_KINDS),
  currency: currency.nullable().optional(),
  legalEntity: key.nullable().optional(),
  economicOwner: key.nullable().optional(),
  liquidityClass: z.enum(LIQUIDITY_CLASSES),
  includeInSafeToSpend: z.boolean().default(false),
  ownershipConfirmed: z.boolean().default(false),
  notes: note,
});

const InstrumentItem = z.object({
  key,
  symbol: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(INSTRUMENT_KINDS),
  currency: currency.nullable().optional(),
});

const BalanceSnapshotItem = z.object({
  key,
  account: key,
  kind: z.enum(SNAPSHOT_KINDS),
  amount: money,
  currency,
  approximate: z.boolean().default(false),
  sourceAsOf: isoDate,
  source: z.string().min(1),
  completeness: z.enum(COMPLETENESS).default('unknown'),
  composition: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  notes: note,
});

const HoldingsSnapshotItem = z.object({
  key,
  account: key,
  sourceAsOf: isoDate,
  source: z.string().min(1),
  completeness: z.enum(COMPLETENESS).default('unknown'),
  lines: z
    .array(
      z.object({
        instrument: key,
        quantity: money.nullable().optional(),
        value: money.nullable().optional(),
        currency: currency.nullable().optional(),
      }),
    )
    .default([]),
});

const FixedIncomeTermsItem = z.object({
  account: key,
  counterparty: key.nullable().optional(),
  principal: money.nullable().optional(),
  currency: currency.nullable().optional(),
  statedAnnualRate: z.string().nullable().optional(),
  rateBasis: z.enum(RATE_BASES).default('unverified'),
  statedCompounding: z.enum(COMPOUNDING).default('unknown'),
  fees: z.string().nullable().optional(),
  withdrawalTerms: z.string().nullable().optional(),
  startDate: isoDate,
  maturityDate: isoDate,
  verified: z.boolean().default(false),
  notes: note,
});

const RestrictionItem = z.object({
  account: key,
  instrument: key.nullable().optional(),
  kind: z.enum(RESTRICTION_KINDS),
  status: z.enum(RESTRICTION_STATUSES).default('reported_unverified'),
  terms: z.record(z.string(), z.unknown()).nullable().optional(),
  effectiveFrom: isoDate,
  effectiveTo: isoDate,
  notes: note,
});

const WatchEventItem = z.object({
  subject: key.nullable().optional(),
  kind: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(WATCH_EVENT_STATUSES).default('unverified'),
  expectedDate: isoDate,
  notes: note,
});

const ThirdPartyArrangementItem = z.object({
  key,
  thirdParty: key,
  holdingEntities: z.array(key).default([]),
  clearingAccounts: z.array(key).default([]),
  economicallyOwnedAccounts: z.array(key).default([]),
  statedFeeRate: z.string().nullable().optional(),
  feeMode: z.enum(THIRD_PARTY_FEE_MODES).default('unconfirmed'),
  feeRecipient: key.nullable().optional(),
  currency: currency.nullable().optional(),
  openingBalance: money.nullable().optional(),
  openingBalanceAsOf: isoDate,
  notes: note,
});

const RecurringCommitmentItem = z.object({
  key,
  entity: key,
  account: key.nullable().optional(),
  counterparty: key.nullable().optional(),
  name: z.string().min(1),
  kind: z.enum(RECURRING_KINDS),
  direction: z.enum(['in', 'out']).default('out'),
  amount: money.nullable().optional(),
  currency: currency.nullable().optional(),
  cadence: z.enum(CADENCES).default('unknown'),
  status: z.enum(RECURRING_STATUSES).default('active'),
  internalTo: key.nullable().optional(),
});

const OpenQuestionItem = z.object({
  kind: z.string().min(1),
  subjectAccount: key.nullable().optional(),
  title: z.string().min(1),
  detail: z.string().default(''),
});

export const BootstrapFileSchema = z.object({
  formatVersion: z.number().int().min(1),
  bootstrapId: z.string().min(1).max(200),
  reportedAt: z.string().min(1),
  reportedBy: z.string().min(1),
  provenanceNote: z.string().nullable().optional(),
  settings: z.object({
    reportingCurrency: currency,
    budgetCurrency: currency,
    reportingTimezone: z.string().min(1),
  }),
  entities: z.array(EntityItem).default([]),
  ownershipInterests: z.array(OwnershipInterestItem).default([]),
  institutions: z.array(InstitutionItem).default([]),
  counterparties: z.array(CounterpartyItem).default([]),
  accounts: z.array(AccountItem).default([]),
  instruments: z.array(InstrumentItem).default([]),
  balanceSnapshots: z.array(BalanceSnapshotItem).default([]),
  holdingsSnapshots: z.array(HoldingsSnapshotItem).default([]),
  fixedIncomeTerms: z.array(FixedIncomeTermsItem).default([]),
  restrictions: z.array(RestrictionItem).default([]),
  watchEvents: z.array(WatchEventItem).default([]),
  thirdPartyArrangements: z.array(ThirdPartyArrangementItem).default([]),
  recurringCommitments: z.array(RecurringCommitmentItem).default([]),
  openQuestions: z.array(OpenQuestionItem).default([]),
});
export type BootstrapFile = z.infer<typeof BootstrapFileSchema>;

export class BootstrapError extends Error {
  override readonly name = 'BootstrapError';
}

export interface BootstrapCounts {
  entities: number;
  ownershipInterests: number;
  institutions: number;
  counterparties: number;
  accounts: number;
  instruments: number;
  balanceSnapshots: number;
  holdingsSnapshots: number;
  fixedIncomeTerms: number;
  restrictions: number;
  watchEvents: number;
  thirdPartyArrangements: number;
  recurringCommitments: number;
  openQuestions: number;
}

export interface BootstrapResult {
  applied: boolean;
  bootstrapId: string;
  counts: BootstrapCounts;
}

function parseBootstrapFile(raw: string): BootstrapFile {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BootstrapError('bootstrap file is not valid JSON');
  }
  const result = BootstrapFileSchema.safeParse(json);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new BootstrapError(`bootstrap file failed validation: ${summary}`);
  }
  return result.data;
}

/** Loads and validates a bootstrap file from disk (never logs its contents). */
export function readBootstrapFile(text: string): { data: BootstrapFile; sha256: string } {
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  return { data: parseBootstrapFile(text), sha256 };
}

/** Resolves a bootstrap `key` to a database id, or throws a clear error naming the missing key. */
class KeyMap {
  private readonly map = new Map<string, string>();
  constructor(private readonly label: string) {}
  set(key: string, id: string): void {
    this.map.set(key, id);
  }
  get(key: string): string | undefined {
    return this.map.get(key);
  }
  require(key: string): string {
    const id = this.map.get(key);
    if (!id) throw new BootstrapError(`${this.label}: unknown key "${key}"`);
    return id;
  }
}

/**
 * Applies a validated bootstrap file. Idempotent: call `bootstrapRuns` lookup first to skip an
 * unchanged file; this function itself upserts every row by its natural key, so re-applying an
 * unchanged file is a no-op and a changed field updates the existing row.
 */
export async function applyBootstrap(db: DbOrTx, data: BootstrapFile, fileSha256: string, logger: Logger): Promise<BootstrapCounts> {
  return db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values([
        { key: 'reportingCurrency', value: data.settings.reportingCurrency, updatedBy: 'bootstrap-cli' },
        { key: 'budgetCurrency', value: data.settings.budgetCurrency, updatedBy: 'bootstrap-cli' },
        { key: 'reportingTimezone', value: data.settings.reportingTimezone, updatedBy: 'bootstrap-cli' },
      ])
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: sql`excluded.value`, updatedBy: 'bootstrap-cli', updatedAt: new Date() },
      });

    const entityIds = new KeyMap('entities');
    for (const item of data.entities) {
      const [row] = await tx
        .insert(entities)
        .values({
          bootstrapKey: item.key,
          name: item.name,
          kind: item.kind,
          jurisdiction: item.jurisdiction ?? null,
          baseCurrency: item.baseCurrency ?? null,
          ownerControlled: item.ownerControlled,
          primaryOwner: item.primaryOwner,
          legalStatusConfirmed: item.legalStatusConfirmed,
          notes: item.notes ?? null,
        })
        .onConflictDoUpdate({
          target: entities.bootstrapKey,
          set: {
            name: item.name,
            kind: item.kind,
            jurisdiction: item.jurisdiction ?? null,
            baseCurrency: item.baseCurrency ?? null,
            ownerControlled: item.ownerControlled,
            primaryOwner: item.primaryOwner,
            legalStatusConfirmed: item.legalStatusConfirmed,
            notes: item.notes ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: entities.id });
      entityIds.set(item.key, row!.id);
    }

    for (const item of data.ownershipInterests) {
      const bootstrapKey = `${item.holder}->${item.held}`;
      await tx
        .insert(ownershipInterests)
        .values({
          bootstrapKey,
          holderEntityId: entityIds.require(item.holder),
          heldEntityId: entityIds.require(item.held),
          percent: item.percent ?? null,
          confirmed: item.confirmed,
          notes: item.notes ?? null,
        })
        .onConflictDoUpdate({
          target: ownershipInterests.bootstrapKey,
          set: { percent: item.percent ?? null, confirmed: item.confirmed, notes: item.notes ?? null, updatedAt: new Date() },
        });
    }

    const institutionIds = new KeyMap('institutions');
    for (const item of data.institutions) {
      const [row] = await tx
        .insert(institutions)
        .values({
          bootstrapKey: item.key,
          name: item.name,
          country: item.country ?? null,
          kind: item.kind,
          providerKey: item.providerKey ?? null,
          notes: item.notes ?? null,
        })
        .onConflictDoUpdate({
          target: institutions.bootstrapKey,
          set: { name: item.name, country: item.country ?? null, kind: item.kind, providerKey: item.providerKey ?? null, notes: item.notes ?? null, updatedAt: new Date() },
        })
        .returning({ id: institutions.id });
      institutionIds.set(item.key, row!.id);
    }

    const counterpartyIds = new KeyMap('counterparties');
    for (const item of data.counterparties) {
      const [row] = await tx
        .insert(counterparties)
        .values({ bootstrapKey: item.key, name: item.name, kind: item.kind, notes: item.notes ?? null })
        .onConflictDoUpdate({ target: counterparties.bootstrapKey, set: { name: item.name, kind: item.kind, notes: item.notes ?? null, updatedAt: new Date() } })
        .returning({ id: counterparties.id });
      counterpartyIds.set(item.key, row!.id);
    }

    const accountIds = new KeyMap('accounts');
    for (const item of data.accounts) {
      const [row] = await tx
        .insert(accounts)
        .values({
          bootstrapKey: item.key,
          name: item.name,
          kind: item.kind,
          currency: item.currency ?? null,
          institutionId: item.institution ? institutionIds.require(item.institution) : null,
          legalEntityId: item.legalEntity ? entityIds.require(item.legalEntity) : null,
          economicOwnerEntityId: item.economicOwner ? entityIds.require(item.economicOwner) : null,
          ownershipConfirmed: item.ownershipConfirmed,
          liquidityClass: item.liquidityClass,
          includeInSafeToSpend: item.includeInSafeToSpend,
          createdFrom: 'bootstrap',
          notes: item.notes ?? null,
        })
        .onConflictDoUpdate({
          target: accounts.bootstrapKey,
          set: {
            name: item.name,
            kind: item.kind,
            currency: item.currency ?? null,
            institutionId: item.institution ? institutionIds.require(item.institution) : null,
            legalEntityId: item.legalEntity ? entityIds.require(item.legalEntity) : null,
            economicOwnerEntityId: item.economicOwner ? entityIds.require(item.economicOwner) : null,
            ownershipConfirmed: item.ownershipConfirmed,
            liquidityClass: item.liquidityClass,
            includeInSafeToSpend: item.includeInSafeToSpend,
            notes: item.notes ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: accounts.id });
      accountIds.set(item.key, row!.id);
    }

    const instrumentIds = new KeyMap('instruments');
    for (const item of data.instruments) {
      const [row] = await tx
        .insert(instruments)
        .values({ bootstrapKey: item.key, symbol: item.symbol, name: item.name, kind: item.kind, currency: item.currency ?? null })
        .onConflictDoUpdate({
          target: instruments.bootstrapKey,
          set: { symbol: item.symbol, name: item.name, kind: item.kind, currency: item.currency ?? null, updatedAt: new Date() },
        })
        .returning({ id: instruments.id });
      instrumentIds.set(item.key, row!.id);
    }

    for (const item of data.balanceSnapshots) {
      await tx
        .insert(balanceSnapshots)
        .values({
          bootstrapKey: item.key,
          accountId: accountIds.require(item.account),
          kind: item.kind,
          amount: item.amount,
          currency: item.currency,
          reportedAt: new Date(data.reportedAt),
          sourceAsOf: item.sourceAsOf ? new Date(item.sourceAsOf) : null,
          approximate: item.approximate,
          completeness: item.completeness,
          composition: item.composition ?? null,
          source: item.source,
        })
        .onConflictDoUpdate({
          target: balanceSnapshots.bootstrapKey,
          set: {
            amount: item.amount,
            currency: item.currency,
            sourceAsOf: item.sourceAsOf ? new Date(item.sourceAsOf) : null,
            approximate: item.approximate,
            completeness: item.completeness,
            composition: item.composition ?? null,
            source: item.source,
            updatedAt: new Date(),
          },
        });
    }

    for (const item of data.holdingsSnapshots) {
      const [row] = await tx
        .insert(holdingsSnapshots)
        .values({
          bootstrapKey: item.key,
          accountId: accountIds.require(item.account),
          reportedAt: new Date(data.reportedAt),
          sourceAsOf: item.sourceAsOf ? new Date(item.sourceAsOf) : null,
          completeness: item.completeness,
          source: item.source,
          verified: false,
        })
        .onConflictDoUpdate({
          target: holdingsSnapshots.bootstrapKey,
          set: { sourceAsOf: item.sourceAsOf ? new Date(item.sourceAsOf) : null, completeness: item.completeness, source: item.source, updatedAt: new Date() },
        })
        .returning({ id: holdingsSnapshots.id });
      const snapshotId = row!.id;
      await tx.delete(holdingLines).where(eq(holdingLines.snapshotId, snapshotId));
      if (item.lines.length > 0) {
        await tx.insert(holdingLines).values(
          item.lines.map((line) => ({
            snapshotId,
            instrumentId: instrumentIds.require(line.instrument),
            quantity: line.quantity ?? null,
            value: line.value ?? null,
            valueCurrency: line.currency ?? null,
          })),
        );
      }
    }

    for (const item of data.fixedIncomeTerms) {
      await tx
        .insert(fixedIncomeTerms)
        .values({
          accountId: accountIds.require(item.account),
          counterpartyId: item.counterparty ? counterpartyIds.require(item.counterparty) : null,
          principal: item.principal ?? null,
          currency: item.currency ?? null,
          statedAnnualRate: item.statedAnnualRate ?? null,
          rateBasis: item.rateBasis,
          compounding: item.statedCompounding,
          fees: item.fees ?? null,
          withdrawalTerms: item.withdrawalTerms ?? null,
          startDate: item.startDate ?? null,
          maturityDate: item.maturityDate ?? null,
          verified: item.verified,
          notes: item.notes ?? null,
        })
        .onConflictDoUpdate({
          target: fixedIncomeTerms.accountId,
          set: {
            counterpartyId: item.counterparty ? counterpartyIds.require(item.counterparty) : null,
            principal: item.principal ?? null,
            currency: item.currency ?? null,
            statedAnnualRate: item.statedAnnualRate ?? null,
            rateBasis: item.rateBasis,
            compounding: item.statedCompounding,
            fees: item.fees ?? null,
            withdrawalTerms: item.withdrawalTerms ?? null,
            startDate: item.startDate ?? null,
            maturityDate: item.maturityDate ?? null,
            verified: item.verified,
            notes: item.notes ?? null,
            updatedAt: new Date(),
          },
        });
    }

    for (const item of data.restrictions) {
      const bootstrapKey = `${item.account}:${item.instrument ?? ''}:${item.kind}`;
      await tx
        .insert(restrictions)
        .values({
          bootstrapKey,
          accountId: accountIds.require(item.account),
          instrumentId: item.instrument ? instrumentIds.require(item.instrument) : null,
          kind: item.kind,
          status: item.status,
          terms: item.terms ?? {},
          effectiveFrom: item.effectiveFrom ?? null,
          effectiveTo: item.effectiveTo ?? null,
          notes: item.notes ?? null,
        })
        .onConflictDoUpdate({
          target: restrictions.bootstrapKey,
          set: { status: item.status, terms: item.terms ?? {}, effectiveFrom: item.effectiveFrom ?? null, effectiveTo: item.effectiveTo ?? null, notes: item.notes ?? null, updatedAt: new Date() },
        });
    }

    for (const item of data.watchEvents) {
      const bootstrapKey = `${item.subject ?? ''}:${item.kind}:${item.title}`;
      await tx
        .insert(watchEvents)
        .values({
          bootstrapKey,
          accountId: item.subject ? (accountIds.get(item.subject) ?? null) : null,
          instrumentId: item.subject ? (instrumentIds.get(item.subject) ?? null) : null,
          kind: item.kind,
          title: item.title,
          status: item.status,
          expectedDate: item.expectedDate ?? null,
          notes: item.notes ?? null,
        })
        .onConflictDoUpdate({
          target: watchEvents.bootstrapKey,
          set: { status: item.status, expectedDate: item.expectedDate ?? null, notes: item.notes ?? null, updatedAt: new Date() },
        });
    }

    for (const item of data.thirdPartyArrangements) {
      await tx
        .insert(thirdPartyArrangements)
        .values({
          bootstrapKey: item.key,
          thirdPartyEntityId: entityIds.require(item.thirdParty),
          currency: item.currency ?? null,
          feeRate: item.statedFeeRate ?? null,
          feeMode: item.feeMode,
          feeModeConfirmed: item.feeMode !== 'unconfirmed',
          feeRecipientEntityId: item.feeRecipient ? entityIds.require(item.feeRecipient) : null,
          openingBalance: item.openingBalance ?? null,
          openingBalanceAsOf: item.openingBalanceAsOf ?? null,
          holdingEntityIds: item.holdingEntities.map((k) => entityIds.require(k)),
          economicallyOwnedAccountIds: item.economicallyOwnedAccounts.map((k) => accountIds.require(k)),
          notes: item.notes ?? null,
        })
        .onConflictDoUpdate({
          target: thirdPartyArrangements.bootstrapKey,
          set: {
            currency: item.currency ?? null,
            feeRate: item.statedFeeRate ?? null,
            feeMode: item.feeMode,
            feeModeConfirmed: item.feeMode !== 'unconfirmed',
            feeRecipientEntityId: item.feeRecipient ? entityIds.require(item.feeRecipient) : null,
            openingBalance: item.openingBalance ?? null,
            openingBalanceAsOf: item.openingBalanceAsOf ?? null,
            holdingEntityIds: item.holdingEntities.map((k) => entityIds.require(k)),
            economicallyOwnedAccountIds: item.economicallyOwnedAccounts.map((k) => accountIds.require(k)),
            notes: item.notes ?? null,
            updatedAt: new Date(),
          },
        });
    }

    for (const item of data.recurringCommitments) {
      await tx
        .insert(recurringItems)
        .values({
          name: item.key,
          bootstrapKey: item.key,
          entityId: entityIds.require(item.entity),
          accountId: item.account ? (accountIds.get(item.account) ?? null) : null,
          counterpartyId: item.counterparty ? (counterpartyIds.get(item.counterparty) ?? null) : null,
          kind: item.kind,
          direction: item.direction,
          amount: item.amount ?? null,
          currency: item.currency ?? null,
          cadence: item.cadence,
          status: item.status,
          detected: false,
          confirmed: true,
          internalCounterpartyEntityId: item.internalTo ? (entityIds.get(item.internalTo) ?? null) : null,
        })
        .onConflictDoUpdate({
          target: recurringItems.bootstrapKey,
          set: {
            amount: item.amount ?? null,
            currency: item.currency ?? null,
            cadence: item.cadence,
            status: item.status,
            updatedAt: new Date(),
          },
        });
    }

    for (const item of data.openQuestions) {
      const subjectId = item.subjectAccount ? (accountIds.get(item.subjectAccount) ?? null) : null;
      await raiseException(tx, {
        dedupeKey: `bootstrap:open_question:${item.kind}:${item.subjectAccount ?? 'none'}:${item.title}`,
        kind: 'missing_information',
        severity: 'info',
        title: item.title,
        body: item.detail,
        subjectType: item.subjectAccount ? 'account' : 'bootstrap',
        subjectId,
        entityId: null,
        source: 'bootstrap',
      });
    }

    logger.info({ bootstrapId: data.bootstrapId }, 'bootstrap applied');
    const counts: BootstrapCounts = {
      entities: data.entities.length,
      ownershipInterests: data.ownershipInterests.length,
      institutions: data.institutions.length,
      counterparties: data.counterparties.length,
      accounts: data.accounts.length,
      instruments: data.instruments.length,
      balanceSnapshots: data.balanceSnapshots.length,
      holdingsSnapshots: data.holdingsSnapshots.length,
      fixedIncomeTerms: data.fixedIncomeTerms.length,
      restrictions: data.restrictions.length,
      watchEvents: data.watchEvents.length,
      thirdPartyArrangements: data.thirdPartyArrangements.length,
      recurringCommitments: data.recurringCommitments.length,
      openQuestions: data.openQuestions.length,
    };

    const countsRecord: Record<string, number> = Object.fromEntries(Object.entries(counts));

    await tx
      .insert(bootstrapRuns)
      .values({ bootstrapId: data.bootstrapId, formatVersion: data.formatVersion, fileSha256, counts: countsRecord, appliedBy: 'bootstrap-cli' })
      .onConflictDoUpdate({
        target: bootstrapRuns.bootstrapId,
        set: { formatVersion: data.formatVersion, fileSha256, counts: countsRecord, appliedAt: new Date() },
      });

    return counts;
  });
}

/**
 * Loads the bootstrap file at `path`. Skips re-applying it when `bootstrap_runs` already has a
 * row for this exact bootstrapId with the same file hash. Never logs the file's contents; only
 * counts.
 */
export async function loadBootstrapFile(db: DbOrTx, path: string, logger: Logger, readFile: (path: string) => string): Promise<BootstrapResult> {
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    throw new BootstrapError(`could not read bootstrap file: ${err instanceof Error ? redactText(err.message) : 'unknown error'}`);
  }
  const { data, sha256 } = readBootstrapFile(text);
  const existing = await db.select().from(bootstrapRuns).where(eq(bootstrapRuns.bootstrapId, data.bootstrapId)).limit(1);
  if (existing[0] && existing[0].fileSha256 === sha256) {
    logger.info({ bootstrapId: data.bootstrapId }, 'bootstrap already applied; file unchanged, nothing to do');
    return { applied: false, bootstrapId: data.bootstrapId, counts: existing[0].counts as unknown as BootstrapCounts };
  }
  const counts = await applyBootstrap(db, data, sha256, logger);
  return { applied: true, bootstrapId: data.bootstrapId, counts };
}
