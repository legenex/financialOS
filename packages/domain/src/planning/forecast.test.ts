import { CashForecast } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import { dec } from '../money';
import { cashForecast, weekStartFor, type CashForecastInput } from './forecast';
import { PlanningError } from './shared';
import { COMPANY_ID, recurring, uid, usd, zar } from './testing';

const PAYROLL = uid(1);
const SOFTWARE = uid(2);
const OVERHEAD = uid(3);
const SCENARIO = uid(4);

const receivable = (id: number, expectedOn: string, amount: string, probability: string) => ({
  id: uid(id),
  entityId: COMPANY_ID,
  kind: 'receivable' as const,
  counterparty: 'Sample Client',
  outstanding: zar(amount),
  dueOn: expectedOn,
  expectedOn,
  probability,
  status: 'open' as const,
  category: 'sales' as const,
  reference: `INV-${id}`,
});

function input(overrides: Partial<CashForecastInput> = {}): CashForecastInput {
  return {
    entityId: COMPANY_ID,
    label: 'Example Holdings Ltd',
    currency: 'ZAR',
    startDate: '2026-03-11',
    weekStartsOn: 'monday',
    openings: [{ id: 'op', label: 'Operating account', balance: zar('50000'), links: [{ kind: 'account', id: uid(9), label: 'Operating account' }] }],
    recurring: [
      recurring({ id: PAYROLL, name: 'Payroll', entityId: COMPANY_ID, kind: 'payroll', nextDueOn: '2026-03-25', amount: { amount: '40000', currency: 'ZAR' } }),
      recurring({ id: SOFTWARE, name: 'Software', entityId: COMPANY_ID, kind: 'software', cadence: 'weekly', nextDueOn: '2026-03-13', amount: { amount: '500', currency: 'ZAR' } }),
      recurring({ id: uid(5), name: 'Personal rent', kind: 'bill', nextDueOn: '2026-03-15', amount: { amount: '9999', currency: 'ZAR' } }),
    ],
    receivablesPayables: [receivable(20, '2026-03-20', '30000', '0.5'), receivable(21, '2026-04-10', '10000', '1')],
    lowCashThreshold: zar('25000'),
    ...overrides,
  };
}

