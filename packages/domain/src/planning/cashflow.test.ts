import { TimelinePoint } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import { FxTable } from '../fx';
import {
  dedupeCashFlowItems,
  expandRecurringFlows,
  goalCommitmentFlows,
  obligationFlows,
  projectCashFlow,
  receivablePayableFlows,
  recurringOccurrenceId,
} from './cashflow';
import { PlanningError } from './shared';
import { deepFreeze, flow, OWNER_ID, recurring, uid, usd, zar } from './testing';

const opening = (amount: string | null) => [{ id: 'acc', label: 'Everyday account', balance: amount === null ? null : zar(amount), links: [] }];
const window = { from: '2026-03-10', to: '2026-04-09', currency: 'ZAR' };

describe('projectCashFlow', () => {
  it('applies each item once, on its date, and tracks the running balance and lowest point', () => {
    const items = [
      flow({ id: 'rent', date: '2026-03-25', amount: zar('6000') }),
      flow({ id: 'salary', date: '2026-03-25', direction: 'in', amount: zar('20000'), kind: 'salary' }),
      flow({ id: 'phone', date: '2026-03-12', amount: zar('500') }),
    ];
    const p = projectCashFlow(opening('7000'), items, window);
    expect(p.status).toBe('ok');
    expect(p.timeline.map((t) => [t.date, t.kind, t.change.amount, t.balanceAfter.amount])).toEqual([
      ['2026-03-10', 'opening', '7000', '7000'],
      ['2026-03-12', 'outflow', '-500', '6500'],
      ['2026-03-25', 'outflow', '-6000', '500'],
      ['2026-03-25', 'inflow', '20000', '20500'],
    ]);
    // Same-day outflow is applied before the salary, so the lowest point is honest.
    expect(p.lowest).toEqual(zar('500'));
    expect(p.lowestOn).toBe('2026-03-25');
    expect(p.closing).toEqual(zar('20500'));
    expect(p.inflows).toEqual(zar('20000'));
    expect(p.outflows).toEqual(zar('6500'));
    for (const point of p.timeline) expect(() => TimelinePoint.parse(point)).not.toThrow();
  });

  it('is deterministic regardless of input order', () => {
    const items = [
      flow({ id: 'b', date: '2026-03-20', amount: zar('10') }),
      flow({ id: 'a', date: '2026-03-20', amount: zar('20') }),
      flow({ id: 'c', date: '2026-03-15', direction: 'in', amount: zar('5') }),
    ];
    const forward = projectCashFlow(opening('100'), items, window);
    const reversed = projectCashFlow(opening('100'), [...items].reverse(), window);
    expect(reversed).toEqual(forward);
  });

  it('ignores items outside the horizon and never mutates its inputs', () => {
    const items = deepFreeze([flow({ id: 'late', date: '2026-04-10' }), flow({ id: 'in', date: '2026-04-09' })]);
    const p = projectCashFlow(deepFreeze(opening('1000')), items, window);
    expect(p.applied.map((a) => a.id)).toEqual(['in']);
    expect(p.skipped).toEqual([expect.objectContaining({ id: 'late', reason: 'outside_horizon' })]);
  });

  it('applies overdue outflows on the start date and does not rely on overdue inflows', () => {
    const items = [
      flow({ id: 'overdue-bill', date: '2026-03-01', amount: zar('300') }),
      flow({ id: 'late-refund', date: '2026-03-02', direction: 'in', amount: zar('50') }),
    ];
    const p = projectCashFlow(opening('1000'), items, window);
    expect(p.applied).toEqual([expect.objectContaining({ id: 'overdue-bill', date: '2026-03-10', originalDate: '2026-03-01', overdue: true, label: 'overdue-bill (overdue)' })]);
    expect(p.skipped).toEqual([expect.objectContaining({ id: 'late-refund', reason: 'overdue_inflow' })]);
    const strict = projectCashFlow(opening('1000'), items, { ...window, applyOverdueOutflows: false });
    expect(strict.applied).toEqual([]);
  });

  it('counts items sharing an id once, keeping the most specific version', () => {
    const items = [
      flow({ id: 'x', date: '2026-03-15', amount: null, source: 'recurring' }),
      flow({ id: 'x', date: '2026-03-16', amount: zar('250'), source: 'obligation' }),
      flow({ id: 'x', date: '2026-03-17', amount: zar('999'), source: 'other', certainty: 'expected' }),
    ];
    const p = projectCashFlow(opening('1000'), items, window);
    expect(p.applied).toHaveLength(1);
    expect(p.applied[0]).toEqual(expect.objectContaining({ date: '2026-03-16', amount: zar('250') }));
    expect(p.skipped.filter((s) => s.reason === 'duplicate')).toHaveLength(2);
    expect(p.unknownAmounts).toEqual([]);
    expect(p.closing).toEqual(zar('750'));
  });

  it('keeps unknown amounts separate, never as zero, and downgrades the status', () => {
    const items = [flow({ id: 'water', date: '2026-03-20', amount: null, label: 'Water bill' }), flow({ id: 'gym', date: '2026-03-21', amount: zar('200') })];
    const p = projectCashFlow(opening('1000'), items, window);
    expect(p.status).toBe('provisional');
    expect(p.unknownOutflowCount).toBe(1);
    expect(p.outflows).toEqual(zar('200'));
    const unknownPoint = p.timeline.find((t) => t.kind === 'unknown_amount');
    expect(unknownPoint).toEqual(expect.objectContaining({ label: 'Water bill (amount unknown, not included)', confidence: 'none' }));
    expect(unknownPoint?.balanceAfter).toEqual(zar('1000'));
  });

  it('counts only committed inflows by default and weights expected items on request', () => {
    const items = [
      flow({ id: 'invoice', date: '2026-03-20', direction: 'in', amount: zar('1000'), certainty: 'expected', probability: '0.6', source: 'receivable' }),
      flow({ id: 'maybe-bill', date: '2026-03-21', amount: zar('500'), certainty: 'expected', probability: '0.5', source: 'payable' }),
      flow({ id: 'never', date: '2026-03-22', direction: 'in', amount: zar('1000'), certainty: 'expected', probability: '0' }),
    ];
    const conservative = projectCashFlow(opening('100'), items, window);
    expect(conservative.mode).toBe('committed_only');
    expect(conservative.inflows).toEqual(zar('0'));
    expect(conservative.outflows).toEqual(zar('500'));
    expect(conservative.skipped.map((s) => [s.id, s.reason])).toEqual([
      ['invoice', 'not_committed'],
      ['never', 'not_committed'],
    ]);
    const weighted = projectCashFlow(opening('100'), items, { ...window, mode: 'probability_weighted' });
    expect(weighted.inflows).toEqual(zar('600'));
    expect(weighted.outflows).toEqual(zar('250'));
    expect(weighted.applied.find((a) => a.id === 'invoice')?.weight).toBe('0.6');
    expect(weighted.skipped).toEqual([expect.objectContaining({ id: 'never', reason: 'zero_probability' })]);
    expect(weighted.timeline.find((t) => t.label === 'invoice')?.confidence).toBe('medium');
  });

  it('rounds probability-weighted amounts to the currency', () => {
    const items = [flow({ id: 'x', date: '2026-03-20', direction: 'in', amount: zar('100.01'), certainty: 'expected', probability: '0.333' })];
    const p = projectCashFlow(opening('0'), items, { ...window, mode: 'probability_weighted' });
    expect(p.applied[0]?.amount).toEqual(zar('33.3'));
  });

  it('converts foreign items at the spot date and lists unconvertible ones', () => {
    const fx = new FxTable([{ base: 'USD', quote: 'ZAR', rate: '18', asOf: '2026-03-09', source: 'test' }]);
    const items = [flow({ id: 'usd-sub', date: '2026-03-20', amount: usd('10') }), flow({ id: 'gbp-sub', date: '2026-03-20', amount: { amount: '5', currency: 'GBP' } })];
    const p = projectCashFlow(opening('1000'), items, { ...window, fx });
    expect(p.applied[0]).toEqual(expect.objectContaining({ amount: zar('180'), original: usd('10') }));
    expect(p.applied[0]?.fx).toEqual(expect.objectContaining({ from: 'USD', to: 'ZAR', rate: '18', method: 'spot_at_valuation' }));
    expect(p.unconverted).toEqual([expect.objectContaining({ id: 'gbp-sub' })]);
    expect(p.status).toBe('provisional');
  });

  it('reports insufficient data when no opening balance is known', () => {
    const p = projectCashFlow(opening(null), [flow({ id: 'a', date: '2026-03-20' })], window);
    expect(p.status).toBe('insufficient_data');
    expect(p.opening).toBeNull();
    expect(p.lowest).toBeNull();
    expect(p.timeline).toEqual([]);
    expect(p.outflows).toEqual(zar('100'));
  });

  it('marks a partially known opening as provisional', () => {
    const openings = [...opening('100'), { id: 'b', label: 'Other', balance: null, links: [] }];
    const p = projectCashFlow(openings, [], window);
    expect(p.status).toBe('provisional');
    expect(p.opening).toEqual(zar('100'));
    expect(p.openingUnknown).toEqual([expect.objectContaining({ id: 'b' })]);
  });

  it('rejects invalid input', () => {
    expect(() => projectCashFlow(opening('1'), [flow({ id: 'neg', date: '2026-03-20', amount: zar('-5') })], window)).toThrow(PlanningError);
    expect(() => projectCashFlow(opening('1'), [flow({ id: 'p', date: '2026-03-20', probability: '1.5' })], window)).toThrow(PlanningError);
    expect(() => projectCashFlow(opening('1'), [], { ...window, to: '2026-03-01' })).toThrow(PlanningError);
    expect(() => projectCashFlow(opening('1'), [flow({ id: '', date: '2026-03-20' })], window)).toThrow(PlanningError);
  });
});

