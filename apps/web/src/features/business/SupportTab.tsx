import { Card, DataList, EmptyState, Money } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { useEntities } from '../../lib/endpoints';
import { useSupportTracker } from './api';

export function SupportTab() {
  const support = useSupportTracker();
  const entities = useEntities();
  const nameOf = (id: string) => entities.data?.find((e) => e.id === id)?.name ?? 'Unknown';

  return (
    <QueryState
      query={support}
      loadingLabel="Loading owner support"
      isEmpty={(s) => s.entries.length === 0}
      empty={<EmptyState title="No owner support recorded" description="Contributions, drawings and inter-entity loans appear here once transactions are classified as such." />}
    >
      {(s) => (
        <div className="flex flex-col gap-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {s.totalsByEntity.map((t) => (
              <Card key={t.entityId} className="flex flex-col gap-2 p-4">
                <span className="font-medium">{t.name}</span>
                <Money value={t.netSupport} size="lg" signed />
                <span className="text-sm text-ink-3">Net support received (positive) or given (negative)</span>
              </Card>
            ))}
          </div>
          <DataList
            label="Support movements"
            items={s.entries.map((e, i) => ({
              id: e.transactionId ?? `${e.date}-${i}`,
              title: `${nameOf(e.fromEntityId)} → ${nameOf(e.toEntityId)}`,
              subtitle: `${e.nature.replace(/_/g, ' ')} · ${e.date}${e.note ? ` · ${e.note}` : ''}`,
              value: <Money value={e.amount} />,
            }))}
          />
        </div>
      )}
    </QueryState>
  );
}
