import { Link as RouterLink } from 'react-router';
import { Button, Callout, Card, Donut, EmptyState, Freshness, Link, Money, Section, StatusBadge } from '@financialos/ui';
import { ExplanationDrawer } from '../../components/ExplanationDrawer';
import { QueryState } from '../../components/QueryState';
import { useAccounts } from '../../lib/endpoints';
import { useWealth } from './api';
import { useState } from 'react';

export function OverviewTab() {
  const wealth = useWealth();
  const accounts = useAccounts();
  const [explain, setExplain] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      <QueryState query={wealth} loadingLabel="Loading net worth">
        {(w) => {
          const segments = w.segments
            .filter((s) => s.total !== null)
            .map((s) => ({ key: s.liquidityClass, label: s.label, value: { amount: s.total!.amount, currency: s.total!.currency } }));
          return (
            <Section
              title="Net worth"
              actions={
                <Button variant="ghost" size="sm" onClick={() => setExplain(true)}>
                  How this is calculated
                </Button>
              }
            >
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Money value={w.netWorthKnown} size="lg" weight="semibold" unknownReason="Not enough verified balances yet." />
                  <StatusBadge status={w.status} />
                </div>
                {w.excludedThirdParty && (
                  <p className="text-sm text-ink-3">
                    Excludes <Money value={w.excludedThirdParty} /> economically owned by third parties.
                  </p>
                )}
                <Donut title="By liquidity" hideTitle segments={segments} currency={w.currency} totalLabel="Net worth" emptyDescription="Add accounts to see a breakdown." />
              </div>
              <ExplanationDrawer open={explain} onOpenChange={setExplain} title="How net worth is calculated" explanation={w.explanation} status={w.status} />
            </Section>
          );
        }}
      </QueryState>

      <QueryState
        query={accounts}
        loadingLabel="Loading accounts"
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            title="No accounts yet"
            description="Add your first account to start tracking balances, or connect a provider from Connections."
            actions={
              <Button asChild variant="primary">
                <RouterLink to="/money/accounts">Add an account</RouterLink>
              </Button>
            }
          />
        }
      >
        {(list) => (
          <Section title="Data freshness" actions={<Link href="/money/accounts">See all accounts</Link>}>
            {list.some((a) => a.freshness.state === 'stale' || a.freshness.state === 'never') && (
              <Callout tone="warning">Some accounts have not been updated recently. Figures for them may be out of date.</Callout>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((a) => (
                <Card key={a.id} className="flex flex-col gap-2 p-4">
                  <span className="font-medium truncate">{a.name}</span>
                  <Money value={a.valuation.value} unknownReason="Balance unknown." />
                  <Freshness state={a.freshness.state} lastUpdatedAt={a.freshness.lastUpdatedAt} label={a.freshness.label} compact />
                </Card>
              ))}
            </div>
          </Section>
        )}
      </QueryState>
    </div>
  );
}
