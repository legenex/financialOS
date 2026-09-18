import { WealthSummary, type Money } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { uuid } from './test-support';
import { attributableThirdPartyBalance } from './thirdParty';
import type { EntityInfo, ValueInput } from './types';
import { computeWealth, computeWealthDetailed, SEGMENT_ORDER, WealthError, type OwnershipInterest, type WealthAccount, type WealthInput, type WealthScope } from './wealth';

const OWNER = uuid(1);
const COMPANY = uuid(2);
const THIRD_PARTY = uuid(3);
const OUTSIDE = uuid(4);

const ENTITIES: EntityInfo[] = [
  { id: OWNER, name: 'Example Owner', kind: 'person', ownerControlled: true, primaryOwner: true },
  { id: COMPANY, name: 'Example Holdings Ltd', kind: 'company', ownerControlled: true, primaryOwner: false },
  { id: THIRD_PARTY, name: 'Third Party A', kind: 'third_party', ownerControlled: false, primaryOwner: false },
  { id: OUTSIDE, name: 'Sample Consulting LLC', kind: 'company', ownerControlled: false, primaryOwner: false },
];

const FX = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18', asOf: '2026-03-08', source: 'test' }]);
const ASOF = '2026-03-10';

const zar = (amount: string): Money => ({ amount, currency: 'ZAR' });

function val(amount: string | null, currency: string | null = 'ZAR', extra: Partial<ValueInput> = {}): ValueInput {
  return { value: { amount, currency }, asOf: ASOF, approximate: false, completeness: 'complete', ...extra };
}

function acct(overrides: Partial<WealthAccount> & { id: string; name: string }): WealthAccount {
  return {
    kind: 'current',
    legalEntityId: OWNER,
    economicOwnerEntityId: OWNER,
    ownershipConfirmed: true,
    liquidityClass: 'cash',
    status: 'active',
    valuation: val('0'),
    ...overrides,
  };
}

function wealth(accounts: WealthAccount[], overrides: Partial<WealthInput> = {}): WealthInput {
  return { scope: { kind: 'personal' }, entities: ENTITIES, accounts, reportingCurrency: 'ZAR', fx: FX, asOf: ASOF, ...overrides };
}

const segment = (summary: WealthSummary, liquidityClass: string) => summary.segments.find((s) => s.liquidityClass === liquidityClass)!;

const EVERYDAY = acct({ id: uuid(10), name: 'Everyday account', valuation: val('20000') });
const SAVINGS_USD = acct({ id: uuid(11), name: 'Offshore savings', kind: 'savings', liquidityClass: 'near_cash', valuation: val('1000', 'USD') });
const BROKERAGE = acct({ id: uuid(12), name: 'Brokerage account', kind: 'brokerage', liquidityClass: 'marketable', valuation: val('50000') });
const CARD = acct({ id: uuid(13), name: 'Card account', kind: 'credit_card', liquidityClass: 'liability', valuation: val('-6000'), creditLimit: zar('30000') });
const PROPERTY = acct({ id: uuid(14), name: 'Example property', kind: 'property', liquidityClass: 'property', valuation: val('1200000') });
const COMPANY_BANK = acct({
  id: uuid(15),
  name: 'Example Holdings Ltd bank account',
  legalEntityId: COMPANY,
  economicOwnerEntityId: COMPANY,
  valuation: val('200000'),
});
const HELD_FOR_THIRD_PARTY = acct({ id: uuid(16), name: 'Collections account', economicOwnerEntityId: THIRD_PARTY, valuation: val('15000') });

