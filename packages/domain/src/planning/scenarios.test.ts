import type { ScenarioAdjustment } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { projectCashFlow } from './cashflow';
import { applyScenario, removeScenario } from './scenarios';
import { PlanningError } from './shared';
import { COMPANY_ID, deepFreeze, flow, uid, zar } from './testing';

const SCENARIO = uid(90);

function baseline() {
  return deepFreeze([
    flow({ id: 'salary-mar', date: '2026-03-25', direction: 'in', amount: zar('20000'), source: 'recurring', kind: 'salary', recurringItemId: uid(1), entityId: COMPANY_ID }),
    flow({ id: 'salary-apr', date: '2026-04-25', direction: 'in', amount: zar('20000'), source: 'recurring', kind: 'salary', recurringItemId: uid(1), entityId: COMPANY_ID }),
    flow({ id: 'invoice', date: '2026-03-30', direction: 'in', amount: zar('5000'), source: 'receivable', certainty: 'expected', probability: '0.9', entityId: COMPANY_ID }),
    flow({ id: 'software-mar', date: '2026-03-12', amount: zar('1000'), source: 'recurring', kind: 'software', recurringItemId: uid(2), entityId: COMPANY_ID }),
    flow({ id: 'software-apr', date: '2026-04-12', amount: zar('1000'), source: 'recurring', kind: 'software', recurringItemId: uid(2), entityId: COMPANY_ID }),
    flow({ id: 'payroll', date: '2026-03-28', amount: zar('8000'), source: 'recurring', kind: 'payroll', recurringItemId: uid(3), entityId: COMPANY_ID }),
    flow({ id: 'unknown-bill', date: '2026-03-20', amount: null, source: 'obligation', kind: 'software' }),
    flow({ id: 'goal', date: '2026-03-21', amount: zar('300'), source: 'goal', kind: 'software' }),
  ]);
}

const byId = <T extends { id: string }>(items: readonly T[], id: string): T | undefined => items.find((i) => i.id === id);

describe('applyScenario', () => {
  it('changes income by a percentage from a date', () => {
    const app = applyScenario(baseline(), [{ type: 'income_change', percent: '-25', from: '2026-04-01', entityId: null }], { scenarioId: SCENARIO });
    expect(byId(app.items, 'salary-mar')?.amount).toEqual(zar('20000'));
    expect(byId(app.items, 'salary-apr')?.amount).toEqual(zar('15000'));
    expect(byId(app.items, 'salary-apr')?.links).toEqual([{ kind: 'scenario', id: SCENARIO, label: 'Scenario' }]);
    expect(app.changes).toEqual([
      { adjustmentIndex: 0, type: 'income_change', itemId: 'salary-apr', effect: 'amount_changed', before: { date: '2026-04-25', amount: '20000' }, after: { date: '2026-04-25', amount: '15000' } },
    ]);
  });

  it('respects the entity filter', () => {
    const app = applyScenario(baseline(), [{ type: 'income_change', percent: '10', from: '2026-01-01', entityId: uid(99) }]);
    expect(app.changes).toEqual([]);
    expect(app.items).toEqual(baseline());
  });

  it('delays receivables by days', () => {
    const app = applyScenario(baseline(), [{ type: 'delay_receivables', days: 30, entityId: COMPANY_ID }]);
    expect(byId(app.items, 'invoice')?.date).toBe('2026-04-29');
    expect(byId(app.items, 'salary-mar')?.date).toBe('2026-03-25');
  });

  it('adds one-off items', () => {
    const app = applyScenario(baseline(), [{ type: 'one_off', amount: '2500.50', currency: 'ZAR', date: '2026-03-18', direction: 'out', label: 'Laptop', entityId: null }], { scenarioId: SCENARIO });
    const added = byId(app.items, `scenario:${SCENARIO}:0`);
    expect(added).toEqual(expect.objectContaining({ amount: zar('2500.5'), direction: 'out', source: 'scenario', certainty: 'committed' }));
    expect(app.items).toHaveLength(baseline().length + 1);
  });

  it('changes costs by kind from a date, leaving goals and unknown amounts alone', () => {
    const app = applyScenario(baseline(), [{ type: 'cost_change', percent: '-50', from: '2026-04-01', kind: 'software', entityId: null }]);
    expect(byId(app.items, 'software-mar')?.amount).toEqual(zar('1000'));
    expect(byId(app.items, 'software-apr')?.amount).toEqual(zar('500'));
    expect(byId(app.items, 'goal')?.amount).toEqual(zar('300'));
    expect(byId(app.items, 'unknown-bill')?.amount).toBeNull();
    const all = applyScenario(baseline(), [{ type: 'cost_change', percent: '10', from: '2026-01-01', kind: null, entityId: null }]);
    expect(byId(all.items, 'payroll')?.amount).toEqual(zar('8800'));
    expect(byId(all.items, 'salary-mar')?.amount).toEqual(zar('20000'));
  });

  it('pauses a recurring item over a range', () => {
    const app = applyScenario(baseline(), [{ type: 'pause_recurring', recurringItemId: uid(2), from: '2026-04-01', to: null }]);
    expect(byId(app.items, 'software-apr')).toBeUndefined();
    expect(byId(app.items, 'software-mar')).toBeDefined();
    const bounded = applyScenario(baseline(), [{ type: 'pause_recurring', recurringItemId: uid(2), from: '2026-03-01', to: '2026-03-31' }]);
    expect(bounded.items.map((i) => i.id)).not.toContain('software-mar');
    expect(bounded.items.map((i) => i.id)).toContain('software-apr');
  });

  it('compounds adjustments in order', () => {
    const app = applyScenario(baseline(), [
      { type: 'income_change', percent: '-10', from: '2026-01-01', entityId: null },
      { type: 'income_change', percent: '-10', from: '2026-01-01', entityId: null },
    ]);
    expect(byId(app.items, 'salary-mar')?.amount).toEqual(zar('16200'));
  });

  it('rejects impossible adjustments', () => {
    expect(() => applyScenario(baseline(), [{ type: 'income_change', percent: '-150', from: '2026-01-01', entityId: null }])).toThrow(PlanningError);
    expect(() => applyScenario(baseline(), [{ type: 'one_off', amount: '-5', currency: 'ZAR', date: '2026-03-18', direction: 'out', label: 'x', entityId: null }])).toThrow(PlanningError);
  });
});

