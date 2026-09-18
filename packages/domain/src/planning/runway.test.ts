import { RunwayResult } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { computeRunway, depletionDateAfter, runway, type RunwayFlow, type RunwayInput } from './runway';
import { dec } from '../money';
import { account, COMPANY_ID, ENTITIES, OWNER_ID, THIRD_PARTY_ID, uid, usd, zar } from './testing';

const CURRENT = uid(100);
const CARD = uid(101);
const NOTICE = uid(102);
const SHARES = uid(103);
const BIZ = uid(104);
const BROKER = uid(105);

let seq = 0;
function tx(date: string, amount: string, nature: RunwayFlow['nature'], extra: Partial<RunwayFlow> = {}): RunwayFlow {
  seq += 1;
  return { id: `f${seq}`, accountId: CURRENT, date, amount: zar(amount), nature, ...extra };
}

function months(list: string[], build: (month: string) => RunwayFlow[]): RunwayFlow[] {
  return list.flatMap(build);
}

const Q1 = ['2026-01', '2026-02', '2026-03'];

function personal(overrides: Partial<RunwayInput> = {}): RunwayInput {
  return {
    scope: { kind: 'personal', entityId: null, label: 'Personal' },
    scopeEntityIds: [OWNER_ID],
    asOf: '2026-04-15',
    currency: 'ZAR',
    entities: ENTITIES,
    accounts: [
      account({ id: CURRENT, name: 'Current account', balance: zar('30000') }),
      account({ id: CARD, name: 'Credit card', kind: 'credit_card', liquidityClass: 'liability', balance: zar('-1500') }),
      account({ id: NOTICE, name: 'Notice savings', kind: 'savings', liquidityClass: 'near_cash', balance: zar('12000') }),
      account({ id: SHARES, name: 'Locked shares', kind: 'restricted_equity', liquidityClass: 'restricted', balance: usd('500000') }),
      account({ id: BROKER, name: 'Brokerage', kind: 'brokerage', liquidityClass: 'marketable', balance: zar('90000') }),
      account({ id: BIZ, name: 'Example Holdings operating', legalEntityId: COMPANY_ID, economicOwnerEntityId: COMPANY_ID, balance: zar('800000') }),
    ],
    includeNearCash: false,
    flows: months(Q1, (m) => [
      tx(`${m}-25`, '25000', 'salary', { counterpartyEntityId: COMPANY_ID }),
      tx(`${m}-01`, '-20000', 'consumption'),
      tx(`${m}-10`, '-5000', 'transfer_internal', { counterpartyEntityId: OWNER_ID }),
      tx(`${m}-11`, '-8000', 'investment_contribution'),
      tx(`${m}-12`, '-2000', 'consumption', { accountId: CARD }),
      tx(`${m}-13`, '-10000', 'business_support', { counterpartyEntityId: COMPANY_ID }),
      tx(`${m}-14`, '-3000', 'third_party'),
      tx(`${m}-15`, '999', 'dividend', { accountId: BROKER }),
    ]),
    historyStart: '2026-01-01',
    minimumHistoryMonths: 3,
    fx: new FxTable(),
    ...overrides,
  };
}

