/**
 * `cli.mjs seed-demo` — loads a small, entirely synthetic dataset through the same bootstrap
 * loader as a real owner bootstrap file (`./bootstrap.ts`), so it exercises the same validation
 * and idempotent upsert path. Refuses to run against a production-configured worker: this data is
 * fake and must never appear next to real owner data.
 */
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { DbOrTx } from '@financialos/db';
import { applyBootstrap, type BootstrapFile } from './bootstrap';
import type { WorkerConfig } from './config';

export class SeedDemoError extends Error {
  override readonly name = 'SeedDemoError';
}

/** A small, clearly-labelled synthetic dataset: one person, one bank, two accounts, two balances. */
export function buildDemoBootstrapFile(asOf = new Date().toISOString().slice(0, 10)): BootstrapFile {
  return {
    formatVersion: 1,
    bootstrapId: 'seed-demo-v1',
    reportedAt: new Date().toISOString(),
    reportedBy: 'seed-demo',
    provenanceNote: 'Synthetic demo data (cli.mjs seed-demo). Not real financial data.',
    settings: { reportingCurrency: 'USD', budgetCurrency: 'USD', reportingTimezone: 'UTC' },
    entities: [
      {
        key: 'demo-person',
        name: 'Demo Owner',
        kind: 'person',
        jurisdiction: null,
        baseCurrency: 'USD',
        ownerControlled: true,
        primaryOwner: true,
        legalStatusConfirmed: true,
        notes: 'Synthetic demo entity.',
      },
    ],
    ownershipInterests: [],
    institutions: [{ key: 'demo-bank', name: 'Demo Bank', country: 'US', kind: 'bank', providerKey: null, notes: null }],
    counterparties: [],
    accounts: [
      {
        key: 'demo-checking',
        institution: 'demo-bank',
        name: 'Demo Checking',
        kind: 'current',
        currency: 'USD',
        legalEntity: 'demo-person',
        economicOwner: 'demo-person',
        liquidityClass: 'cash',
        includeInSafeToSpend: true,
        ownershipConfirmed: true,
        notes: 'Synthetic demo account.',
      },
      {
        key: 'demo-savings',
        institution: 'demo-bank',
        name: 'Demo Savings',
        kind: 'savings',
        currency: 'USD',
        legalEntity: 'demo-person',
        economicOwner: 'demo-person',
        liquidityClass: 'cash',
        includeInSafeToSpend: false,
        ownershipConfirmed: true,
        notes: 'Synthetic demo account.',
      },
    ],
    instruments: [],
    balanceSnapshots: [
      {
        key: 'demo-checking-balance',
        account: 'demo-checking',
        kind: 'manual',
        amount: '2450.00',
        currency: 'USD',
        approximate: false,
        sourceAsOf: asOf,
        source: 'seed-demo',
        completeness: 'complete',
        composition: null,
        notes: null,
      },
      {
        key: 'demo-savings-balance',
        account: 'demo-savings',
        kind: 'manual',
        amount: '9000.00',
        currency: 'USD',
        approximate: false,
        sourceAsOf: asOf,
        source: 'seed-demo',
        completeness: 'complete',
        composition: null,
        notes: null,
      },
    ],
    holdingsSnapshots: [],
    fixedIncomeTerms: [],
    restrictions: [],
    watchEvents: [],
    thirdPartyArrangements: [],
    recurringCommitments: [],
    openQuestions: [],
  };
}

export async function seedDemo(db: DbOrTx, config: WorkerConfig, logger: Logger): Promise<{ bootstrapId: string }> {
  if (config.environment === 'production') {
    throw new SeedDemoError('refusing to seed synthetic demo data into a production-configured worker');
  }
  const data = buildDemoBootstrapFile();
  const fileSha256 = createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex');
  await applyBootstrap(db, data, fileSha256, logger);
  return { bootstrapId: data.bootstrapId };
}
