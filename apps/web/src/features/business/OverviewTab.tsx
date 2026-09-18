import { useState } from 'react';
import { Badge, Button, Card, EmptyState, Money, Section, StatusBadge } from '@financialos/ui';
import { ExplanationDrawer } from '../../components/ExplanationDrawer';
import { QueryState } from '../../components/QueryState';
import { useBusinessEntities, useConsolidatedView } from './api';

export function OverviewTab() {
  const entities = useBusinessEntities();
  const consolidated = useConsolidatedView();
  const [explain, setExplain] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      <QueryState query={consolidated} loadingLabel="Loading the consolidated view">
        {(view) => (
          <Section
            title="Consolidated cash (economic view)"
            description="Every entity you control, intercompany movements eliminated, third-party money excluded."
            actions={
              <Button variant="ghost" size="sm" onClick={() => setExplain(true)}>
                How this is calculated
              </Button>
            }
          >
            <div className="flex flex-wrap items-center gap-3">
              <Money value={view.cash} size="lg" weight="semibold" unknownReason="Not enough verified balances yet." />
              <StatusBadge status={view.status} />
            </div>
            {view.thirdPartyExcluded && (
              <p className="text-sm text-ink-3">
                Excludes <Money value={view.thirdPartyExcluded} /> economically owned by third parties.
              </p>
            )}
            {view.eliminated.length > 0 && (
              <p className="text-sm text-ink-3">
                Eliminated {view.eliminated.length} intercompany item{view.eliminated.length === 1 ? '' : 's'} so they are not double-counted.
              </p>
            )}
            <ExplanationDrawer open={explain} onOpenChange={setExplain} title="How consolidated cash is calculated" explanation={view.explanation} status={view.status} />
          </Section>
        )}
      </QueryState>

      <QueryState
        query={entities}
        loadingLabel="Loading entities"
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No business entities yet" description="Add a company or trust from the button above to track it on a cash basis." />}
      >
        {(list) => (
          <Section title="By entity (cash basis)">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((e) => (
                <Card key={e.entityId} className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{e.name}</span>
                    <StatusBadge status={e.cashStatus} />
                  </div>
                  <Money value={e.cash} size="lg" unknownReason="Not enough verified balances yet." />
                  <div className="flex flex-wrap gap-4 text-sm text-ink-3">
                    <span>
                      In: <Money value={e.periodIn} />
                    </span>
                    <span>
                      Out: <Money value={e.periodOut} />
                    </span>
                  </div>
                  {(e.receivablesOpen || e.payablesOpen) && (
                    <div className="flex flex-wrap gap-4 text-sm text-ink-3">
                      {e.receivablesOpen && (
                        <span>
                          Receivables: <Money value={e.receivablesOpen} />
                        </span>
                      )}
                      {e.payablesOpen && (
                        <span>
                          Payables: <Money value={e.payablesOpen} />
                        </span>
                      )}
                    </div>
                  )}
                  {e.unclassifiedCount > 0 && <Badge tone="caution">{e.unclassifiedCount} unclassified</Badge>}
                  <p className="text-xs text-ink-3">{e.disclaimer}</p>
                </Card>
              ))}
            </div>
          </Section>
        )}
      </QueryState>
    </div>
  );
}
