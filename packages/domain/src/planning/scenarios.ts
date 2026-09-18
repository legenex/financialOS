/**
 * Scenario adjustments as a pure transformation of cash-flow items. The input array and its items are never
 * mutated: modified items are new objects, and the application records enough to rebuild the baseline exactly
 * (`removeScenario`). Adjustments apply in order, so two percentage changes compound.
 */
import type { ScenarioAdjustment, SourceLink } from '@financialos/contracts';
import { addDays, type IsoDate } from '../dates';
import { dec, money } from '../money';
import type { CashFlowItem, CashFlowSource } from './cashflow';
import { decString, percentFactor, PlanningError, roundedMoney } from './shared';

export interface ScenarioChange {
  adjustmentIndex: number;
  type: ScenarioAdjustment['type'];
  itemId: string;
  effect: 'amount_changed' | 'date_moved' | 'added' | 'removed';
  before: { date: IsoDate; amount: string | null } | null;
  after: { date: IsoDate; amount: string | null } | null;
}

interface Entry<T> {
  item: T | CashFlowItem;
  /** Index in the baseline array; null for items added by the scenario. */
  originIndex: number | null;
  /** The untouched baseline item when this entry was modified. */
  baseline: T | null;
}

export interface ScenarioApplication<T extends CashFlowItem = CashFlowItem> {
  scenarioId: string | null;
  items: Array<T | CashFlowItem>;
  changes: ScenarioChange[];
  /** Reconstruction data used by `removeScenario`. */
  trace: {
    baselineLength: number;
    origins: Array<number | null>;
    baselines: Array<T | null>;
    removed: Array<{ originIndex: number; item: T }>;
  };
}

const COST_SOURCES: ReadonlySet<CashFlowSource> = new Set(['recurring', 'obligation', 'payable', 'other']);
const INCOME_SOURCES: ReadonlySet<CashFlowSource> = new Set(['recurring', 'receivable', 'other']);

function entityMatches(adjustmentEntity: string | null, item: CashFlowItem): boolean {
  return adjustmentEntity === null || item.entityId === adjustmentEntity;
}

function validatePercent(percent: string): void {
  if (dec(percent).lessThan(-100)) throw new PlanningError(`A percentage change cannot be below -100%: ${percent}`);
}

export interface ApplyScenarioOptions {
  scenarioId?: string | null;
  scenarioName?: string;
}

