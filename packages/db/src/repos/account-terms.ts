/**
 * The three per-account detail records: fixed income terms, liability terms and property
 * details. Each is at most one row per account (a unique constraint enforces it), so every
 * write is an upsert.
 *
 * Rates carry an explicit basis. `unverified` means we were told a percentage but do not
 * know whether it is nominal or effective, so no interest projection may claim precision.
 * Unknown figures stay NULL.
 */
import { eq } from 'drizzle-orm';
import { fixedIncomeTerms, liabilityTerms, propertyDetails, type COMPOUNDING, type RATE_BASES } from '../schema/accounts';
import { assertDecimal, InvalidError, mapErrors, required, type DbOrTx } from './_util';

export type FixedIncomeTermsRow = typeof fixedIncomeTerms.$inferSelect;
export type LiabilityTermsRow = typeof liabilityTerms.$inferSelect;
export type PropertyDetailsRow = typeof propertyDetails.$inferSelect;
export type RateBasis = (typeof RATE_BASES)[number];
export type Compounding = (typeof COMPOUNDING)[number];

// ---------------------------------------------------------------------------------------
// Fixed income
// ---------------------------------------------------------------------------------------

export interface FixedIncomeInput {
  accountId: string;
  principal?: string | null;
  currency?: string | null;
  statedAnnualRate?: string | null;
  /** `unverified` until a document says whether the rate is nominal or effective. */
  rateBasis?: RateBasis;
  compounding?: Compounding;
  fees?: string | null;
  withdrawalTerms?: string | null;
  counterpartyId?: string | null;
  counterpartyName?: string | null;
  startDate?: string | null;
  maturityDate?: string | null;
  verified?: boolean;
  notes?: string | null;
  documentId?: string | null;
  provenance?: Record<string, unknown>;
  bootstrapKey?: string | null;
}

export async function upsertFixedIncome(db: DbOrTx, input: FixedIncomeInput): Promise<FixedIncomeTermsRow> {
  if (input.principal != null) assertDecimal(input.principal, 'principal');
  if (input.statedAnnualRate != null) assertDecimal(input.statedAnnualRate, 'statedAnnualRate');
  const rateBasis = input.rateBasis ?? 'unverified';
  if (input.verified && rateBasis === 'unverified') {
    throw new InvalidError('Fixed income terms cannot be verified while the rate basis is unverified');
  }
  const values = {
    accountId: input.accountId,
    principal: input.principal ?? null,
    currency: input.currency ?? null,
    statedAnnualRate: input.statedAnnualRate ?? null,
    rateBasis,
    compounding: input.compounding ?? 'unknown',
    fees: input.fees ?? null,
    withdrawalTerms: input.withdrawalTerms ?? null,
    counterpartyId: input.counterpartyId ?? null,
    counterpartyName: input.counterpartyName ?? null,
    startDate: input.startDate ?? null,
    maturityDate: input.maturityDate ?? null,
    verified: input.verified ?? false,
    notes: input.notes ?? null,
    documentId: input.documentId ?? null,
    provenance: input.provenance ?? {},
    bootstrapKey: input.bootstrapKey ?? null,
  };
  // The bootstrap key identifies who first created the row and is never rewritten.
  const { bootstrapKey: _bootstrapKey, ...onUpdate } = values;
  return mapErrors('upsert fixed income terms', async () => {
    const [row] = await db
      .insert(fixedIncomeTerms)
      .values(values)
      .onConflictDoUpdate({ target: fixedIncomeTerms.accountId, set: onUpdate })
      .returning();
    return required(row, 'fixed income terms');
  });
}

export async function getFixedIncome(db: DbOrTx, accountId: string): Promise<FixedIncomeTermsRow | undefined> {
  const [row] = await db.select().from(fixedIncomeTerms).where(eq(fixedIncomeTerms.accountId, accountId)).limit(1);
  return row;
}

export async function getFixedIncomeByBootstrapKey(db: DbOrTx, key: string): Promise<FixedIncomeTermsRow | undefined> {
  const [row] = await db.select().from(fixedIncomeTerms).where(eq(fixedIncomeTerms.bootstrapKey, key)).limit(1);
  return row;
}

export async function listFixedIncome(db: DbOrTx): Promise<FixedIncomeTermsRow[]> {
  return db.select().from(fixedIncomeTerms);
}

// ---------------------------------------------------------------------------------------
// Liabilities
// ---------------------------------------------------------------------------------------

