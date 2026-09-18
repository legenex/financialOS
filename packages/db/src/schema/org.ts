import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, isoDate, jsonObject, pk, provenance, rate, tstz, updatedAt } from './_columns';
import { currencies } from './reference';

export const ENTITY_KINDS = ['person', 'company', 'trust', 'third_party'] as const;
export type EntityKindValue = (typeof ENTITY_KINDS)[number];

export const entities = pgTable(
  'entities',
  {
    id: pk(),
    name: text('name').notNull(),
    kind: text('kind').$type<EntityKindValue>().notNull(),
    jurisdiction: text('jurisdiction'),
    baseCurrency: text('base_currency').references(() => currencies.code),
    ownerControlled: boolean('owner_controlled').notNull().default(false),
    primaryOwner: boolean('primary_owner').notNull().default(false),
    legalStatusConfirmed: boolean('legal_status_confirmed').notNull().default(false),
    notes: text('notes'),
    provenance: provenance(),
    bootstrapKey: text('bootstrap_key').unique('entities_bootstrap_key_key'),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('entities_kind_check', inList('kind', ENTITY_KINDS)),
    uniqueIndex('entities_single_primary_owner').on(t.primaryOwner).where(sql`primary_owner`),
    check('entities_primary_owner_is_person_check', sql`NOT primary_owner OR kind = 'person'`),
    check('entities_third_party_not_owner_controlled_check', sql`kind <> 'third_party' OR NOT owner_controlled`),
  ],
);

/** Holder entity owns part of held entity. `percent` is 0–100 and may be unknown (NULL). */
export const ownershipInterests = pgTable(
  'ownership_interests',
  {
    id: pk(),
    holderEntityId: uuid('holder_entity_id')
      .notNull()
      .references(() => entities.id),
    heldEntityId: uuid('held_entity_id')
      .notNull()
      .references(() => entities.id),
    percent: rate('percent'),
    confirmed: boolean('confirmed').notNull().default(false),
    effectiveFrom: isoDate('effective_from'),
    effectiveTo: isoDate('effective_to'),
    notes: text('notes'),
    provenance: provenance(),
    bootstrapKey: text('bootstrap_key').unique('ownership_interests_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('ownership_interests_distinct_check', sql`holder_entity_id <> held_entity_id`),
    check('ownership_interests_percent_check', sql`percent IS NULL OR (percent >= 0 AND percent <= 100)`),
    index('ownership_interests_held_idx').on(t.heldEntityId),
  ],
);

export const INSTITUTION_KINDS = ['bank', 'broker', 'wallet', 'fund', 'issuer', 'lender', 'other'] as const;

export const institutions = pgTable(
  'institutions',
  {
    id: pk(),
    name: text('name').notNull(),
    country: text('country'),
    kind: text('kind').$type<(typeof INSTITUTION_KINDS)[number]>().notNull(),
    providerKey: text('provider_key'),
    notes: text('notes'),
    bootstrapKey: text('bootstrap_key').unique('institutions_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  () => [check('institutions_kind_check', inList('kind', INSTITUTION_KINDS))],
);

export const COUNTERPARTY_KINDS = ['person', 'business', 'government', 'internal', 'unknown'] as const;

export const counterparties = pgTable(
  'counterparties',
  {
    id: pk(),
    name: text('name').notNull(),
    kind: text('kind').$type<(typeof COUNTERPARTY_KINDS)[number]>().notNull().default('unknown'),
    /** Set when the counterparty is one of our own entities (internal movements). */
    entityId: uuid('entity_id').references(() => entities.id),
    normalizedName: text('normalized_name'),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    notes: text('notes'),
    bootstrapKey: text('bootstrap_key').unique('counterparties_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('counterparties_kind_check', inList('kind', COUNTERPARTY_KINDS)),
    index('counterparties_normalized_name_idx').on(t.normalizedName),
  ],
);

export const INSTRUMENT_KINDS = [
  'equity',
  'etf',
  'fund',
  'crypto',
  'bond',
  'cash',
  'private_note',
  'restricted_equity',
  'other',
] as const;

export const instruments = pgTable(
  'instruments',
  {
    id: pk(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<(typeof INSTRUMENT_KINDS)[number]>().notNull(),
    currency: text('currency'),
    exchange: text('exchange'),
    isin: text('isin'),
    identifiers: jsonObject('identifiers'),
    bootstrapKey: text('bootstrap_key').unique('instruments_bootstrap_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('instruments_kind_check', inList('kind', INSTRUMENT_KINDS)),
    unique('instruments_identity_key').on(t.kind, t.symbol, t.exchange).nullsNotDistinct(),
    uniqueIndex('instruments_isin_key').on(t.isin).where(sql`isin IS NOT NULL`),
  ],
);
