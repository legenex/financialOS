import { useMemo } from 'react';
import { PauseCircle, PlayCircle, XCircle } from 'lucide-react';
import type { RecurringItem, RecurringItemInput } from '@financialos/contracts';
import { Badge, Button, Callout, Card, EmptyState, Link, Money, Section, Stat, StatusBadge, Table, useToast } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useRecurring, useSaveRecurring } from '../../lib/endpoints';
import { formatDate } from '../../lib/format';
import { CADENCE_LABEL } from './shared';

const SUBSCRIPTION_KINDS: ReadonlySet<RecurringItem['kind']> = new Set(['subscription', 'software']);

function toInput(item: RecurringItem): RecurringItemInput {
  return {
    name: item.name,
    entityId: item.entityId,
    accountId: item.accountId,
    counterparty: item.counterparty,
    kind: item.kind,
    direction: item.direction,
    amount: item.amount.amount,
    currency: item.amount.currency ?? 'USD',
    amountIsEstimate: item.amountIsEstimate,
    cadence: item.cadence,
    dayOfMonth: item.dayOfMonth,
    nextDueOn: item.nextDueOn,
    status: item.status === 'suggested' ? 'active' : item.status,
    internalCounterpartyEntityId: item.internalCounterpartyEntityId,
  };
}

function monthlyEquivalent(item: RecurringItem): number | null {
  if (item.amount.amount === null) return null;
  const amount = Number(item.amount.amount);
  switch (item.cadence) {
    case 'weekly':
      return amount * (52 / 12);
    case 'fortnightly':
      return amount * (26 / 12);
    case 'monthly':
      return amount;
    case 'quarterly':
      return amount / 3;
    case 'annually':
      return amount / 12;
    default:
      return null;
  }
}

export function SubscriptionsTab() {
  const recurring = useRecurring(null);
  const save = useSaveRecurring();
  const { toast } = useToast();

  const subscriptions = useMemo(
    () => (recurring.data ?? []).filter((r) => SUBSCRIPTION_KINDS.has(r.kind) && r.status !== 'cancelled' && r.status !== 'suggested'),
    [recurring.data],
  );

  const totalsByCurrency = useMemo(() => {
    const totals = new Map<string, number>();
    for (const s of subscriptions) {
      if (s.status !== 'active' || s.amount.currency === null) continue;
      const monthly = monthlyEquivalent(s);
      if (monthly === null) continue;
      totals.set(s.amount.currency, (totals.get(s.amount.currency) ?? 0) + monthly);
    }
    return [...totals.entries()];
  }, [subscriptions]);

  const setStatus = (item: RecurringItem, status: 'active' | 'paused' | 'cancelled') => {
    save.mutate(
      { id: item.id, input: { ...toInput(item), status } },
      { onSuccess: () => toast({ title: status === 'active' ? 'Resumed' : status === 'paused' ? 'Paused' : 'Cancelled', tone: 'success' }) },
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Callout tone="neutral">
        Subscriptions and recurring software costs, detected from your transactions or entered manually. Add or edit any recurring item — including
        new subscriptions — from <Link href="/plan/commitments">Commitments</Link>.
      </Callout>

      {totalsByCurrency.length > 0 && (
        <Card className="p-5">
          <div className="flex flex-wrap gap-8">
            {totalsByCurrency.map(([currency, amount]) => (
              <Stat key={currency} label={`Monthly cost (${currency})`} value={<Money value={{ amount: amount.toFixed(2), currency }} size="lg" weight="semibold" />} />
            ))}
            <Stat label="Active subscriptions" value={String(subscriptions.filter((s) => s.status === 'active').length)} />
          </div>
        </Card>
      )}

      <QueryState
        query={recurring}
        loadingLabel="Loading subscriptions"
        isEmpty={() => subscriptions.length === 0}
        empty={
          <EmptyState
            title="No subscriptions detected yet"
            description="FinancialOS detects recurring subscriptions from imported transactions, or you can add one directly in Commitments."
            actions={<Link href="/plan/commitments">Go to Commitments</Link>}
          />
        }
      >
        {() => (
          <Section title="Subscriptions">
            {save.isError && <Callout tone="critical">{userMessage(save.error)}</Callout>}
            <Table
              caption="Subscriptions"
              hideCaption
              rows={subscriptions}
              getRowKey={(s) => s.id}
              columns={[
                {
                  key: 'name',
                  header: 'Subscription',
                  primary: true,
                  cell: (s) => (
                    <span className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {s.name}
                        {!s.confirmed && <Badge tone="caution">Detected</Badge>}
                      </span>
                      {s.counterparty && <span className="text-sm text-ink-3">{s.counterparty}</span>}
                    </span>
                  ),
                },
                { key: 'cadence', header: 'Cadence', hideOnMobile: true, cell: (s) => CADENCE_LABEL[s.cadence] },
                { key: 'amount', header: 'Amount', numeric: true, cell: (s) => <Money value={s.amount} unknownReason="Amount not yet confirmed." /> },
                { key: 'next', header: 'Next due', hideOnMobile: true, cell: (s) => (s.nextDueOn ? formatDate(s.nextDueOn) : '—') },
                { key: 'status', header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
                {
                  key: 'actions',
                  header: <span className="fos-sr-only">Actions</span>,
                  align: 'end',
                  cell: (s) => (
                    <span className="inline-flex gap-1">
                      {s.status === 'active' ? (
                        <button type="button" className="fos-table__action" aria-label={`Pause ${s.name}`} onClick={() => setStatus(s, 'paused')}>
                          <PauseCircle size={15} aria-hidden="true" />
                        </button>
                      ) : (
                        <button type="button" className="fos-table__action" aria-label={`Resume ${s.name}`} onClick={() => setStatus(s, 'active')}>
                          <PlayCircle size={15} aria-hidden="true" />
                        </button>
                      )}
                      <button type="button" className="fos-table__action" aria-label={`Cancel ${s.name}`} onClick={() => setStatus(s, 'cancelled')}>
                        <XCircle size={15} aria-hidden="true" />
                      </button>
                    </span>
                  ),
                },
              ]}
            />
          </Section>
        )}
      </QueryState>
    </div>
  );
}
