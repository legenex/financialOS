import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, inList, isoDate, money, pk, rate, tstz } from './_columns';
import { instruments } from './org';

export const CURRENCY_KINDS = ['fiat', 'crypto', 'other'] as const;

export const currencies = pgTable(
  'currencies',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    minorUnits: smallint('minor_units').notNull(),
    kind: text('kind').$type<(typeof CURRENCY_KINDS)[number]>().notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  () => [
    check('currencies_code_check', sql`code ~ '^[A-Z0-9]{2,10}$'`),
    check('currencies_minor_units_check', sql`minor_units BETWEEN 0 AND 18`),
    check('currencies_kind_check', inList('kind', CURRENCY_KINDS)),
  ],
);

export const FX_RATE_KINDS = ['reference', 'market', 'manual', 'implied'] as const;

/** One unit of `base` is worth `rate` units of `quote` on `as_of`. */
export const fxRates = pgTable(
  'fx_rates',
  {
    id: pk(),
    base: text('base')
      .notNull()
      .references(() => currencies.code),
    quote: text('quote')
      .notNull()
      .references(() => currencies.code),
    rate: rate('rate').notNull(),
    asOf: isoDate('as_of').notNull(),
    source: text('source').notNull(),
    kind: text('kind').$type<(typeof FX_RATE_KINDS)[number]>().notNull().default('reference'),
    fetchedAt: tstz('fetched_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('fx_rates_base_quote_as_of_source_key').on(t.base, t.quote, t.asOf, t.source),
    index('fx_rates_lookup_idx').on(t.base, t.quote, t.asOf),
    check('fx_rates_positive_check', sql`rate > 0`),
    check('fx_rates_distinct_check', sql`base <> quote`),
    check('fx_rates_kind_check', inList('kind', FX_RATE_KINDS)),
  ],
);

export const PRICE_KINDS = ['real_time', 'delayed', 'end_of_day', 'manual', 'statement', 'unknown'] as const;

export const prices = pgTable(
  'prices',
  {
    id: pk(),
    instrumentId: uuid('instrument_id')
      .notNull()
      .references(() => instruments.id),
    price: money('price').notNull(),
    currency: text('currency')
      .notNull()
      .references(() => currencies.code),
    asOf: tstz('as_of').notNull(),
    source: text('source').notNull(),
    priceKind: text('price_kind').$type<(typeof PRICE_KINDS)[number]>().notNull().default('unknown'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('prices_instrument_as_of_source_key').on(t.instrumentId, t.asOf, t.source),
    index('prices_lookup_idx').on(t.instrumentId, t.asOf),
    check('prices_non_negative_check', sql`price >= 0`),
    check('prices_kind_check', inList('price_kind', PRICE_KINDS)),
  ],
);
