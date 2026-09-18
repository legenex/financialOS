import type { ColumnMapping, ImportFileKind } from '@financialos/contracts';

/**
 * Built-in starter mapping templates. None of these claims to match a specific bank's export exactly: every
 * one is unverified and must be checked against the owner's file before the mapping is saved as verified.
 */
export interface BuiltInTemplate {
  key: string;
  name: string;
  label: 'starter template — verify columns';
  description: string;
  providerKey: string | null;
  fileKind: ImportFileKind;
  verified: false;
  /** Header names this template expects (informational; mapping columns reference these). */
  expectedHeaders: string[];
  mapping: ColumnMapping;
  /** What was and was not verified about the layout. */
  provenance: string;
}

const LABEL = 'starter template — verify columns' as const;

function base(overrides: Partial<ColumnMapping>): ColumnMapping {
  return {
    hasHeader: true,
    skipRows: 0,
    delimiter: null,
    sheetName: null,
    dateColumn: 'Date',
    valueDateColumn: null,
    dateFormat: 'YYYY-MM-DD',
    descriptionColumns: ['Description'],
    counterpartyColumn: null,
    referenceColumn: null,
    balanceColumn: null,
    currencyColumn: null,
    statusColumn: null,
    categoryColumn: null,
    amountMode: 'signed',
    amountColumn: 'Amount',
    debitColumn: null,
    creditColumn: null,
    directionColumn: null,
    debitMarkers: [],
    negativeIsDebit: true,
    decimalSeparator: '.',
    thousandsSeparator: ',',
    defaultCurrency: 'USD',
    sourceTimezone: 'UTC',
    ...overrides,
  };
}

export const BUILT_IN_TEMPLATES: readonly BuiltInTemplate[] = [
  {
    key: 'generic-signed-amount',
    name: 'Generic CSV — signed amount',
    label: LABEL,
    description: 'One amount column where negative numbers are money out. ISO dates. Optional running balance.',
    providerKey: null,
    fileKind: 'csv',
    verified: false,
    expectedHeaders: ['Date', 'Description', 'Amount', 'Balance'],
    mapping: base({ balanceColumn: 'Balance' }),
    provenance: 'Generic layout; not tied to any provider.',
  },
  {
    key: 'generic-debit-credit',
    name: 'Generic CSV — separate debit and credit columns',
    label: LABEL,
    description: 'Money out in a Debit column and money in in a Credit column. ISO dates. Optional running balance.',
    providerKey: null,
    fileKind: 'csv',
    verified: false,
    expectedHeaders: ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
    mapping: base({ amountMode: 'debit_credit', amountColumn: null, debitColumn: 'Debit', creditColumn: 'Credit', balanceColumn: 'Balance' }),
    provenance: 'Generic layout; not tied to any provider.',
  },
  {
    key: 'generic-ddmmyyyy-zar',
    name: 'Day-first statement CSV (South-African style)',
    label: LABEL,
    description: 'DD/MM/YYYY dates, signed amounts with a running balance, rand as the default currency, Africa/Johannesburg dates.',
    providerKey: null,
    fileKind: 'csv',
    verified: false,
    expectedHeaders: ['Date', 'Description', 'Amount', 'Balance'],
    mapping: base({ dateFormat: 'DD/MM/YYYY', balanceColumn: 'Balance', thousandsSeparator: '', defaultCurrency: 'ZAR', sourceTimezone: 'Africa/Johannesburg' }),
    provenance:
      'Generic day-first layout. It is not a published layout of any specific South African bank; check column names, date format, and separators against your file.',
  },
  {
    key: 'generic-multicurrency-status',
    name: 'Multi-currency account statement with status column',
    label: LABEL,
    description:
      'Separate started/completed date columns, a signed amount, a currency column, a state column (pending rows stay pending), and a balance. Completed date is used as the booking date.',
    providerKey: null,
    fileKind: 'csv',
    verified: false,
    expectedHeaders: ['Type', 'Started Date', 'Completed Date', 'Description', 'Amount', 'Fee', 'Currency', 'State', 'Balance'],
    mapping: base({
      dateColumn: 'Completed Date',
      valueDateColumn: null,
      dateFormat: 'iso_datetime',
      currencyColumn: 'Currency',
      statusColumn: 'State',
      categoryColumn: 'Type',
      balanceColumn: 'Balance',
      thousandsSeparator: '',
      defaultCurrency: 'EUR',
    }),
    provenance:
      'Resembles layouts some consumer fintech apps export, but no official provider documentation of these columns was found on 2026-09-17, so it is generic. Fees in a separate column are not netted into the amount; check how your export records fees.',
  },
  {
    key: 'generic-us-mmddyyyy',
    name: 'US-style CSV — MM/DD/YYYY dates',
    label: LABEL,
    description: 'Month-first dates, signed amounts, US dollar default. Suitable as a starting point for US business bank exports.',
    providerKey: null,
    fileKind: 'csv',
    verified: false,
    expectedHeaders: ['Date', 'Description', 'Amount', 'Status'],
    mapping: base({ dateFormat: 'MM/DD/YYYY', statusColumn: 'Status', defaultCurrency: 'USD', sourceTimezone: 'America/New_York' }),
    provenance:
      'Generic. A provider-specific business-bank CSV template was not added because the provider help pages describing export columns could not be verified on 2026-09-17; prefer the provider API where available.',
  },
];

export function getBuiltInTemplate(key: string): BuiltInTemplate | undefined {
  return BUILT_IN_TEMPLATES.find((t) => t.key === key);
}

/** Copies a template mapping with the owner's currency and time zone applied. */
export function templateMapping(key: string, overrides: Partial<Pick<ColumnMapping, 'defaultCurrency' | 'sourceTimezone'>> = {}): ColumnMapping {
  const template = getBuiltInTemplate(key);
  if (!template) throw new Error(`Unknown template ${key}`);
  return { ...template.mapping, descriptionColumns: [...template.mapping.descriptionColumns], debitMarkers: [...template.mapping.debitMarkers], ...overrides };
}