describe('cashForecast', () => {
  it('builds 13 weeks from the configured week start and only uses the entity’s items', () => {
    const result = cashForecast(input());
    expect(() => CashForecast.parse(result)).not.toThrow();
    expect(result.weeks).toHaveLength(13);
    expect(result.weeks[0]).toEqual(expect.objectContaining({ weekStart: '2026-03-09', weekEnd: '2026-03-15' }));
    expect(result.weeks[12]?.weekEnd).toBe('2026-06-07');
    expect(result.status).toBe('ok');
    expect(JSON.stringify(result)).not.toContain('Personal rent');
    const week1 = result.weeks[0]!;
    expect(week1.openingBalance).toEqual(zar('50000'));
    expect(week1.outflows).toEqual(zar('500'));
    expect(week1.closingBalance).toEqual(zar('49500'));
    expect(week1.items).toEqual([
      { date: '2026-03-13', label: 'Software', amount: zar('500'), direction: 'out', source: 'recurring', probability: null, links: [{ kind: 'recurring', id: SOFTWARE, label: 'Software' }] },
    ]);
  });

  it('chains weeks and weights receivables by probability', () => {
    const result = cashForecast(input());
    const [w1, w2, w3] = result.weeks;
    expect(w2?.openingBalance).toEqual(w1?.closingBalance);
    expect(w2?.inflows).toEqual(zar('15000'));
    expect(w2?.items.find((i) => i.source === 'receivable')).toEqual(expect.objectContaining({ probability: '0.5', amount: zar('15000') }));
    expect(w3?.outflows).toEqual(zar('40500'));
    expect(w3?.closingBalance).toEqual(zar('23500'));
    for (let i = 1; i < result.weeks.length; i += 1) expect(result.weeks[i]?.openingBalance).toEqual(result.weeks[i - 1]?.closingBalance);
  });

  it('offers a conservative committed-only view', () => {
    const result = cashForecast(input({ mode: 'committed_only' }));
    expect(result.weeks[1]?.inflows).toEqual(zar('0'));
    expect(result.explanation.items).toContainEqual(expect.objectContaining({ role: 'excluded', label: 'Receivable from Sample Client (INV-20) on 2026-03-20' }));
  });

  it('warns about weeks below zero or below the threshold', () => {
    const result = cashForecast(input());
    expect(result.warnings).toContain('Week of 2026-03-23: closing cash of 23500 ZAR is below the low-cash threshold of 25000 ZAR.');
    expect(result.warnings).toContain('Week of 2026-04-20: closing cash of -8500 ZAR is below zero.');
    expect(result.warnings.some((w) => w.includes('below zero'))).toBe(true);
    expect(dec(result.lowestClosing!.amount).isNegative()).toBe(true);
    const lowestWeek = result.weeks.find((w) => w.weekStart === result.lowestClosingWeek);
    expect(lowestWeek?.closingBalance).toEqual(result.lowestClosing);
  });

  it('warns when cash dips below zero inside a week that closes positive', () => {
    const result = cashForecast(
      input({
        recurring: [],
        receivablesPayables: [receivable(30, '2026-03-13', '100000', '1')],
        obligations: [{ id: uid(31), entityId: COMPANY_ID, dueOn: '2026-03-12', amount: { amount: '60000', currency: 'ZAR' }, label: 'Tax payment', kind: 'tax', status: 'upcoming' }],
        lowCashThreshold: null,
      }),
    );
    expect(result.weeks[0]?.closingBalance).toEqual(zar('90000'));
    expect(result.warnings).toEqual(['Week of 2026-03-09: cash dips below zero during the week (-10000 ZAR on 2026-03-12).']);
  });

  it('counts unknown-amount recurring items per week and marks the forecast provisional', () => {
    const result = cashForecast(
      input({
        recurring: [recurring({ id: OVERHEAD, name: 'Utilities', entityId: COMPANY_ID, kind: 'overhead', nextDueOn: '2026-03-18', amount: { amount: null, currency: null } })],
        receivablesPayables: [],
      }),
    );
    expect(result.status).toBe('provisional');
    expect(result.weeks[1]?.unknownItems).toBe(1);
    expect(result.weeks[0]?.unknownItems).toBe(0);
    expect(result.weeks.reduce((n, w) => n + w.unknownItems, 0)).toBe(3);
    expect(result.warnings).toContain('3 forecast items have an unknown amount and are not included.');
    expect(result.explanation.missing).toContain('Utilities on 2026-03-18: amount unknown');
  });

  it('applies a scenario and records its id', () => {
    const scenario = {
      id: SCENARIO,
      name: 'Slow payers',
      adjustments: [
        { type: 'delay_receivables' as const, days: 60, entityId: COMPANY_ID },
        { type: 'pause_recurring' as const, recurringItemId: SOFTWARE, from: '2026-03-01', to: null },
        { type: 'one_off' as const, amount: '5000', currency: 'ZAR', date: '2026-03-12', direction: 'out' as const, label: 'Deposit', entityId: COMPANY_ID },
      ],
    };
    const result = cashForecast(input({ scenario }));
    expect(result.scenarioId).toBe(SCENARIO);
    expect(result.weeks[0]?.items).toEqual([expect.objectContaining({ label: 'Deposit', source: 'scenario', amount: zar('5000') })]);
    expect(result.weeks[1]?.inflows).toEqual(zar('0'));
    expect(result.explanation.assumptions[0]).toBe('Scenario applied with 16 changes');
    expect(cashForecast(input()).weeks[0]?.outflows).toEqual(zar('500'));
  });

  it('supports Sunday and arbitrary week starts', () => {
    expect(cashForecast(input({ weekStartsOn: 'sunday' })).weeks[0]?.weekStart).toBe('2026-03-08');
    expect(weekStartFor('2026-03-11', 3)).toBe('2026-03-11');
    expect(weekStartFor('2026-03-10', 3)).toBe('2026-03-04');
    expect(() => weekStartFor('2026-03-10', 9 as never)).toThrow(PlanningError);
    expect(() => cashForecast(input({ weeks: 0 }))).toThrow(PlanningError);
  });

  it('needs a known opening balance', () => {
    const result = cashForecast(input({ openings: [{ id: 'op', label: 'Operating account', balance: null, links: [] }] }));
    expect(result.status).toBe('insufficient_data');
    expect(result.weeks).toEqual([]);
    expect(result.lowestClosing).toBeNull();
    expect(result.warnings).toContain('Opening cash is unknown, so weekly balances cannot be projected.');
  });

  it('converts a foreign threshold or warns when it cannot', () => {
    const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '20', asOf: '2026-03-10', source: 'test' }]);
    const converted = cashForecast(input({ lowCashThreshold: usd('1250'), fx }));
    expect(converted.warnings.some((w) => w.includes('threshold of 25000 ZAR'))).toBe(true);
    const missing = cashForecast(input({ lowCashThreshold: usd('1000') }));
    expect(missing.warnings).toContain('The low-cash threshold could not be converted to ZAR.');
  });
});
