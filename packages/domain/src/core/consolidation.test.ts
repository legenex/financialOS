import { ConsolidatedView } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { dec, money } from '../money';
import { consolidateFlows, entityFlowReport, flowsFromJournalEntries, toConsolidatedEliminations, type ConsolidationFlow, type ConsolidationResult } from './consolidation';
import { buildIncomeExpenseEntry, buildTransferEntry, chartOf, reverseEntry, buildOpeningBalanceEntry, buildSplitEntry, type LedgerAccount } from './ledger';
import type { EntityInfo } from './types';

const OWNER = 'ent-owner';
const OPCO = 'ent-opco';
const SERVICES = 'ent-services';
const CLIENT = 'ent-client';

const entities: EntityInfo[] = [
  { id: OWNER, name: 'Sample Owner', kind: 'person', ownerControlled: true, primaryOwner: true },
  { id: OPCO, name: 'Example Holdings Ltd', kind: 'company', ownerControlled: true, primaryOwner: false },
  { id: SERVICES, name: 'Sample Consulting LLC', kind: 'company', ownerControlled: true, primaryOwner: false },
  { id: CLIENT, name: 'Third Party A', kind: 'third_party', ownerControlled: false, primaryOwner: false },
];
const ALL = [OWNER, OPCO, SERVICES];

function flow(id: string, entityId: string, amount: string, nature: ConsolidationFlow['nature'], counterpartyEntityId: string | null, extra: Partial<ConsolidationFlow> = {}): ConsolidationFlow {
  return { id, entityId, counterpartyEntityId, amount: money(amount, 'USD'), nature, date: '2026-07-01', label: id, ...extra };
}

const flows: ConsolidationFlow[] = [
  // SERVICES invoices OPCO; OPCO pays.
  flow('inv-opco', OPCO, '-1000', 'intercompany', SERVICES),
  flow('inv-services', SERVICES, '1000', 'intercompany', OPCO),
  // OPCO pays the owner a salary.
  flow('sal-opco', OPCO, '-500', 'salary', OWNER),
  flow('sal-owner', OWNER, '500', 'salary', OPCO),
  // The owner moves money into OPCO.
  flow('xfer-owner', OWNER, '-200', 'owner_contribution', OPCO),
  flow('xfer-opco', OPCO, '200', 'owner_contribution', OWNER),
  // External flows.
  flow('client-receipt', OPCO, '3000', 'income', CLIENT),
  flow('groceries', OWNER, '-50', 'consumption', null),
  flow('software', SERVICES, '-100', 'consumption', null),
];

const totalsOf = (r: ConsolidationResult) => Object.fromEntries(r.totals.map((t) => [t.currency, [t.inflows.amount, t.outflows.amount, t.net.amount]]));

