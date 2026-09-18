import { useState } from 'react';
import { Clock3, X } from 'lucide-react';
import type { ExceptionItem, ExceptionKind } from '@financialos/contracts';
import {
  Button,
  Callout,
  Drawer,
  EmptyState,
  Link,
  NumberField,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  TextArea,
  useToast,
} from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useResolveException, useExceptions } from '../../lib/endpoints';

const KIND_LABEL: Record<ExceptionKind, string> = {
  unclassified: 'Uncategorised transaction',
  ownership_uncertain: 'Unknown ownership',
  fee_policy_unconfirmed: 'Unconfirmed third-party fee policy',
  reconciliation_discrepancy: 'Reconciliation difference',
  reconciliation_question: 'Reconciliation question',
  missing_period: 'Missing account history',
  possible_duplicate: 'Possible duplicate',
  transfer_match_review: 'Unmatched transfer',
  stale_connection: 'Stale connection',
  sync_error: 'Sync error',
  valuation_unverified: 'Unknown balance',
  restriction_unverified: 'Unverified restriction',
  interest_unverified: 'Unverified interest terms',
  missing_information: 'Missing information',
  tax_fact_unconfirmed: 'Unconfirmed tax fact',
  fx_rate_missing: 'Missing exchange rate',
  import_error: 'Import problem',
  unusual_transaction: 'Unusual transaction',
  agent_suggestion: 'Agent suggestion',
};

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'snoozed', label: 'Snoozed' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: '', label: 'All' },
];

const KIND_OPTIONS = [{ value: '', label: 'All kinds' }, ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))];

function ResolveDrawer({ item, onClose }: { item: ExceptionItem | null; onClose: () => void }) {
  const resolve = useResolveException();
  const { toast } = useToast();
  const [note, setNote] = useState('');
  const [snoozeDays, setSnoozeDays] = useState<string | null>('7');
  if (!item) return null;

  const act = (action: 'resolve' | 'dismiss' | 'snooze' | 'reopen') => {
    resolve.mutate(
      { id: item.id, input: { action, note: note.trim() || null, ...(action === 'snooze' ? { snoozeDays: Number(snoozeDays ?? '7') || 7 } : {}) } },
      {
        onSuccess: () => {
          toast({
            title: action === 'resolve' ? 'Marked resolved' : action === 'dismiss' ? 'Dismissed' : action === 'snooze' ? 'Snoozed' : 'Reopened',
            tone: 'success',
          });
          setNote('');
          onClose();
        },
      },
    );
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={item.title}
      description={KIND_LABEL[item.kind]}
      modalLock={resolve.isPending}
      footer={
        <>
          {item.status === 'open' && (
            <>
              <Button variant="ghost" leadingIcon={<Clock3 size={16} />} onClick={() => act('snooze')} loading={resolve.isPending}>
                Snooze
              </Button>
              <Button variant="secondary" leadingIcon={<X size={16} />} onClick={() => act('dismiss')} loading={resolve.isPending}>
                Dismiss
              </Button>
              <Button variant="primary" onClick={() => act('resolve')} loading={resolve.isPending}>
                Mark resolved
              </Button>
            </>
          )}
          {item.status !== 'open' && (
            <Button variant="secondary" onClick={() => act('reopen')} loading={resolve.isPending}>
              Reopen
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {resolve.isError && <Callout tone="critical">{userMessage(resolve.error)}</Callout>}
        <div className="flex items-center gap-2">
          <StatusBadge status={item.severity} />
          <StatusBadge status={item.status} />
        </div>
        <p className="text-sm text-ink-2">{item.detail}</p>
        {item.subject.label && (
          <p className="text-sm text-ink-3">
            Related: {item.subject.label} ({item.subject.type})
          </p>
        )}
        {item.suggestedActions.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink-2">Suggested actions</span>
            <div className="flex flex-wrap gap-3">
              {item.suggestedActions.map((a) =>
                a.href ? (
                  <Link key={a.id} href={a.href}>
                    {a.label}
                  </Link>
                ) : (
                  <span key={a.id} className="text-sm text-ink-3">
                    {a.label}
                  </span>
                ),
              )}
            </div>
          </div>
        )}
        {item.resolution && <p className="text-sm text-ink-3">Previous resolution note: {item.resolution}</p>}
        {item.status === 'open' && (
          <NumberField label="Snooze for (days)" value={snoozeDays} onValueChange={setSnoozeDays} scale={0} suffix="days" hint="1–90" />
        )}
        <TextArea label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={3} />
      </div>
    </Drawer>
  );
}

export function Component() {
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<ExceptionItem | null>(null);
  const exceptions = useExceptions(status || null, kind || null, { poll: true });

  return (
    <>
      <PageHeader title="Inbox" description="Things FinancialOS noticed but can't resolve on its own: uncertain ownership, possible duplicates, stale connections and more." />
      <div className="flex flex-wrap items-end gap-3 mb-6">
        <Select label="Status" hideLabel value={status} onValueChange={(v) => setStatus(v ?? '')} options={STATUS_OPTIONS} />
        <Select label="Kind" hideLabel value={kind} onValueChange={(v) => setKind(v ?? '')} options={KIND_OPTIONS} placeholder="All kinds" />
      </div>
      <QueryState
        query={exceptions}
        loadingLabel="Loading inbox"
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            title={status === 'open' ? 'Inbox zero' : 'Nothing here'}
            description={status === 'open' ? 'No open exceptions right now. FinancialOS will flag anything that needs your attention.' : 'No exceptions match this filter.'}
          />
        }
      >
        {(list) => (
          <Table
            caption="Exceptions"
            hideCaption
            rows={list}
            getRowKey={(item) => item.id}
            onRowClick={setSelected}
            rowActionLabel={(item) => `Open ${item.title}`}
            columns={[
              {
                key: 'title',
                header: 'Exception',
                primary: true,
                cell: (item) => (
                  <span className="flex flex-col gap-1.5">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {item.title}
                      <StatusBadge status={item.severity} size="sm" />
                    </span>
                    <span className="text-sm text-ink-3">{KIND_LABEL[item.kind]}</span>
                  </span>
                ),
              },
              { key: 'status', header: 'Status', cell: (item) => <StatusBadge status={item.status} /> },
              { key: 'updated', header: 'Updated', hideOnMobile: true, cell: (item) => new Date(item.updatedAt).toLocaleDateString() },
            ]}
          />
        )}
      </QueryState>
      <ResolveDrawer item={selected} onClose={() => setSelected(null)} />
    </>
  );
}
