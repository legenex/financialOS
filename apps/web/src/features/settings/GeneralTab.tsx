import { useEffect, useState } from 'react';
import type { AppSettings } from '@financialos/contracts';
import { Button, Callout, NumberField, Section, Select, Switch, TextField, useToast } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useSettings } from '../../lib/endpoints';
import { useSaveSettings } from './api';

function Editor({ settings }: { settings: AppSettings }) {
  const [draft, setDraft] = useState(settings);
  const save = useSaveSettings();
  const { toast } = useToast();

  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  return (
    <div className="flex flex-col gap-8">
      <Section title="Currencies & timezone">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Reporting currency" value={draft.reportingCurrency} onChange={(e) => setDraft((d) => ({ ...d, reportingCurrency: e.target.value.toUpperCase() }))} maxLength={10} />
          <TextField label="Budget currency" value={draft.budgetCurrency} onChange={(e) => setDraft((d) => ({ ...d, budgetCurrency: e.target.value.toUpperCase() }))} maxLength={10} />
          <TextField label="Reporting timezone" value={draft.reportingTimezone} onChange={(e) => setDraft((d) => ({ ...d, reportingTimezone: e.target.value }))} placeholder="Africa/Johannesburg" />
          <Select label="Week starts on" value={draft.weekStartsOn} onValueChange={(v) => setDraft((d) => ({ ...d, weekStartsOn: (v as AppSettings['weekStartsOn']) ?? d.weekStartsOn }))} options={[{ value: 'monday', label: 'Monday' }, { value: 'sunday', label: 'Sunday' }]} />
        </div>
      </Section>

      <Section title="Safe-to-spend">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Horizon (days)" value={String(draft.safeToSpendHorizonDays)} onValueChange={(v) => setDraft((d) => ({ ...d, safeToSpendHorizonDays: v ? Math.round(Number(v)) : d.safeToSpendHorizonDays }))} />
          <Select
            label="Horizon basis"
            value={draft.safeToSpendHorizonBasis}
            onValueChange={(v) => setDraft((d) => ({ ...d, safeToSpendHorizonBasis: (v as AppSettings['safeToSpendHorizonBasis']) ?? d.safeToSpendHorizonBasis }))}
            options={[{ value: 'fixed_days', label: 'Fixed number of days' }, { value: 'next_income', label: 'Until next income' }]}
          />
        </div>
        <Switch label="Include near-cash accounts" description="Money-market and similar accounts count toward safe-to-spend." checked={draft.includeNearCashInSafeToSpend} onCheckedChange={(v) => setDraft((d) => ({ ...d, includeNearCashInSafeToSpend: v }))} />
      </Section>

      <Section title="Freshness & privacy">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Stale after (hours)" value={String(draft.staleAfterHours)} onValueChange={(v) => setDraft((d) => ({ ...d, staleAfterHours: v ? Math.round(Number(v)) : d.staleAfterHours }))} />
          <NumberField label="Minimum runway history (months)" value={String(draft.runwayMinimumHistoryMonths)} onValueChange={(v) => setDraft((d) => ({ ...d, runwayMinimumHistoryMonths: v ? Math.round(Number(v)) : d.runwayMinimumHistoryMonths }))} />
        </div>
        <Switch label="Privacy mode by default" description="Hide amounts on screen until you choose to reveal them." checked={draft.privacyModeDefault} onCheckedChange={(v) => setDraft((d) => ({ ...d, privacyModeDefault: v }))} />
        <Switch label="Allow cloud AI providers" description="Off by default. Required before a cloud AI provider can be enabled." checked={draft.cloudAiAllowed} onCheckedChange={(v) => setDraft((d) => ({ ...d, cloudAiAllowed: v }))} />
        <Switch label="Public market data" description="Fetch public prices for instruments with no other valuation source." checked={draft.publicMarketDataEnabled} onCheckedChange={(v) => setDraft((d) => ({ ...d, publicMarketDataEnabled: v }))} />
      </Section>

      {save.isError && <Callout tone="critical">{userMessage(save.error)}</Callout>}
      <div>
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft, { onSuccess: () => toast({ title: 'Settings saved', tone: 'success' }) })}>
          Save changes
        </Button>
      </div>
    </div>
  );
}

export function GeneralTab() {
  const settings = useSettings();
  return (
    <QueryState query={settings} loadingLabel="Loading settings">
      {(s) => <Editor settings={s} />}
    </QueryState>
  );
}