describe('segmentation by liquidity class', () => {
  const summary = computeWealth(wealth([EVERYDAY, SAVINGS_USD, BROKERAGE, CARD, PROPERTY]));

  it('reports every segment in a fixed order', () => {
    expect(() => WealthSummary.parse(summary)).not.toThrow();
    expect(summary.segments.map((s) => s.liquidityClass)).toEqual([...SEGMENT_ORDER]);
    expect(SEGMENT_ORDER).toEqual(['cash', 'near_cash', 'marketable', 'restricted', 'illiquid', 'property', 'receivable', 'liability', 'contingent']);
  });

  it('puts each account in its own segment, converting as it goes', () => {
    expect(segment(summary, 'cash').total).toEqual(zar('20000'));
    // 1 000 USD at 18
    expect(segment(summary, 'near_cash').total).toEqual(zar('18000'));
    expect(segment(summary, 'marketable').total).toEqual(zar('50000'));
    expect(segment(summary, 'property').total).toEqual(zar('1200000'));
    expect(segment(summary, 'liability').total).toEqual(zar('-6000'));
    expect(segment(summary, 'restricted')).toMatchObject({ total: zar('0'), accountsCounted: 0, accountsUnknown: 0 });
  });

  it('adds the segments (not the contingent one) into net worth', () => {
    // 20 000 + 18 000 + 50 000 + 1 200 000 − 6 000
    expect(summary.netWorthKnown).toEqual(zar('1282000'));
    expect(summary.status).toBe('ok');
    expect(summary.excludedThirdParty).toEqual(zar('0'));
  });

  it('counts a debt account as a liability however it is classified', () => {
    const mislabelled = computeWealth(wealth([EVERYDAY, acct({ id: uuid(20), name: 'Card marked as cash', kind: 'credit_card', liquidityClass: 'cash', valuation: val('-6000') })]));
    expect(segment(mislabelled, 'cash').total).toEqual(zar('20000'));
    expect(segment(mislabelled, 'liability').total).toEqual(zar('-6000'));
    expect(mislabelled.explanation.assumptions).toContain('Card marked as cash is a credit card; counted as a liability, never as cash');
  });

  it('shows contingent items but keeps them out of net worth', () => {
    const summaryWithContingent = computeWealth(wealth([EVERYDAY, acct({ id: uuid(21), name: 'Example guarantee', liquidityClass: 'contingent', valuation: val('99999') })]));
    expect(segment(summaryWithContingent, 'contingent').total).toEqual(zar('99999'));
    expect(summaryWithContingent.netWorthKnown).toEqual(zar('20000'));
    expect(summaryWithContingent.explanation.assumptions).toContain('Contingent items are shown separately and are not part of net worth');
  });

  it('ignores closed accounts', () => {
    const closed = computeWealthDetailed(wealth([EVERYDAY, acct({ id: uuid(22), name: 'Closed account', status: 'closed', valuation: val('900000') })]));
    expect(closed.summary.netWorthKnown).toEqual(zar('20000'));
    expect(closed.decisions.find((d) => d.subjectId === uuid(22))).toMatchObject({ included: false, reason: 'Account is closed' });
  });

  it('matches the summary returned by the detailed computation', () => {
    expect(computeWealth(wealth([EVERYDAY, CARD]))).toEqual(computeWealthDetailed(wealth([EVERYDAY, CARD])).summary);
  });
});

