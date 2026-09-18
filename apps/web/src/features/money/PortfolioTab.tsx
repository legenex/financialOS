import { Callout, Donut, KeyValue, Money, ProgressBar, Section, Stat, StatusBadge, Table } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { usePortfolio } from './api';

export function PortfolioTab() {
  const portfolio = usePortfolio();
  return (
    <QueryState query={portfolio} loadingLabel="Loading portfolio">
      {(p) => (
        <div className="flex flex-col gap-8">
          <div className="flex flex-wrap items-center gap-4">
            <Stat label="Marketable investments" value={<Money value={p.totalMarketable} size="lg" weight="semibold" unknownReason="Holdings not fully known yet." />} />
            <StatusBadge status={p.status} />
          </div>

          <Section title="Allocation">
            <Donut
              title="Allocation"
              hideTitle
              segments={p.allocation.map((a) => ({ key: a.label, label: a.label, value: a.value }))}
              currency={p.currency}
              emptyDescription="Add investment accounts to see an allocation breakdown."
            />
          </Section>

          {p.currencyExposure.length > 0 && (
            <Section title="Currency exposure">
              <div className="flex flex-col gap-2">
                {p.currencyExposure.map((c) => (
                  <div key={c.currency} className="flex items-center justify-between gap-3 text-sm">
                    <span>{c.currency}</span>
                    <span className="flex items-center gap-3">
                      <Money value={c.value} />
                      <span className="text-ink-3">{c.share}%</span>
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {p.concentration.length > 0 && (
            <Section title="Concentration">
              <div className="flex flex-col gap-2">
                {p.concentration.map((c) => (
                  <div key={c.label} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-sm">
                      <span>{c.label}</span>
                      <span className={c.warning ? 'text-negative' : 'text-ink-3'}>{c.share}%</span>
                    </div>
                    <ProgressBar label={c.label} hideLabel size="sm" value={Number(c.share) / 100} tone={c.warning ? 'negative' : 'accent'} />
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Income & performance">
            <div className="grid gap-6 sm:grid-cols-2">
              <KeyValue
                layout="grid"
                items={[
                  { key: 'div', label: 'Dividends', value: <Money value={p.income.dividends} unknownReason="Not recorded." /> },
                  { key: 'int', label: 'Interest', value: <Money value={p.income.interest} unknownReason="Not recorded." /> },
                  { key: 'fees', label: 'Fees', value: <Money value={p.income.fees} unknownReason="Not recorded." /> },
                ]}
              />
              <div className="flex flex-col gap-2">
                {p.performance.value !== null ? (
                  <Stat label={`Performance (${p.performance.method.replace('_', '-')})`} value={`${p.performance.value}%`} />
                ) : (
                  <Callout tone="neutral">{p.performance.reasonUnavailable ?? 'Performance cannot be calculated yet.'}</Callout>
                )}
              </div>
            </div>
          </Section>

          {p.restricted.length > 0 && (
            <Section title="Restricted holdings">
              <Table
                caption="Restricted holdings"
                hideCaption
                rows={p.restricted}
                getRowKey={(r) => `${r.accountId}-${r.instrument}`}
                columns={[
                  { key: 'instrument', header: 'Instrument', primary: true, cell: (r) => r.instrument },
                  { key: 'quantity', header: 'Quantity', cell: (r) => r.quantity ?? '—' },
                  { key: 'value', header: 'Indicative value', numeric: true, cell: (r) => <Money value={r.indicativeValue} unknownReason="No verified price." /> },
                  { key: 'status', header: 'Verification', cell: (r) => <StatusBadge status={r.restrictionStatus === 'verified' ? 'ok' : 'provisional'} label={r.restrictionStatus.replace(/_/g, ' ')} /> },
                ]}
              />
              <p className="text-sm text-ink-3 mt-2">Restricted holdings are excluded from safe-to-spend and runway. Values are indicative, not proceeds.</p>
            </Section>
          )}
        </div>
      )}
    </QueryState>
  );
}
