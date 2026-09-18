import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Global finance context: entity scope, period, reporting currency and scenario.
 * Lives in the URL search params (shareable, back-button friendly, never persisted to storage).
 */

export type PeriodKey = 'this_month' | 'last_month' | 'last_3_months' | 'year_to_date' | 'last_12_months';

export const PERIOD_OPTIONS: Array<{ value: PeriodKey; label: string; short: string }> = [
  { value: 'this_month', label: 'This month', short: 'This month' },
  { value: 'last_month', label: 'Last month', short: 'Last month' },
  { value: 'last_3_months', label: 'Last 3 months', short: '3 months' },
  { value: 'year_to_date', label: 'Year to date', short: 'YTD' },
  { value: 'last_12_months', label: 'Last 12 months', short: '12 months' },
];

export const CONTEXT_KEYS = ['entity', 'period', 'ccy', 'scenario'] as const;

export interface FinanceContext {
  /** 'all' (consolidated), 'personal', or an entity id. */
  entity: string;
  period: PeriodKey;
  /** Reporting currency override, or null for the owner's setting. */
  currency: string | null;
  /** Scenario id, or null for the baseline. */
  scenario: string | null;
  /** True when the owner picked an entity scope explicitly. */
  entityExplicit: boolean;
}

export interface ApiScopeParams {
  scope?: 'personal' | 'consolidated' | 'entity';
  entityId?: string;
  from: string;
  to: string;
  currency?: string;
  scenarioId?: string;
}

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function periodRange(period: PeriodKey, today: Date = new Date()): { from: string; to: string; month: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (period) {
    case 'last_month': {
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0);
      return { from: iso(start), to: iso(end), month: iso(start).slice(0, 7) };
    }
    case 'last_3_months':
      return { from: iso(new Date(y, m - 2, 1)), to: iso(today), month: iso(today).slice(0, 7) };
    case 'year_to_date':
      return { from: iso(new Date(y, 0, 1)), to: iso(today), month: iso(today).slice(0, 7) };
    case 'last_12_months':
      return { from: iso(new Date(y, m - 11, 1)), to: iso(today), month: iso(today).slice(0, 7) };
    case 'this_month':
    default:
      return { from: iso(new Date(y, m, 1)), to: iso(today), month: iso(today).slice(0, 7) };
  }
}

function isPeriod(value: string | null): value is PeriodKey {
  return PERIOD_OPTIONS.some((p) => p.value === value);
}

export function readContext(params: URLSearchParams): FinanceContext {
  const entity = params.get('entity');
  const period = params.get('period');
  const ccy = params.get('ccy');
  const scenario = params.get('scenario');
  return {
    entity: entity && /^(all|personal|[0-9a-f-]{36})$/i.test(entity) ? entity : 'all',
    entityExplicit: !!entity,
    period: isPeriod(period) ? period : 'this_month',
    currency: ccy && /^[A-Z0-9]{2,10}$/.test(ccy) ? ccy : null,
    scenario: scenario && /^[0-9a-f-]{36}$/i.test(scenario) ? scenario : null,
  };
}

export function toApiParams(ctx: FinanceContext): ApiScopeParams {
  const range = periodRange(ctx.period);
  const params: ApiScopeParams = { from: range.from, to: range.to };
  if (ctx.entityExplicit) {
    if (ctx.entity === 'personal') params.scope = 'personal';
    else if (ctx.entity === 'all') params.scope = 'consolidated';
    else {
      params.scope = 'entity';
      params.entityId = ctx.entity;
    }
  }
  if (ctx.currency) params.currency = ctx.currency;
  if (ctx.scenario) params.scenarioId = ctx.scenario;
  return params;
}

/** Keeps only the global context keys from a search string, for links between destinations. */
export function contextSearch(search: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const key of CONTEXT_KEYS) {
    const value = search.get(key);
    if (value) kept.set(key, value);
  }
  const qs = kept.toString();
  return qs ? `?${qs}` : '';
}

export function withContext(path: string, search: URLSearchParams): string {
  const [pathname = path, existing = ''] = path.split('?');
  const merged = new URLSearchParams(existing);
  for (const key of CONTEXT_KEYS) {
    const value = search.get(key);
    if (value && !merged.has(key)) merged.set(key, value);
  }
  const qs = merged.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export function useFinanceContext() {
  const [params, setParams] = useSearchParams();
  const ctx = useMemo(() => readContext(params), [params]);
  const apiParams = useMemo(() => toApiParams(ctx), [ctx]);
  const update = useCallback(
    (patch: Partial<{ entity: string | null; period: PeriodKey | null; currency: string | null; scenario: string | null }>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const map: Record<string, string | null | undefined> = {
            entity: patch.entity,
            period: patch.period,
            ccy: patch.currency,
            scenario: patch.scenario,
          };
          for (const [key, value] of Object.entries(map)) {
            if (value === undefined) continue;
            if (value === null || value === '') next.delete(key);
            else next.set(key, value);
          }
          if (next.get('period') === 'this_month') next.delete('period');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return { ctx, apiParams, update, params };
}