describe('dedupeCashFlowItems', () => {
  it('keeps input order for survivors', () => {
    const a = flow({ id: 'a', date: '2026-03-20' });
    const b1 = flow({ id: 'b', date: '2026-03-21', certainty: 'expected' });
    const b2 = flow({ id: 'b', date: '2026-03-21' });
    const result = dedupeCashFlowItems([a, b1, b2]);
    expect(result.kept).toEqual([a, b2]);
    expect(result.duplicates).toEqual([b1]);
  });
});

describe('adapters', () => {
  it('expands recurring items into occurrences with stable ids', () => {
    const items = [
      recurring({ id: uid(10), name: 'Rent', nextDueOn: '2026-03-01', dayOfMonth: 1, amount: { amount: '6000', currency: 'ZAR' } }),
      recurring({ id: uid(11), name: 'Streaming', nextDueOn: '2026-03-20', confirmed: false, status: 'suggested' }),
      recurring({ id: uid(12), name: 'Paused gym', status: 'paused' }),
      recurring({ id: uid(13), name: 'Unscheduled', nextDueOn: null }),
      recurring({ id: uid(14), name: 'Salary', direction: 'in', kind: 'salary', nextDueOn: '2026-03-25', amount: { amount: null, currency: null } }),
    ];
    const result = expandRecurringFlows(items, '2026-03-10', '2026-05-09');
    expect(result.flows.map((f) => [f.id, f.date, f.certainty, f.amount?.amount ?? null])).toEqual([
      [recurringOccurrenceId(uid(10), '2026-04-01'), '2026-04-01', 'committed', '6000'],
      [recurringOccurrenceId(uid(10), '2026-05-01'), '2026-05-01', 'committed', '6000'],
      [recurringOccurrenceId(uid(11), '2026-03-20'), '2026-03-20', 'expected', '100'],
      [recurringOccurrenceId(uid(11), '2026-04-20'), '2026-04-20', 'expected', '100'],
      [recurringOccurrenceId(uid(14), '2026-03-25'), '2026-03-25', 'committed', null],
      [recurringOccurrenceId(uid(14), '2026-04-25'), '2026-04-25', 'committed', null],
    ]);
    expect(result.unscheduled).toEqual([{ id: uid(13), name: 'Unscheduled', reason: 'No next due date' }]);
    expect(result.pastDue).toEqual([{ id: uid(10), name: 'Rent', nextDueOn: '2026-03-01' }]);
    expect(result.flows[0]?.links[0]).toEqual({ kind: 'recurring', id: uid(10), label: 'Rent' });
  });

  it('maps obligations, reusing the occurrence id when they settle a recurring item', () => {
    const flows = obligationFlows([
      { id: uid(20), entityId: OWNER_ID, dueOn: '2026-03-15', amount: { amount: '250', currency: 'ZAR' }, label: 'Licence', kind: 'bill', status: 'upcoming' },
      { id: uid(21), entityId: OWNER_ID, dueOn: '2026-03-16', amount: { amount: '99', currency: 'ZAR' }, label: 'Paid', kind: 'bill', status: 'paid' },
      { id: uid(22), entityId: OWNER_ID, dueOn: '2026-04-01', amount: { amount: '6100', currency: 'ZAR' }, label: 'Rent (new amount)', kind: 'bill', status: 'upcoming', recurringItemId: uid(10) },
    ]);
    expect(flows.map((f) => f.id)).toEqual([uid(20), recurringOccurrenceId(uid(10), '2026-04-01')]);
    expect(flows[1]?.links).toEqual([{ kind: 'obligation', id: uid(22), label: 'Rent (new amount)' }]);
  });

  it('maps receivables and payables with probability and lists undated ones', () => {
    const base = { entityId: OWNER_ID, intercompanyEntityId: null, issuedOn: null, source: 'manual' as const, category: 'sales' as const, amount: zar('100'), reference: null };
    const { flows, undated } = receivablePayableFlows([
      { ...base, id: uid(30), kind: 'receivable', counterparty: 'Sample Client', outstanding: zar('100'), dueOn: '2026-03-30', expectedOn: '2026-04-05', probability: '0.8', status: 'open' },
      { ...base, id: uid(31), kind: 'payable', counterparty: 'Sample Vendor', outstanding: zar('40'), dueOn: '2026-03-18', expectedOn: null, probability: '1', status: 'partial' },
      { ...base, id: uid(32), kind: 'receivable', counterparty: 'Sample Client', outstanding: zar('10'), dueOn: null, expectedOn: null, probability: '1', status: 'open' },
      { ...base, id: uid(33), kind: 'receivable', counterparty: 'Sample Client', outstanding: zar('0'), dueOn: '2026-03-18', expectedOn: null, probability: '1', status: 'open' },
      { ...base, id: uid(34), kind: 'receivable', counterparty: 'Sample Client', outstanding: zar('5'), dueOn: '2026-03-18', expectedOn: null, probability: '1', status: 'paid' },
    ]);
    expect(flows.map((f) => [f.date, f.direction, f.certainty, f.source])).toEqual([
      ['2026-04-05', 'in', 'expected', 'receivable'],
      ['2026-03-18', 'out', 'committed', 'payable'],
    ]);
    expect(undated).toEqual([{ id: uid(32), label: 'Receivable from Sample Client' }]);
  });

  it('turns only goal commitments into outflows', () => {
    const flows = goalCommitmentFlows([
      { id: 'p1', goalId: uid(40), goalName: 'Holiday', date: '2026-03-28', amount: zar('500'), commitment: true },
      { id: 'p2', goalId: uid(40), goalName: 'Holiday', date: '2026-04-28', amount: zar('500'), commitment: false },
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toEqual(expect.objectContaining({ id: 'goal:p1', direction: 'out', source: 'goal' }));
  });
});