export function applyScenario<T extends CashFlowItem>(
  baseline: readonly T[],
  adjustments: readonly ScenarioAdjustment[],
  options: ApplyScenarioOptions = {},
): ScenarioApplication<T> {
  const scenarioId = options.scenarioId ?? null;
  const scenarioLink: SourceLink | null = scenarioId ? { kind: 'scenario', id: scenarioId, label: options.scenarioName ?? 'Scenario' } : null;
  let entries: Array<Entry<T>> = baseline.map((item, index) => ({ item, originIndex: index, baseline: null }));
  const removed: ScenarioApplication<T>['trace']['removed'] = [];
  const changes: ScenarioChange[] = [];

  const modify = (entry: Entry<T>, patch: Partial<CashFlowItem>, adjustmentIndex: number, type: ScenarioAdjustment['type'], effect: ScenarioChange['effect']) => {
    const before = entry.item;
    const links = scenarioLink && !before.links.some((l) => l.kind === 'scenario' && l.id === scenarioLink.id) ? [...before.links, scenarioLink] : before.links;
    const next: CashFlowItem = { ...before, ...patch, links };
    changes.push({
      adjustmentIndex,
      type,
      itemId: before.id,
      effect,
      before: { date: before.date, amount: before.amount?.amount ?? null },
      after: { date: next.date, amount: next.amount?.amount ?? null },
    });
    return { item: next, originIndex: entry.originIndex, baseline: entry.baseline ?? (entry.originIndex === null ? null : (entry.item as T)) };
  };

  adjustments.forEach((adjustment, adjustmentIndex) => {
    switch (adjustment.type) {
      case 'income_change': {
        validatePercent(adjustment.percent);
        const factor = percentFactor(adjustment.percent);
        entries = entries.map((entry) => {
          const item = entry.item;
          if (item.direction !== 'in' || !INCOME_SOURCES.has(item.source) || item.kind === 'transfer') return entry;
          if (item.date < adjustment.from || !entityMatches(adjustment.entityId, item) || item.amount === null) return entry;
          const amount = roundedMoney(dec(item.amount.amount).times(factor), item.amount.currency);
          return modify(entry, { amount }, adjustmentIndex, adjustment.type, 'amount_changed');
        });
        break;
      }
      case 'cost_change': {
        validatePercent(adjustment.percent);
        const factor = percentFactor(adjustment.percent);
        entries = entries.map((entry) => {
          const item = entry.item;
          if (item.direction !== 'out' || !COST_SOURCES.has(item.source)) return entry;
          if (adjustment.kind !== null && item.kind !== adjustment.kind) return entry;
          if (item.date < adjustment.from || !entityMatches(adjustment.entityId, item) || item.amount === null) return entry;
          const amount = roundedMoney(dec(item.amount.amount).times(factor), item.amount.currency);
          return modify(entry, { amount }, adjustmentIndex, adjustment.type, 'amount_changed');
        });
        break;
      }
      case 'delay_receivables': {
        entries = entries.map((entry) => {
          const item = entry.item;
          if (item.source !== 'receivable' || item.direction !== 'in' || !entityMatches(adjustment.entityId, item)) return entry;
          return modify(entry, { date: addDays(item.date, adjustment.days) }, adjustmentIndex, adjustment.type, 'date_moved');
        });
        break;
      }
      case 'pause_recurring': {
        const kept: Array<Entry<T>> = [];
        for (const entry of entries) {
          const item = entry.item;
          const paused =
            item.recurringItemId === adjustment.recurringItemId && item.date >= adjustment.from && (adjustment.to === null || item.date <= adjustment.to);
          if (!paused) {
            kept.push(entry);
            continue;
          }
          changes.push({
            adjustmentIndex,
            type: adjustment.type,
            itemId: item.id,
            effect: 'removed',
            before: { date: item.date, amount: item.amount?.amount ?? null },
            after: null,
          });
          if (entry.originIndex !== null) removed.push({ originIndex: entry.originIndex, item: entry.baseline ?? (entry.item as T) });
        }
        entries = kept;
        break;
      }
      case 'one_off': {
        const magnitude = dec(adjustment.amount);
        if (magnitude.isNegative() || magnitude.isZero()) throw new PlanningError('A one-off scenario amount must be positive; use direction for in/out');
        const item: CashFlowItem = {
          id: `scenario:${scenarioId ?? 'adhoc'}:${adjustmentIndex}`,
          date: adjustment.date,
          label: adjustment.label,
          direction: adjustment.direction,
          amount: money(decString(magnitude), adjustment.currency),
          certainty: 'committed',
          probability: null,
          source: 'scenario',
          kind: 'one_off',
          entityId: adjustment.entityId,
          recurringItemId: null,
          links: scenarioLink ? [scenarioLink] : [],
        };
        entries = [...entries, { item, originIndex: null, baseline: null }];
        changes.push({ adjustmentIndex, type: adjustment.type, itemId: item.id, effect: 'added', before: null, after: { date: item.date, amount: item.amount!.amount } });
        break;
      }
      default: {
        const unreachable: never = adjustment;
        throw new PlanningError(`Unsupported scenario adjustment: ${JSON.stringify(unreachable)}`);
      }
    }
  });

  return {
    scenarioId,
    items: entries.map((e) => e.item),
    changes,
    trace: {
      baselineLength: baseline.length,
      origins: entries.map((e) => e.originIndex),
      baselines: entries.map((e) => e.baseline),
      removed,
    },
  };
}

/** Rebuilds the exact baseline array from a scenario application (reversal). */
export function removeScenario<T extends CashFlowItem>(application: ScenarioApplication<T>): T[] {
  const slots: Array<T | undefined> = Array.from({ length: application.trace.baselineLength }, () => undefined);
  application.items.forEach((item, index) => {
    const origin = application.trace.origins[index];
    if (origin === null || origin === undefined) return;
    slots[origin] = application.trace.baselines[index] ?? (item as T);
  });
  for (const { originIndex, item } of application.trace.removed) slots[originIndex] = item;
  const rebuilt: T[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    const item = slots[i];
    if (item === undefined) throw new PlanningError('Scenario trace is incomplete; cannot rebuild the baseline');
    rebuilt.push(item);
  }
  return rebuilt;
}