describe('personal scope', () => {
  it('never counts company assets as personal', () => {
    const detailed = computeWealthDetailed(wealth([EVERYDAY, COMPANY_BANK]));
    expect(detailed.summary.netWorthKnown).toEqual(zar('20000'));
    expect(detailed.summary.entityIds).toEqual([OWNER]);
    expect(detailed.decisions.find((d) => d.subjectId === COMPANY_BANK.id)).toMatchObject({
      included: false,
      reason: 'Not owned by the primary owner (company assets are never personal)',
    });
  });

  it('refuses a company-held account whose personal ownership is unconfirmed', () => {
    const account = acct({ id: uuid(30), name: 'Company-held current account', legalEntityId: COMPANY, economicOwnerEntityId: OWNER, ownershipConfirmed: false, valuation: val('80000') });
    const detailed = computeWealthDetailed(wealth([EVERYDAY, account]));
    expect(detailed.summary.netWorthKnown).toEqual(zar('20000'));
    expect(detailed.summary.status).toBe('provisional');
    expect(detailed.decisions.find((d) => d.subjectId === uuid(30))!.reason).toBe('Company-held account without confirmed personal ownership');
    expect(detailed.summary.explanation.missing).toContain('Company-held current account: held by a company; personal ownership is unconfirmed, so it is not counted');
  });

  it('counts a verified ownership interest in a company as an illiquid personal asset', () => {
    const interest: OwnershipInterest = { id: uuid(40), label: 'Shares in Example Holdings Ltd', holderEntityId: OWNER, heldEntityId: COMPANY, value: zar('500000'), verified: true };
    const summary = computeWealth(wealth([EVERYDAY, COMPANY_BANK], { ownershipInterests: [interest] }));
    expect(segment(summary, 'illiquid').total).toEqual(zar('500000'));
    expect(summary.netWorthKnown).toEqual(zar('520000'));
  });

  it('never counts an ownership interest with no verified valuation', () => {
    const interest: OwnershipInterest = { id: uuid(41), label: 'Stake in Sample Consulting LLC', holderEntityId: OWNER, heldEntityId: OUTSIDE, value: zar('500000'), verified: false };
    const detailed = computeWealthDetailed(wealth([EVERYDAY], { ownershipInterests: [interest] }));
    expect(detailed.summary.netWorthKnown).toEqual(zar('20000'));
    expect(segment(detailed.summary, 'illiquid')).toMatchObject({ total: null, accountsUnknown: 1 });
    expect(detailed.summary.status).toBe('provisional');
    expect(detailed.decisions.find((d) => d.subjectId === uuid(41))!.reason).toBe('No verified valuation');
  });

  it('never counts an unverified equity-stake account', () => {
    const stake = acct({ id: uuid(42), name: 'Stake in Sample Consulting LLC', liquidityClass: 'illiquid', representsEntityId: OUTSIDE, valuationVerified: false, valuation: val('300000') });
    const detailed = computeWealthDetailed(wealth([EVERYDAY, stake]));
    expect(detailed.summary.netWorthKnown).toEqual(zar('20000'));
    expect(detailed.decisions.find((d) => d.subjectId === uuid(42))!.reason).toBe('Ownership value unverified');
    const verified = computeWealth(wealth([EVERYDAY, { ...stake, valuationVerified: true }]));
    expect(verified.netWorthKnown).toEqual(zar('320000'));
  });
});

describe('consolidated scope', () => {
  const consolidated: WealthScope = { kind: 'consolidated' };
  const interest: OwnershipInterest = { id: uuid(40), label: 'Shares in Example Holdings Ltd', holderEntityId: OWNER, heldEntityId: COMPANY, value: zar('500000'), verified: true };

  it('includes company assets and excludes the ownership value of an included entity', () => {
    const detailed = computeWealthDetailed(wealth([EVERYDAY, COMPANY_BANK], { scope: consolidated, ownershipInterests: [interest] }));
    expect(detailed.summary.entityIds).toEqual([OWNER, COMPANY].sort());
    expect(segment(detailed.summary, 'cash').total).toEqual(zar('220000'));
    expect(segment(detailed.summary, 'illiquid').total).toEqual(zar('0'));
    expect(detailed.summary.netWorthKnown).toEqual(zar('220000'));
    expect(detailed.decisions.find((d) => d.subjectId === uuid(40))!.reason).toBe('Ownership value of an included entity (never counted with its assets)');
  });

  it('keeps an ownership interest in an entity outside the scope', () => {
    const outside: OwnershipInterest = { id: uuid(43), label: 'Stake in Sample Consulting LLC', holderEntityId: OWNER, heldEntityId: OUTSIDE, value: zar('100000'), verified: true };
    const summary = computeWealth(wealth([EVERYDAY], { scope: consolidated, ownershipInterests: [outside] }));
    expect(segment(summary, 'illiquid').total).toEqual(zar('100000'));
  });

  it('excludes an equity-stake account for an included entity rather than double counting it', () => {
    const stake = acct({ id: uuid(44), name: 'Shares in Example Holdings Ltd', liquidityClass: 'illiquid', representsEntityId: COMPANY, valuationVerified: true, valuation: val('500000') });
    const detailed = computeWealthDetailed(wealth([EVERYDAY, COMPANY_BANK, stake], { scope: consolidated }));
    expect(detailed.summary.netWorthKnown).toEqual(zar('220000'));
    expect(detailed.decisions.find((d) => d.subjectId === uuid(44))!.reason).toBe('Ownership value of an included entity (never counted with its assets)');
  });

  it('eliminates a balance with an entity inside the scope, and keeps it outside', () => {
    const receivable = acct({ id: uuid(45), name: 'Loan to Example Holdings Ltd', liquidityClass: 'receivable', counterpartyEntityId: COMPANY, valuation: val('40000') });
    const inScope = computeWealthDetailed(wealth([EVERYDAY, COMPANY_BANK, receivable], { scope: consolidated }));
    expect(segment(inScope.summary, 'receivable').total).toEqual(zar('0'));
    expect(inScope.decisions.find((d) => d.subjectId === uuid(45))!.reason).toBe('Intercompany balance eliminated in the consolidated view');
    expect(inScope.summary.netWorthKnown).toEqual(zar('220000'));

    const personal = computeWealth(wealth([EVERYDAY, receivable]));
    expect(segment(personal, 'receivable').total).toEqual(zar('40000'));
  });
});