describe('consolidateFlows', () => {
  it('never double counts salary, intercompany invoices or personal transfers in the combined picture', () => {
    const combined = consolidateFlows(flows, ALL, entities);
    expect(combined.kept.map((f) => f.id)).toEqual(['client-receipt', 'groceries', 'software']);
    expect(totalsOf(combined)).toEqual({ USD: ['3000', '-150', '2850'] });
    expect(combined.eliminated.map((e) => [e.flow.id, e.reason, e.counterpartFlowIds])).toEqual([
      ['inv-opco', 'intercompany', ['inv-services']],
      ['inv-services', 'intercompany', ['inv-opco']],
      ['sal-opco', 'salary', ['sal-owner']],
      ['sal-owner', 'salary', ['sal-opco']],
      ['xfer-opco', 'personal_business_transfer', ['xfer-owner']],
      ['xfer-owner', 'personal_business_transfer', ['xfer-opco']],
    ]);
    expect(combined.byNature.map((n) => n.nature)).toEqual(['consumption', 'income']);
    expect(combined.warnings).toEqual([]);
    expect(combined.eliminatedByReason).toEqual([
      { reason: 'intercompany', currency: 'USD', inflows: money('1000', 'USD'), outflows: money('-1000', 'USD') },
      { reason: 'personal_business_transfer', currency: 'USD', inflows: money('200', 'USD'), outflows: money('-200', 'USD') },
      { reason: 'salary', currency: 'USD', inflows: money('500', 'USD'), outflows: money('-500', 'USD') },
    ]);
    expect(combined.scope).toEqual(ALL);
    expect(combined.explanation.items.filter((i) => i.role === 'excluded')).toHaveLength(6);
    const view = toConsolidatedEliminations(combined);
    expect(view).toHaveLength(6);
    expect(ConsolidatedView.shape.eliminated.parse(view)).toEqual(view);
    expect(view[0]!.label).toBe('Intercompany invoices and payments: inv-opco');
    expect(view[0]!.links).toEqual([{ kind: 'transaction', id: 'inv-opco', label: 'inv-opco' }]);
  });

  it('keeps every cross-entity flow in the entity reports', () => {
    const opco = entityFlowReport(flows, OPCO, entities);
    expect(opco.eliminated).toEqual([]);
    expect(opco.kept.map((f) => f.id).sort()).toEqual(['client-receipt', 'inv-opco', 'sal-opco', 'xfer-opco']);
    expect(totalsOf(opco)).toEqual({ USD: ['3200', '-1500', '1700'] });
    const owner = entityFlowReport(flows, OWNER, entities);
    expect(owner.kept.map((f) => f.id).sort()).toEqual(['groceries', 'sal-owner', 'xfer-owner']);
    expect(owner.byNature.find((n) => n.nature === 'salary')!.total).toEqual(money('500', 'USD'));
    const services = entityFlowReport(flows, SERVICES, entities);
    expect(totalsOf(services)).toEqual({ USD: ['1000', '-100', '900'] });
    // The entity nets add up to the combined net because eliminations net to zero.
    const sum = [opco, owner, services].reduce((acc, r) => acc.plus(dec(r.totals[0]!.net.amount)), dec('0'));
    expect(sum.toFixed()).toBe(consolidateFlows(flows, ALL, entities).totals[0]!.net.amount);
  });

  it('keeps flows with out-of-scope parties when the scope is narrower', () => {
    const ownerAndOpco = consolidateFlows(flows, [OWNER, OPCO], entities);
    expect(ownerAndOpco.kept.map((f) => f.id)).toEqual(['client-receipt', 'groceries', 'inv-opco']);
    expect(ownerAndOpco.eliminated.map((e) => e.flow.id)).toEqual(['sal-opco', 'sal-owner', 'xfer-opco', 'xfer-owner']);
  });

  it('eliminates matched transfers through their pair id and own-account transfers in entity reports', () => {
    const paired = [
      flow('own-out', OWNER, '-300', 'transfer_internal', null, { pairId: 'm1' }),
      flow('own-in', OWNER, '300', 'transfer_internal', null, { pairId: 'm1' }),
      flow('cross-out', OWNER, '-40', 'transfer_internal', null, { pairId: 'm2' }),
      flow('cross-in', SERVICES, '40', 'transfer_internal', null, { pairId: 'm2' }),
      flow('ext-out', OWNER, '-60', 'transfer_external', null, { pairId: 'm3' }),
      flow('ext-in', CLIENT, '60', 'transfer_external', null, { pairId: 'm3' }),
    ];
    const owner = entityFlowReport(paired, OWNER, entities);
    expect(owner.eliminated.map((e) => [e.flow.id, e.reason])).toEqual([
      ['own-in', 'internal_transfer'],
      ['own-out', 'internal_transfer'],
    ]);
    expect(owner.kept.map((f) => f.id)).toEqual(['cross-out', 'ext-out']);
    const combined = consolidateFlows(paired, ALL, entities);
    expect(combined.eliminated.map((e) => [e.flow.id, e.reason, e.counterpartFlowIds])).toEqual([
      ['cross-in', 'personal_business_transfer', ['cross-out']],
      ['cross-out', 'personal_business_transfer', ['cross-in']],
      ['own-in', 'internal_transfer', ['own-out']],
      ['own-out', 'internal_transfer', ['own-in']],
    ]);
    expect(combined.kept.map((f) => f.id)).toEqual(['ext-out']);
    // Two companies: a matched transfer between them is a matched transfer, not a personal one.
    const companies = consolidateFlows(
      [flow('co-out', OPCO, '-10', 'transfer_internal', null, { pairId: 'm4' }), flow('co-in', SERVICES, '10', 'transfer_internal', null, { pairId: 'm4' })],
      ALL,
      entities,
    );
    expect(companies.eliminated.map((e) => e.reason)).toEqual(['matched_transfer', 'matched_transfer']);
  });

  it('warns when eliminated sides do not net to zero', () => {
    const result = consolidateFlows([flow('a', OPCO, '-1000', 'intercompany', SERVICES), flow('b', SERVICES, '990', 'intercompany', OPCO)], ALL, entities);
    expect(result.eliminated).toHaveLength(2);
    expect(result.eliminated[0]!.counterpartFlowIds).toEqual([]);
    expect(result.warnings).toEqual([`Eliminated flows between ${OPCO} and ${SERVICES} do not net to zero in USD (-10); check timing or missing records`]);
    expect(result.explanation.assumptions).toEqual(result.warnings);
    expect(() => consolidateFlows([flow('a', OPCO, '1', 'income', null), flow('a', OPCO, '1', 'income', null)], ALL)).toThrow(/Duplicate/);
  });
});