export interface LiabilityInput {
  accountId: string;
  principal?: string | null;
  currency?: string | null;
  interestRate?: string | null;
  rateBasis?: RateBasis;
  rateType?: 'fixed' | 'variable' | 'unknown';
  paymentAmount?: string | null;
  paymentCadence?: string | null;
  termMonths?: number | null;
  /** A credit limit is buying power, never a cash reserve. */
  creditLimit?: string | null;
  startDate?: string | null;
  maturityDate?: string | null;
  lenderCounterpartyId?: string | null;
  securedByAccountId?: string | null;
  verified?: boolean;
  notes?: string | null;
}

export async function upsertLiability(db: DbOrTx, input: LiabilityInput): Promise<LiabilityTermsRow> {
  for (const [label, value] of [
    ['principal', input.principal],
    ['interestRate', input.interestRate],
    ['paymentAmount', input.paymentAmount],
    ['creditLimit', input.creditLimit],
  ] as const) {
    if (value != null) assertDecimal(value, label);
  }
  const values = {
    accountId: input.accountId,
    principal: input.principal ?? null,
    currency: input.currency ?? null,
    interestRate: input.interestRate ?? null,
    rateBasis: input.rateBasis ?? 'unverified',
    rateType: input.rateType ?? 'unknown',
    paymentAmount: input.paymentAmount ?? null,
    paymentCadence: input.paymentCadence ?? null,
    termMonths: input.termMonths ?? null,
    creditLimit: input.creditLimit ?? null,
    startDate: input.startDate ?? null,
    maturityDate: input.maturityDate ?? null,
    lenderCounterpartyId: input.lenderCounterpartyId ?? null,
    securedByAccountId: input.securedByAccountId ?? null,
    verified: input.verified ?? false,
    notes: input.notes ?? null,
  };
  return mapErrors('upsert liability terms', async () => {
    const [row] = await db
      .insert(liabilityTerms)
      .values(values)
      .onConflictDoUpdate({ target: liabilityTerms.accountId, set: values })
      .returning();
    return required(row, 'liability terms');
  });
}

export async function getLiability(db: DbOrTx, accountId: string): Promise<LiabilityTermsRow | undefined> {
  const [row] = await db.select().from(liabilityTerms).where(eq(liabilityTerms.accountId, accountId)).limit(1);
  return row;
}

export async function listLiabilities(db: DbOrTx): Promise<LiabilityTermsRow[]> {
  return db.select().from(liabilityTerms);
}

// ---------------------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------------------

export interface PropertyInput {
  accountId: string;
  label?: string | null;
  country?: string | null;
  purchaseDate?: string | null;
  purchasePrice?: string | null;
  purchaseCurrency?: string | null;
  valuation?: string | null;
  valuationCurrency?: string | null;
  valuationAsOf?: string | null;
  valuationSource?: string | null;
  /** Fraction between 0 and 1. NULL when the share is not known. */
  ownershipShare?: string | null;
  mortgageAccountId?: string | null;
  verified?: boolean;
  notes?: string | null;
}

export async function upsertProperty(db: DbOrTx, input: PropertyInput): Promise<PropertyDetailsRow> {
  for (const [label, value] of [
    ['purchasePrice', input.purchasePrice],
    ['valuation', input.valuation],
    ['ownershipShare', input.ownershipShare],
  ] as const) {
    if (value != null) assertDecimal(value, label);
  }
  const values = {
    accountId: input.accountId,
    label: input.label ?? null,
    country: input.country ?? null,
    purchaseDate: input.purchaseDate ?? null,
    purchasePrice: input.purchasePrice ?? null,
    purchaseCurrency: input.purchaseCurrency ?? null,
    valuation: input.valuation ?? null,
    valuationCurrency: input.valuationCurrency ?? null,
    valuationAsOf: input.valuationAsOf ?? null,
    valuationSource: input.valuationSource ?? null,
    ownershipShare: input.ownershipShare ?? null,
    mortgageAccountId: input.mortgageAccountId ?? null,
    verified: input.verified ?? false,
    notes: input.notes ?? null,
  };
  return mapErrors('upsert property details', async () => {
    const [row] = await db
      .insert(propertyDetails)
      .values(values)
      .onConflictDoUpdate({ target: propertyDetails.accountId, set: values })
      .returning();
    return required(row, 'property details');
  });
}

export async function getProperty(db: DbOrTx, accountId: string): Promise<PropertyDetailsRow | undefined> {
  const [row] = await db.select().from(propertyDetails).where(eq(propertyDetails.accountId, accountId)).limit(1);
  return row;
}

export async function listProperties(db: DbOrTx): Promise<PropertyDetailsRow[]> {
  return db.select().from(propertyDetails);
}
