import { useMemo, useState } from 'react';
import { Server, Settings, SlidersHorizontal } from 'lucide-react';
import { Drawer, Link, Select } from '@financialos/ui';
import { PERIOD_OPTIONS, type PeriodKey, useFinanceContext, withContext } from '../../lib/context';
import { useEntities, useScenarios, useSettings } from '../../lib/endpoints';
import { SignOutButton, ThemeSwitcher } from './Controls';

const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD'];

function useContextOptions() {
  const entities = useEntities();
  const scenarios = useScenarios();
  const settings = useSettings();
  return useMemo(() => {
    const entityOptions = [
      { value: 'all', label: 'All entities' },
      { value: 'personal', label: 'Personal' },
      ...(entities.data ?? [])
        .filter((e) => e.ownerControlled && e.kind !== 'person')
        .map((e) => ({ value: e.id, label: e.name })),
    ];
    const reporting = settings.data?.reportingCurrency ?? null;
    const currencies = [
      ...new Set([reporting, ...(entities.data ?? []).map((e) => e.baseCurrency), ...COMMON_CURRENCIES].filter((c): c is string => !!c)),
    ];
    const currencyOptions = [
      { value: 'default', label: reporting ? `${reporting} (default)` : 'Default currency' },
      ...currencies.filter((c) => c !== reporting).map((c) => ({ value: c, label: c })),
    ];
    const scenarioOptions = [
      { value: 'baseline', label: 'Baseline' },
      ...(scenarios.data ?? []).filter((s) => !s.archived).map((s) => ({ value: s.id, label: s.name })),
    ];
    return { entityOptions, currencyOptions, scenarioOptions, reporting };
  }, [entities.data, scenarios.data, settings.data]);
}

function ContextFields({ layout }: { layout: 'bar' | 'sheet' }) {
  const { ctx, update } = useFinanceContext();
  const { entityOptions, currencyOptions, scenarioOptions } = useContextOptions();
  const size = layout === 'bar' ? 'sm' : 'md';
  const hideLabel = layout === 'bar';
  return (
    <>
      <Select
        label="Entity scope"
        hideLabel={hideLabel}
        size={size}
        value={entityOptions.some((o) => o.value === ctx.entity) ? ctx.entity : 'all'}
        options={entityOptions}
        onValueChange={(v) => update({ entity: v })}
      />
      <Select
        label="Period"
        hideLabel={hideLabel}
        size={size}
        value={ctx.period}
        options={PERIOD_OPTIONS.map((p) => ({ value: p.value, label: p.label }))}
        onValueChange={(v) => update({ period: v as PeriodKey })}
      />
      <Select
        label="Reporting currency"
        hideLabel={hideLabel}
        size={size}
        value={ctx.currency ?? 'default'}
        options={currencyOptions}
        onValueChange={(v) => update({ currency: v === 'default' ? null : v })}
      />
      <Select
        label="Scenario"
        hideLabel={hideLabel}
        size={size}
        value={ctx.scenario ?? 'baseline'}
        options={scenarioOptions}
        onValueChange={(v) => update({ scenario: v === 'baseline' ? null : v })}
      />
    </>
  );
}

/** Desktop: inline context selects in the top bar. */
export function ContextBar() {
  return (
    <div className="fos-contextbar" role="group" aria-label="Finance context">
      <ContextFields layout="bar" />
    </div>
  );
}

/** Mobile: a compact button that opens the context sheet. */
export function ContextButton() {
  const [open, setOpen] = useState(false);
  const { ctx, params } = useFinanceContext();
  const { entityOptions, reporting } = useContextOptions();
  const entityLabel = entityOptions.find((o) => o.value === ctx.entity)?.label ?? 'All entities';
  const period = PERIOD_OPTIONS.find((p) => p.value === ctx.period)?.short ?? 'This month';
  const currency = ctx.currency ?? reporting;
  const summary = [entityLabel, period, currency].filter(Boolean).join(' · ');
  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      title="View"
      description="Choose what the figures cover. This stays in the page address, not on the device."
      trigger={
        <button type="button" className="fos-contextbtn" aria-label={`Change view: ${summary}${ctx.scenario ? ', scenario applied' : ''}`}>
          <span className="fos-contextbtn__icon" aria-hidden="true">
            <SlidersHorizontal size={16} />
          </span>
          <span className="fos-contextbtn__text">{summary}</span>
          {ctx.scenario && <span className="fos-badge fos-badge--sm fos-badge--info">Scenario</span>}
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <ContextFields layout="sheet" />
      </div>
      <div className="mt-8 flex flex-col gap-3 border-t border-border pt-5">
        <h3 className="text-sm font-medium text-ink-3">Workspace</h3>
        <ThemeSwitcher size="md" />
        <nav aria-label="Workspace" className="flex flex-col">
          <Link href={withContext('/settings', params)} variant="plain" className="flex min-h-11 items-center gap-3" onClick={() => setOpen(false)}>
            <Settings size={18} aria-hidden="true" /> Settings
          </Link>
          <Link href={withContext('/system', params)} variant="plain" className="flex min-h-11 items-center gap-3" onClick={() => setOpen(false)}>
            <Server size={18} aria-hidden="true" /> System
          </Link>
        </nav>
        <SignOutButton variant="full" />
      </div>
    </Drawer>
  );
}