describe('flowsFromJournalEntries', () => {
  const chartAccounts: LedgerAccount[] = [
    { id: 'o-bank', entityId: OWNER, name: 'Owner bank', type: 'asset', subtype: 'bank', currency: 'USD', systemRole: null },
    { id: 'o-savings', entityId: OWNER, name: 'Owner savings', type: 'asset', subtype: 'bank', currency: 'USD', systemRole: null },
    { id: 'o-due', entityId: OWNER, name: 'Due from companies', type: 'asset', subtype: null, currency: null, systemRole: 'intercompany_due' },
    { id: 'o-obe', entityId: OWNER, name: 'Opening equity', type: 'equity', subtype: null, currency: null, systemRole: 'opening_balance_equity' },
    { id: 'o-salary', entityId: OWNER, name: 'Salary', type: 'income', subtype: null, currency: null, systemRole: null },
    { id: 'o-spend', entityId: OWNER, name: 'Spending', type: 'expense', subtype: null, currency: null, systemRole: null },
    { id: 'o-dining', entityId: OWNER, name: 'Dining', type: 'expense', subtype: null, currency: null, systemRole: null },
    { id: 'c-bank', entityId: OPCO, name: 'Company bank', type: 'asset', subtype: 'bank', currency: 'USD', systemRole: null },
    { id: 'c-due', entityId: OPCO, name: 'Due to owner', type: 'liability', subtype: null, currency: null, systemRole: 'intercompany_due' },
    { id: 'c-payroll', entityId: OPCO, name: 'Payroll', type: 'expense', subtype: null, currency: null, systemRole: null },
    { id: 'c-services', entityId: OPCO, name: 'Services bought', type: 'expense', subtype: null, currency: null, systemRole: null },
    { id: 'c-sales', entityId: OPCO, name: 'Sales', type: 'income', subtype: null, currency: null, systemRole: null },
    { id: 's-bank', entityId: SERVICES, name: 'Services bank', type: 'asset', subtype: 'bank', currency: 'USD', systemRole: null },
    { id: 's-revenue', entityId: SERVICES, name: 'Revenue', type: 'income', subtype: null, currency: null, systemRole: null },
  ];
  const chart = chartOf(chartAccounts);
  const day = '2026-07-10';
  const usd = (a: string) => money(a, 'USD');
  const ie = (id: string, direction: 'income' | 'expense', entityId: string, cash: string, pnl: string, amount: string, nature: Parameters<typeof buildIncomeExpenseEntry>[0]['nature'], cp: string | null) =>
    buildIncomeExpenseEntry({ id, effectiveDate: day, description: id, direction, entityId, cashLedgerAccountId: cash, pnlLedgerAccountId: pnl, amount: usd(amount), nature, counterpartyEntityId: cp }, { chart });
  const entries = [
    buildOpeningBalanceEntry({ id: 'open', effectiveDate: '2026-07-01', description: 'Opening', entityId: OWNER, ledgerAccountId: 'o-bank', openingBalanceEquityLedgerAccountId: 'o-obe', balance: usd('5000'), basis: 'statement_opening' }, { chart }),
    ie('salary-paid', 'expense', OPCO, 'c-bank', 'c-payroll', '2500', 'salary', OWNER),
    ie('salary-received', 'income', OWNER, 'o-bank', 'o-salary', '2500', 'salary', OPCO),
    ie('invoice-paid', 'expense', OPCO, 'c-bank', 'c-services', '800', 'intercompany', SERVICES),
    ie('invoice-received', 'income', SERVICES, 's-bank', 's-revenue', '800', 'intercompany', OPCO),
    ie('client-sale', 'income', OPCO, 'c-bank', 'c-sales', '9000', 'income', null),
    buildTransferEntry({ id: 'owner-funds-opco', effectiveDate: day, description: 'Owner loan', amount: usd('1200'), from: { entityId: OWNER, ledgerAccountId: 'o-bank' }, to: { entityId: OPCO, ledgerAccountId: 'c-bank' }, intercompany: { fromDueLedgerAccountId: 'o-due', toDueLedgerAccountId: 'c-due' }, nature: 'owner_contribution' }, { chart }),
    buildTransferEntry({ id: 'to-savings', effectiveDate: day, description: 'To savings', amount: usd('700'), from: { entityId: OWNER, ledgerAccountId: 'o-bank' }, to: { entityId: OWNER, ledgerAccountId: 'o-savings' } }, { chart }),
    buildSplitEntry(
      { id: 'split-dinner', effectiveDate: day, description: 'Dinner', entityId: OWNER, direction: 'expense', cashLedgerAccountId: 'o-bank', total: usd('90'), parts: [{ ledgerAccountId: 'o-spend', share: { kind: 'weight', weight: '1' } }, { ledgerAccountId: 'o-dining', share: { kind: 'weight', weight: '2' } }] },
      { chart },
    ),
  ];
  const mistake = ie('mistake', 'expense', OWNER, 'o-bank', 'o-spend', '66', 'consumption', null);
  const { original: mistakeReversed, reversal } = reverseEntry(mistake, { id: 'mistake-rev', effectiveDate: day, reason: 'Entered twice' }, { chart });
  const all = [...entries, mistakeReversed, reversal];

  it('extracts P&L flows that consolidate without double counting', () => {
    const pnl = flowsFromJournalEntries(all, chart, { basis: 'pnl' });
    expect(pnl.every((f) => f.pairId === null)).toBe(true);
    expect(pnl.some((f) => f.id.startsWith('mistake'))).toBe(false);
    expect(pnl.some((f) => f.id.startsWith('open'))).toBe(false);
    const combined = consolidateFlows(pnl, ALL, entities);
    expect(totalsOf(combined)).toEqual({ USD: ['9000', '-90', '8910'] });
    expect(combined.eliminated.map((e) => e.reason).sort()).toEqual(['intercompany', 'intercompany', 'salary', 'salary']);
    // Split parts in one entry are not internal transfers.
    expect(entityFlowReport(pnl, OWNER, entities).kept.map((f) => f.id)).toEqual(['salary-received#1', 'split-dinner#1', 'split-dinner#2']);
    expect(totalsOf(entityFlowReport(pnl, OPCO, entities))).toEqual({ USD: ['9000', '-3300', '5700'] });
  });

  it('extracts cash flows where own-account and in-scope transfers net out', () => {
    const cash = flowsFromJournalEntries(all, chart, { basis: 'cash' });
    const combined = consolidateFlows(cash, ALL, entities);
    expect(totalsOf(combined)).toEqual({ USD: ['9000', '-90', '8910'] });
    expect(combined.warnings).toEqual([]);
    const owner = entityFlowReport(cash, OWNER, entities);
    expect(owner.eliminated.map((e) => [e.flow.id, e.reason])).toEqual([
      ['to-savings#0', 'internal_transfer'],
      ['to-savings#1', 'internal_transfer'],
    ]);
    expect(totalsOf(owner)).toEqual({ USD: ['2500', '-1290', '1210'] });
    const opco = entityFlowReport(cash, OPCO, entities);
    expect(opco.kept.find((f) => f.id === 'owner-funds-opco#2')).toMatchObject({ counterpartyEntityId: OWNER, amount: usd('1200'), nature: 'owner_contribution' });
    expect(flowsFromJournalEntries(all, chart, { basis: 'cash', from: '2026-07-11' })).toEqual([]);
    expect(() => flowsFromJournalEntries(all, chartOf(chartAccounts.slice(1)), { basis: 'cash' })).toThrow(/Unknown ledger account/);
  });
});
