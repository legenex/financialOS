import { AreaTimeline, Callout, Select, StatusBadge } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { useEntities } from '../../lib/endpoints';
import { useCashForecast } from './api';
import { useState } from 'react';

export function ForecastTab() {
  const entities = useEntities();
  const businessEntities = (entities.data ?? []).filter((e) => e.kind !== 'person');
  const [entityId, setEntityId] = useState<string | null>(null);
  const forecast = useCashForecast({ entityId });

  return (
    <div className="flex flex-col gap-6">
      <Select
        label="Entity"
        value={entityId}
        onValueChange={setEntityId}
        options={[{ value: '', label: 'Consolidated (all entities)' }, ...businessEntities.map((e) => ({ value: e.id, label: e.name }))]}
        className="max-w-xs"
      />
      <QueryState query={forecast} loadingLabel="Loading the 13-week forecast">
        {(f) => (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={f.status} />
              {f.lowestClosing && f.lowestClosingWeek && (
                <span className="text-sm text-ink-3">
                  Lowest projected: {f.lowestClosing.amount} {f.lowestClosing.currency} in the week of {f.lowestClosingWeek}
                </span>
              )}
            </div>
            {f.warnings.map((w) => (
              <Callout key={w} tone="warning">
                {w}
              </Callout>
            ))}
            <AreaTimeline
              title={f.label}
              currency={f.currency}
              lowest={f.lowestClosing && f.lowestClosingWeek ? { date: f.lowestClosingWeek, balance: f.lowestClosing } : null}
              events={f.weeks.map((w) => ({
                date: w.weekEnd,
                label: `Week of ${w.weekStart}`,
                change: { amount: (Number(w.inflows.amount) - Number(w.outflows.amount)).toFixed(2), currency: w.closingBalance.currency },
                balanceAfter: w.closingBalance,
              }))}
              emptyDescription="The forecast appears once current balances and recurring commitments are known."
            />
          </div>
        )}
      </QueryState>
    </div>
  );
}
