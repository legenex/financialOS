import type { CapabilityFlag, CredentialField, ProviderMethod } from '@financialos/contracts';

/** The date every descriptor in this package was checked against the provider's own documentation. */
export const CHECKED_ON = '2026-09-18';

export function yes(note: string | null = null): CapabilityFlag {
  return { supported: true, note };
}

export function no(note: string): CapabilityFlag {
  return { supported: false, note };
}

export type Capabilities = ProviderMethod['capabilities'];

const NOT_OFFERED = 'This method does not offer it.';

/** Builds a full capability set: anything not named is unsupported, never optimistically assumed. */
export function capabilities(overrides: Partial<Capabilities>, defaultNote = NOT_OFFERED): Capabilities {
  const fallback = no(defaultNote);
  return {
    balances: overrides.balances ?? fallback,
    transactions: overrides.transactions ?? fallback,
    pendingTransactions: overrides.pendingTransactions ?? fallback,
    holdings: overrides.holdings ?? fallback,
    investmentTransactions: overrides.investmentTransactions ?? fallback,
    cards: overrides.cards ?? fallback,
    statements: overrides.statements ?? fallback,
    agentContext: overrides.agentContext ?? fallback,
  };
}

export function secretField(key: string, label: string, help: string, pattern?: string): CredentialField {
  return { key, label, kind: 'secret', required: true, help, ...(pattern ? { pattern } : {}) };
}

export function textField(key: string, label: string, help: string, required = true, pattern?: string): CredentialField {
  return { key, label, kind: 'text', required, help, ...(pattern ? { pattern } : {}) };
}

export function urlField(key: string, label: string, help: string, required = true): CredentialField {
  return { key, label, kind: 'url', required, help };
}

export function numberField(key: string, label: string, help: string, required = false): CredentialField {
  return { key, label, kind: 'number', required, help };
}

export function booleanField(key: string, label: string, help: string): CredentialField {
  return { key, label, kind: 'boolean', required: false, help };
}

export function selectField(key: string, label: string, help: string, options: Array<{ value: string; label: string }>, required = true): CredentialField {
  return { key, label, kind: 'select', required, help, options };
}

/** Shared wording for a method with no live account behind it yet. */
export function unverifiedHistory(documentedDays: number | null, note: string): ProviderMethod['historyLimit'] {
  return { documentedDays, verifiedDays: null, note };
}

/** Every method in this package is read-only; this helper makes that impossible to forget. */
export function readOnlyMethod(method: Omit<ProviderMethod, 'readOnly'>): ProviderMethod {
  return { ...method, readOnly: true };
}

/** The import path is available for any provider whose files the owner can download. */
export const IMPORT_FILE_KINDS = ['csv', 'xlsx', 'ofx', 'qfx', 'pdf'] as const;

export const IMPORT_CAPABILITIES = capabilities(
  {
    balances: yes('Statement opening and closing balances, when the file states them.'),
    transactions: yes('Every row in the file, mapped by a saved template.'),
    pendingTransactions: yes('Only when the file marks a row as pending.'),
    statements: yes('The uploaded file is kept as the evidence for the rows it produced.'),
  },
  'File imports carry only what the file contains.',
);