describe('entity scope and guards', () => {
  it('reports one entity on its own', () => {
    const summary = computeWealth(wealth([EVERYDAY, COMPANY_BANK], { scope: { kind: 'entity', entityId: COMPANY } }));
    expect(summary.scope).toBe('entity');
    expect(summary.entityIds).toEqual([COMPANY]);
    expect(summary.netWorthKnown).toEqual(zar('200000'));
  });

  it('refuses an unknown entity or a broken primary-owner set', () => {
    expect(() => computeWealth(wealth([EVERYDAY], { scope: { kind: 'entity', entityId: uuid(99) } }))).toThrow(WealthError);
    const noPrimary = ENTITIES.map((e) => ({ ...e, primaryOwner: false }));
    expect(() => computeWealth(wealth([EVERYDAY], { entities: noPrimary }))).toThrow(/Expected exactly one primary owner, found 0/);
    const twoPrimaries = ENTITIES.map((e) => (e.id === COMPANY ? { ...e, primaryOwner: true } : e));
    expect(() => computeWealth(wealth([EVERYDAY], { entities: twoPrimaries }))).toThrow(/found 2/);
  });
});

describe('third-party money', () => {
  it('excludes a whole third-party account and reports it separately', () => {
    const thirdParty = attributableThirdPartyBalance(
      [{ id: HELD_FOR_THIRD_PARTY.id, name: HELD_FOR_THIRD_PARTY.name, legalEntityId: OWNER, economicOwnerEntityId: THIRD_PARTY, value: zar('15000') }],
      [],
      { entities: ENTITIES },
    );
    const detailed = computeWealthDetailed(wealth([EVERYDAY, HELD_FOR_THIRD_PARTY], { thirdParty }));
    expect(detailed.summary.netWorthKnown).toEqual(zar('20000'));
    expect(detailed.summary.excludedThirdParty).toEqual(zar('15000'));
    expect(detailed.decisions.find((d) => d.subjectId === HELD_FOR_THIRD_PARTY.id)).toMatchObject({
      included: false,
      reason: 'Belongs to a third party; reported separately',
    });
    expect(detailed.summary.explanation.items.some((i) => i.role === 'excluded' && i.label === 'Collections account')).toBe(true);
  });

  it('deducts a clearing balance held inside an owner account from that account segment', () => {
    const thirdParty = attributableThirdPartyBalance(
      [{ id: EVERYDAY.id, name: EVERYDAY.name, legalEntityId: OWNER, economicOwnerEntityId: OWNER, value: zar('20000') }],
      [{ arrangementId: uuid(50), thirdPartyEntityId: THIRD_PARTY, thirdPartyName: 'Third Party A', holderEntityId: OWNER, holdingAccountId: EVERYDAY.id, amountOwed: zar('5000') }],
      { entities: ENTITIES },
    );
    const summary = computeWealth(wealth([EVERYDAY], { thirdParty }));
    expect(segment(summary, 'cash').total).toEqual(zar('15000'));
    expect(summary.netWorthKnown).toEqual(zar('15000'));
    expect(summary.excludedThirdParty).toEqual(zar('5000'));
  });

  it('cannot deduct a clearing balance when the holding balance itself is unknown', () => {
    const unknownAccount = acct({ id: uuid(51), name: 'Unknown-balance account', valuation: val(null, null) });
    const thirdParty = attributableThirdPartyBalance(
      [{ id: unknownAccount.id, name: unknownAccount.name, legalEntityId: OWNER, economicOwnerEntityId: OWNER, value: null }],
      [{ arrangementId: uuid(52), thirdPartyEntityId: THIRD_PARTY, thirdPartyName: 'Third Party A', holderEntityId: OWNER, holdingAccountId: unknownAccount.id, amountOwed: zar('5000') }],
      { entities: ENTITIES },
    );
    const summary = computeWealth(wealth([unknownAccount], { thirdParty }));
    expect(summary.explanation.missing.some((m) => m.includes('the holding balance is unknown, so the third-party share cannot be deducted'))).toBe(true);
    expect(summary.status).toBe('insufficient_data');
  });

  it('reports an unknown third-party amount as unknown, not zero', () => {
    const thirdParty = attributableThirdPartyBalance(
      [{ id: uuid(53), name: 'Collections account', legalEntityId: OWNER, economicOwnerEntityId: THIRD_PARTY, value: null }],
      [],
      { entities: ENTITIES },
    );
    const summary = computeWealth(wealth([EVERYDAY, acct({ id: uuid(53), name: 'Collections account', economicOwnerEntityId: THIRD_PARTY, valuation: val(null, null) })], { thirdParty }));
    expect(summary.excludedThirdParty).toBeNull();
    expect(summary.status).toBe('provisional');
  });

  it('does not report third-party money held outside the scope', () => {
    const outsideAccount = acct({ id: uuid(54), name: 'Outside collections account', legalEntityId: OUTSIDE, economicOwnerEntityId: THIRD_PARTY, valuation: val('15000') });
    const detailed = computeWealthDetailed(wealth([EVERYDAY, outsideAccount]));
    expect(detailed.summary.excludedThirdParty).toEqual(zar('0'));
    expect(detailed.decisions.find((d) => d.subjectId === uuid(54))!.reason).toBe('Belongs to a third party and is not held by an entity in scope');
  });
});