describe('runway', () => {
  it('computes months from trailing complete months, excluding internal movements', () => {
    const computation = computeRunway(personal());
    const result = computation.result;
    expect(() => RunwayResult.parse(result)).not.toThrow();
    // Net outflow per month: 20000 + 2000 + 10000 − 25000 = 7000.
    expect(result.status).toBe('finite');
    expect(result.historyMonths).toBe(3);
    expect(result.liquidBalance).toEqual(zar('30000'));
    expect(result.averageMonthlyNetOutflow).toEqual(zar('7000'));
    expect(result.months).toBe('4.28');
    expect(result.depletionDate).toBe('2026-08-23');
    expect(computation.months.map((m) => m.netOutflow.amount)).toEqual(['7000', '7000', '7000']);
    expect(computation.excludedFlows.map((e) => [e.nature, e.count, e.total.amount])).toEqual([
      ['investment_contribution', 3, '24000'],
      ['third_party', 3, '9000'],
      ['transfer_internal', 3, '15000'],
    ]);
    const support = result.explanation.items.find((i) => i.label.startsWith('Business support'));
    expect(support?.value).toEqual(zar('10000'));
    expect(support?.note).toBe('Without it the average monthly net outflow would be -3000');
  });

  it('never counts restricted, marketable or business balances', () => {
    const result = runway(personal());
    const excluded = result.explanation.items.filter((i) => i.role === 'excluded').map((i) => [i.label, i.note]);
    expect(excluded).toContainEqual(['Locked shares', 'Restricted asset: never counted in runway']);
    expect(excluded).toContainEqual(['Brokerage', 'Not liquid cash (marketable)']);
    expect(excluded).toContainEqual(['Notice savings', 'Near-cash excluded by setting']);
    expect(JSON.stringify(result.explanation)).not.toContain('Example Holdings operating');
    expect(runway(personal({ includeNearCash: true })).liquidBalance).toEqual(zar('42000'));
  });

  it('subtracts third-party money held in scope accounts', () => {
    const result = runway(personal({ thirdPartyHoldings: [{ accountId: CURRENT, arrangementId: uid(9), label: 'Held for Sample Third Party', amount: zar('9000') }] }));
    expect(result.liquidBalance).toEqual(zar('21000'));
    expect(result.months).toBe('3');
  });

  it('reports not_depleting when money in covers money out', () => {
    const result = runway(personal({ flows: months(Q1, (m) => [tx(`${m}-25`, '25000', 'salary'), tx(`${m}-02`, '-12000', 'consumption')]) }));
    expect(result.status).toBe('not_depleting');
    expect(result.months).toBeNull();
    expect(result.depletionDate).toBeNull();
    expect(result.averageMonthlyNetOutflow).toEqual(zar('-13000'));
    expect(result.explanation.summary).toContain('not depleting');
  });

  it('treats exactly zero net outflow as not depleting', () => {
    const result = runway(personal({ flows: months(Q1, (m) => [tx(`${m}-25`, '100', 'income'), tx(`${m}-02`, '-100', 'consumption')]) }));
    expect(result.status).toBe('not_depleting');
  });

  it('reports insufficient_history below the minimum', () => {
    const result = runway(personal({ historyStart: '2026-02-03' }));
    expect(result.status).toBe('insufficient_history');
    expect(result.historyMonths).toBe(1);
    expect(result.months).toBeNull();
    expect(result.liquidBalance).toEqual(zar('30000'));
    expect(result.explanation.missing).toContain('Only 1 complete month of history; at least 3 are needed');
  });

  it('uses explicit covered months and the trailing window', () => {
    const flows = months(['2025-10', '2025-11', '2025-12', ...Q1], (m) => [tx(`${m}-02`, m < '2026-01' ? '-1000' : '-3000', 'consumption')]);
    const result = computeRunway(personal({ flows, coveredMonths: ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04'], trailingMonths: 3 }));
    expect(result.months.map((m) => m.month)).toEqual(Q1);
    expect(result.result.averageMonthlyNetOutflow).toEqual(zar('3000'));
    expect(result.result.months).toBe('10');
  });

  it('assumes coverage from the first flow when no coverage is given', () => {
    const result = runway(personal({ historyStart: null }));
    expect(result.status).toBe('finite');
    expect(result.explanation.assumptions).toContain('History is assumed to be complete from the first recorded flow on 2026-01-01');
    const empty = runway(personal({ historyStart: null, flows: [] }));
    expect(empty.status).toBe('insufficient_history');
    expect(empty.historyMonths).toBe(0);
  });

  it('is insufficient_data when a liquid balance is unknown', () => {
    const accounts = personal().accounts.map((a) => (a.id === CURRENT ? { ...a, balance: null } : a));
    const result = runway(personal({ accounts }));
    expect(result.status).toBe('insufficient_data');
    expect(result.liquidBalance).toBeNull();
    expect(result.months).toBeNull();
    expect(runway(personal({ accounts: [] })).status).toBe('insufficient_data');
  });

  it('ignores reversed flows and flows on non-liquid accounts', () => {
    const base = personal().flows;
    const result = runway(personal({ flows: [...base, tx('2026-02-05', '-99999', 'consumption', { status: 'reversed' }), tx('2026-02-06', '-99999', 'consumption', { accountId: BROKER })] }));
    expect(result.averageMonthlyNetOutflow).toEqual(zar('7000'));
  });

  it('converts foreign flows at their own dates and lists unconvertible ones', () => {
    const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '20', asOf: '2026-01-01', source: 'test' }]);
    const flows = [...personal().flows, { id: 'usd', accountId: CURRENT, date: '2026-01-05', amount: usd('-150'), nature: 'consumption' as const }];
    const result = computeRunway(personal({ flows, fx }));
    expect(result.months[0]?.outflows).toEqual(zar('35000'));
    const missing = runway(personal({ flows }));
    expect(missing.explanation.missing).toContain('1 flows could not be converted to ZAR and were left out of the average');
  });

  it('counts unclassified flows and says so', () => {
    const result = runway(personal({ flows: [...personal().flows, tx('2026-03-20', '-300', 'unknown')] }));
    expect(result.averageMonthlyNetOutflow).toEqual(zar('7100'));
    expect(result.explanation.assumptions).toContain('1 unclassified flows were counted as operating cash flow');
  });

  it('gives zero months when the balance is already exhausted', () => {
    const accounts = [account({ id: CURRENT, name: 'Current account', balance: zar('-500') })];
    const result = runway(personal({ accounts }));
    expect(result.status).toBe('finite');
    expect(result.months).toBe('0');
    expect(result.depletionDate).toBe('2026-04-15');
  });
});