describe('scenario reversibility', () => {
  const adjustments: ScenarioAdjustment[] = [
    { type: 'income_change', percent: '-30', from: '2026-03-01', entityId: null },
    { type: 'delay_receivables', days: 45, entityId: null },
    { type: 'one_off', amount: '12000', currency: 'ZAR', date: '2026-03-15', direction: 'out', label: 'Equipment', entityId: COMPANY_ID },
    { type: 'cost_change', percent: '-20', from: '2026-03-01', kind: 'software', entityId: null },
    { type: 'pause_recurring', recurringItemId: uid(3), from: '2026-03-01', to: null },
    { type: 'pause_recurring', recurringItemId: uid(2), from: '2026-04-01', to: null },
  ];

  it('never mutates the baseline and restores it exactly when removed', () => {
    const base = baseline();
    const snapshot = structuredClone(base);
    const app = applyScenario(base, adjustments, { scenarioId: SCENARIO });
    expect(app.items).not.toEqual(base);
    expect(base).toEqual(snapshot);
    expect(removeScenario(app)).toEqual(snapshot);
    const restored = removeScenario(app);
    restored.forEach((item, i) => expect(item).toBe(base[i]));
  });

  it('applying no adjustments is the identity, and removal restores the baseline projection', () => {
    const base = baseline();
    expect(applyScenario(base, []).items).toEqual(base);
    const options = { from: '2026-03-10', to: '2026-05-31', currency: 'ZAR', mode: 'probability_weighted' as const };
    const openings = [{ id: 'cash', label: 'Operating account', balance: zar('10000'), links: [] }];
    const before = projectCashFlow(openings, base, options);
    const stressed = projectCashFlow(openings, applyScenario(base, adjustments, { scenarioId: SCENARIO }).items, options);
    expect(stressed.closing).not.toEqual(before.closing);
    const after = projectCashFlow(openings, removeScenario(applyScenario(base, adjustments, { scenarioId: SCENARIO })), options);
    expect(after).toEqual(before);
  });
});