describe('credit limits and buying power', () => {
  it('never counts them as cash, and says so', () => {
    const broker = { ...BROKERAGE, buyingPower: zar('100000') };
    const summary = computeWealth(wealth([EVERYDAY, CARD, broker]));
    expect(segment(summary, 'cash').total).toEqual(zar('20000'));
    // 20 000 + 50 000 − 6 000; the 30 000 limit and the 100 000 buying power are not in it
    expect(summary.netWorthKnown).toEqual(zar('64000'));
    const excluded = summary.explanation.items.filter((i) => i.role === 'excluded');
    expect(excluded.find((i) => i.label === 'Card account: credit limit')).toMatchObject({ value: zar('30000'), note: 'A credit limit is not cash and never counted' });
    expect(excluded.find((i) => i.label === 'Brokerage account: buying power')).toMatchObject({ value: zar('100000'), note: 'Broker buying power is not cash and never counted' });
  });
});

describe('unknown values, missing rates and provisional status', () => {
  it('counts an unknown valuation as unknown rather than zero', () => {
    const unknown = acct({ id: uuid(60), name: 'Unvalued wallet', kind: 'crypto_wallet', liquidityClass: 'marketable', valuation: val(null, null) });
    const detailed = computeWealthDetailed(wealth([EVERYDAY, BROKERAGE, unknown]));
    expect(segment(detailed.summary, 'marketable')).toMatchObject({ total: zar('50000'), accountsCounted: 1, accountsUnknown: 1 });
    expect(detailed.summary.netWorthKnown).toEqual(zar('70000'));
    expect(detailed.summary.status).toBe('provisional');
    expect(detailed.decisions.find((d) => d.subjectId === uuid(60))!.reason).toBe('Included with unknown value');
    expect(detailed.summary.explanation.missing).toContain('Unvalued wallet: value unknown');
  });

  it('gives a segment no total at all when every account in it is unknown', () => {
    const unknown = acct({ id: uuid(61), name: 'Unvalued wallet', liquidityClass: 'marketable', valuation: val(null, null) });
    const summary = computeWealth(wealth([EVERYDAY, unknown]));
    expect(segment(summary, 'marketable')).toMatchObject({ total: null, accountsCounted: 0, accountsUnknown: 1 });
  });

  it('counts a value it cannot convert as unconverted and leaves it out of the total', () => {
    const gbp = acct({ id: uuid(62), name: 'Sterling account', valuation: val('500', 'GBP') });
    const summary = computeWealth(wealth([EVERYDAY, gbp]));
    expect(segment(summary, 'cash')).toMatchObject({ total: zar('20000'), accountsCounted: 1, unconvertedCount: 1 });
    expect(summary.netWorthKnown).toEqual(zar('20000'));
    expect(summary.status).toBe('provisional');
    expect(summary.explanation.missing.some((m) => m.startsWith('Sterling account: No GBP→ZAR rate'))).toBe(true);
  });

  it('is provisional when a valuation is only partial, and notes an approximate one', () => {
    const partial = computeWealth(wealth([acct({ id: uuid(63), name: 'Partly valued account', valuation: val('1000', 'ZAR', { completeness: 'partial' }) })]));
    expect(partial.status).toBe('provisional');
    expect(partial.explanation.missing).toContain('Partly valued account: valuation is partial');

    const approximate = computeWealth(wealth([acct({ id: uuid(64), name: 'Approximate account', valuation: val('1000', 'ZAR', { approximate: true }) })]));
    expect(approximate.status).toBe('ok');
    expect(approximate.explanation.assumptions).toContain('Approximate account: value is approximate');
  });

  it('marks an account with no known economic owner as missing, and does not count it', () => {
    const unowned = acct({ id: uuid(65), name: 'Unassigned account', economicOwnerEntityId: null, valuation: val('9000') });
    const detailed = computeWealthDetailed(wealth([EVERYDAY, unowned]));
    expect(detailed.summary.netWorthKnown).toEqual(zar('20000'));
    expect(detailed.summary.status).toBe('provisional');
    expect(detailed.decisions.find((d) => d.subjectId === uuid(65))!.reason).toBe('Economic owner unknown');
    expect(detailed.summary.explanation.missing).toContain('Unassigned account: economic owner unknown, not counted');
  });

  it('reports insufficient data, and no net worth, when nothing is known', () => {
    const summary = computeWealth(wealth([acct({ id: uuid(66), name: 'Unvalued account', valuation: val(null, null) })]));
    expect(summary.status).toBe('insufficient_data');
    expect(summary.netWorthKnown).toBeNull();
    expect(summary.explanation.summary).toBe('Not enough known values for the personal scope');
    expect(computeWealth(wealth([])).status).toBe('insufficient_data');
  });

  it('says ok only when nothing at all is unknown', () => {
    expect(computeWealth(wealth([EVERYDAY, SAVINGS_USD, BROKERAGE, CARD, PROPERTY])).status).toBe('ok');
    expect(computeWealth(wealth([EVERYDAY, acct({ id: uuid(67), name: 'Unvalued account', valuation: val(null, null) })])).status).toBe('provisional');
    expect(computeWealth(wealth([EVERYDAY, acct({ id: uuid(68), name: 'Sterling account', valuation: val('1', 'GBP') })])).status).toBe('provisional');
  });

  it('is deterministic whatever order the accounts arrive in', () => {
    const forward = computeWealth(wealth([EVERYDAY, SAVINGS_USD, BROKERAGE, CARD, PROPERTY]));
    const reversed = computeWealth(wealth([PROPERTY, CARD, BROKERAGE, SAVINGS_USD, EVERYDAY]));
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});