describe('runway: entity scope', () => {
  const entityInput = (scopeEntityIds: string[]): RunwayInput => ({
    scope: { kind: 'entity', entityId: COMPANY_ID, label: 'Example Holdings Ltd' },
    scopeEntityIds,
    asOf: '2026-04-15',
    currency: 'ZAR',
    entities: ENTITIES,
    accounts: [
      account({ id: BIZ, name: 'Operating account', legalEntityId: COMPANY_ID, economicOwnerEntityId: COMPANY_ID, balance: zar('60000') }),
      account({ id: uid(106), name: 'Client money', legalEntityId: COMPANY_ID, economicOwnerEntityId: THIRD_PARTY_ID, balance: zar('40000') }),
      account({ id: CURRENT, name: 'Personal current', balance: zar('30000') }),
    ],
    includeNearCash: false,
    flows: months(Q1, (m) => [
      tx(`${m}-05`, '40000', 'income', { accountId: BIZ }),
      tx(`${m}-25`, '-25000', 'salary', { accountId: BIZ, counterpartyEntityId: OWNER_ID }),
      tx(`${m}-26`, '-30000', 'payroll', { accountId: BIZ }),
      tx(`${m}-13`, '10000', 'business_support', { accountId: BIZ, counterpartyEntityId: OWNER_ID }),
      tx(`${m}-14`, '-4000', 'intercompany', { accountId: BIZ, counterpartyEntityId: uid(77) }),
    ]),
    historyStart: '2026-01-01',
    minimumHistoryMonths: 3,
    fx: new FxTable(),
  });

  it('uses only the entity’s own cash and counts salary to the owner as an outflow', () => {
    const result = runway(entityInput([COMPANY_ID]));
    expect(result.liquidBalance).toEqual(zar('60000'));
    // 25000 + 30000 + 4000 − 40000 − 10000 support = 9000.
    expect(result.averageMonthlyNetOutflow).toEqual(zar('9000'));
    expect(result.months).toBe('6.66');
    expect(result.explanation.items.find((i) => i.label.startsWith('Business support'))?.value).toEqual(zar('-10000'));
  });

  it('eliminates salary and support inside a consolidated scope', () => {
    const computation = computeRunway({ ...entityInput([COMPANY_ID, OWNER_ID]), scope: { kind: 'entity', entityId: null, label: 'Group' } });
    expect(computation.result.averageMonthlyNetOutflow).toEqual(zar('-6000'));
    expect(computation.result.status).toBe('not_depleting');
    expect(computation.excludedFlows).toContainEqual({ nature: 'internal_to_scope', total: zar('105000'), count: 6 });
  });
});

describe('depletionDateAfter', () => {
  it('adds whole months then the fractional month in days', () => {
    expect(depletionDateAfter('2026-01-31', dec('1'))).toBe('2026-02-28');
    expect(depletionDateAfter('2026-01-15', dec('0.5'))).toBe('2026-01-30');
    expect(depletionDateAfter('2026-01-15', dec('0'))).toBe('2026-01-15');
    expect(() => depletionDateAfter('2026-01-15', dec('-1'))).toThrow();
  });
});
