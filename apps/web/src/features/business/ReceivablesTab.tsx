import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ReceivablePayable, ReceivablePayableInput } from '@financialos/contracts';
import { Badge, Button, Callout, DateField, Dialog, EmptyState, Money, NumberField, Select, Table, TextField, useToast } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useEntities } from '../../lib/endpoints';
import { useCreateReceivable, useReceivablesPayables, useUpdateReceivable } from './api';

const CATEGORY_OPTIONS = ['sales', 'payroll', 'software', 'overhead', 'refund', 'tax', 'intercompany', 'owner', 'other'].map((v) => ({ value: v, label: v }));
const STATUS_OPTIONS = ['open', 'partial', 'paid', 'written_off', 'cancelled'].map((v) => ({ value: v, label: v.replace(/_/g, ' ') }));

function emptyInput(entityId: string): ReceivablePayableInput {
  return {
    entityId,
    kind: 'receivable',
    counterparty: '',
    intercompanyEntityId: null,
    reference: null,
    amount: '',
    currency: 'USD',
    outstanding: null,
    issuedOn: null,
    dueOn: null,
    expectedOn: null,
    probability: '1',
    status: 'open',
    category: 'sales',
  };
}

function Editor({ open, onOpenChange, defaultEntityId }: { open: boolean; onOpenChange: (open: boolean) => void; defaultEntityId: string }) {
  const entities = useEntities();
  const create = useCreateReceivable();
  const [draft, setDraft] = useState<ReceivablePayableInput>(() => emptyInput(defaultEntityId));
  const valid = draft.entityId && draft.counterparty.trim().length > 0 && draft.amount.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setDraft(emptyInput(defaultEntityId));
      }}
      title="Record a receivable or payable"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={create.isPending}
            onClick={() =>
              create.mutate(draft, {
                onSuccess: () => onOpenChange(false),
              })
            }
          >
            Record
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {create.isError && <Callout tone="critical">{userMessage(create.error)}</Callout>}
        <Select label="Entity" value={draft.entityId} onValueChange={(v) => v && setDraft((d) => ({ ...d, entityId: v }))} options={(entities.data ?? []).map((e) => ({ value: e.id, label: e.name }))} required />
        <Select label="Kind" value={draft.kind} onValueChange={(v) => setDraft((d) => ({ ...d, kind: (v as ReceivablePayableInput['kind']) ?? d.kind }))} options={[{ value: 'receivable', label: 'Receivable' }, { value: 'payable', label: 'Payable' }]} />
        <TextField label="Counterparty" value={draft.counterparty} onChange={(e) => setDraft((d) => ({ ...d, counterparty: e.target.value }))} required maxLength={120} />
        <div className="flex items-end gap-2">
          <NumberField label="Amount" value={draft.amount} onValueChange={(v) => setDraft((d) => ({ ...d, amount: v ?? '' }))} prefix={draft.currency} />
          <TextField label="Currency" hideLabel value={draft.currency} onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value.toUpperCase() }))} className="w-24" maxLength={10} />
        </div>
        <Select label="Category" value={draft.category} onValueChange={(v) => setDraft((d) => ({ ...d, category: (v as ReceivablePayableInput['category']) ?? d.category }))} options={CATEGORY_OPTIONS} />
        <Select label="Status" value={draft.status} onValueChange={(v) => setDraft((d) => ({ ...d, status: (v as ReceivablePayableInput['status']) ?? d.status }))} options={STATUS_OPTIONS} />
        <div className="grid grid-cols-2 gap-3">
          <DateField label="Issued on" value={draft.issuedOn ?? ''} onChange={(v) => setDraft((d) => ({ ...d, issuedOn: v || null }))} />
          <DateField label="Due on" value={draft.dueOn ?? ''} onChange={(v) => setDraft((d) => ({ ...d, dueOn: v || null }))} />
        </div>
        <TextField label="Reference (optional)" value={draft.reference ?? ''} onChange={(e) => setDraft((d) => ({ ...d, reference: e.target.value || null }))} maxLength={80} />
      </div>
    </Dialog>
  );
}

export function ReceivablesTab() {
  const [kind, setKind] = useState<'receivable' | 'payable' | ''>('');
  const list = useReceivablesPayables(null, kind || null);
  const [open, setOpen] = useState(false);
  const update = useUpdateReceivable();
  const { toast } = useToast();

  const markStatus = (row: ReceivablePayable, status: ReceivablePayable['status']) =>
    update.mutate({ id: row.id, status }, { onSuccess: () => toast({ title: 'Updated', tone: 'success' }) });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Select
          label="Kind"
          hideLabel
          value={kind}
          onValueChange={(v) => setKind((v as 'receivable' | 'payable' | '') ?? '')}
          options={[{ value: '', label: 'All' }, { value: 'receivable', label: 'Receivables' }, { value: 'payable', label: 'Payables' }]}
        />
        <Button variant="primary" leadingIcon={<Plus size={16} />} onClick={() => setOpen(true)}>
          Record receivable or payable
        </Button>
      </div>

      <QueryState
        query={list}
        loadingLabel="Loading receivables and payables"
        isEmpty={(items) => items.length === 0}
        empty={<EmptyState title="Nothing recorded yet" description="Record an invoice owed to you or a bill you owe." />}
      >
        {(items) => (
          <Table
            caption="Receivables and payables"
            hideCaption
            rows={items}
            getRowKey={(r) => r.id}
            columns={[
              {
                key: 'counterparty',
                header: 'Counterparty',
                primary: true,
                cell: (r) => (
                  <span className="flex flex-col gap-1">
                    <span className="font-medium">{r.counterparty}</span>
                    <span className="text-sm text-ink-3">
                      {r.kind} · {r.category.replace(/_/g, ' ')}
                    </span>
                  </span>
                ),
              },
              { key: 'outstanding', header: 'Outstanding', numeric: true, cell: (r) => <Money value={r.outstanding} /> },
              { key: 'due', header: 'Due', hideOnMobile: true, cell: (r) => r.dueOn ?? '—' },
              { key: 'status', header: 'Status', cell: (r) => <Badge tone={r.status === 'open' ? 'info' : r.status === 'paid' ? 'positive' : r.status === 'written_off' || r.status === 'cancelled' ? 'negative' : 'caution'}>{r.status.replace(/_/g, ' ')}</Badge> },
              {
                key: 'actions',
                header: <span className="fos-sr-only">Actions</span>,
                align: 'end',
                cell: (r) =>
                  r.status === 'open' || r.status === 'partial' ? (
                    <Button variant="ghost" size="sm" onClick={() => markStatus(r, 'paid')}>
                      Mark paid
                    </Button>
                  ) : null,
              },
            ]}
          />
        )}
      </QueryState>

      <Editor open={open} onOpenChange={setOpen} defaultEntityId="" />
    </div>
  );
}
