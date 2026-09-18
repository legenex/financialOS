import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Check, Plus, Radar, X } from 'lucide-react';
import type { Obligation, ObligationInput, RecurringItem, RecurringItemInput } from '@financialos/contracts';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  DataList,
  DateField,
  Drawer,
  EmptyState,
  Money,
  NumberField,
  Section,
  SegmentedControl,
  Select,
  StatusBadge,
  Switch,
  Table,
  TextField,
  useToast,
} from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useEntities, useObligations, useRecurring, useRecurringDecision, useSaveObligation, useSaveRecurring } from '../../lib/endpoints';
import { formatDate } from '../../lib/format';
import { CADENCE_LABEL, RECURRING_KIND_LABEL, entityOptions, minorUnits, primaryEntity, useCurrencyOptions } from './shared';

const OBLIGATION_KIND: Record<Obligation['kind'], string> = {
  bill: 'Bill',
  tax: 'Tax',
  purchase: 'Purchase',
  loan: 'Loan',
  transfer: 'Transfer',
  other: 'Other',
};

function AmountCell({ amount, estimate }: { amount: { amount: string | null; currency: string | null }; estimate?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <Money value={amount} unknownLabel="Amount unknown" unknownReason="No amount is recorded yet. It is not treated as zero." />
      {estimate && amount.amount !== null && <Badge>Estimate</Badge>}
    </span>
  );
}

interface RecurringDraft {
  name: string;
  entityId: string | null;
  counterparty: string;
  kind: RecurringItem['kind'];
  direction: 'in' | 'out';
  amount: string | null;
  amountUnknown: boolean;
  currency: string | null;
  amountIsEstimate: boolean;
  cadence: RecurringItem['cadence'];
  dayOfMonth: string | null;
  nextDueOn: string;
  status: 'active' | 'paused' | 'cancelled';
}

function RecurringEditor({ item, onClose }: { item: RecurringItem | null; onClose: () => void }) {
  const entities = useEntities();
  const { options: currencies, defaultCurrency } = useCurrencyOptions();
  const save = useSaveRecurring();
  const { toast } = useToast();
  const [d, setD] = useState<RecurringDraft>(() => ({
    name: item?.name ?? '',
    entityId: item?.entityId ?? null,
    counterparty: item?.counterparty ?? '',
    kind: item?.kind ?? 'bill',
    direction: item?.direction ?? 'out',
    amount: item?.amount.amount ?? null,
    amountUnknown: item ? item.amount.amount === null : false,
    currency: item?.amount.currency ?? null,
    amountIsEstimate: item?.amountIsEstimate ?? false,
    cadence: item?.cadence ?? 'monthly',
    dayOfMonth: item?.dayOfMonth ? String(item.dayOfMonth) : null,
    nextDueOn: item?.nextDueOn ?? '',
    status: item && item.status !== 'suggested' ? item.status : 'active',
  }));
  const set = <K extends keyof RecurringDraft>(key: K, value: RecurringDraft[K]) => setD((prev) => ({ ...prev, [key]: value }));
  const entityId = d.entityId ?? primaryEntity(entities.data)?.id ?? null;
  const currency = d.currency ?? defaultCurrency;
  const day = d.dayOfMonth ? Number.parseInt(d.dayOfMonth, 10) : null;
  const valid = d.name.trim() && entityId && currency && (d.amountUnknown || d.amount) && (day === null || (day >= 1 && day <= 31));

  const submit = () => {
    if (!valid || !entityId || !currency) return;
    const input: RecurringItemInput = {
      name: d.name.trim(),
      entityId,
      accountId: item?.accountId ?? null,
      counterparty: d.counterparty.trim() || null,
      kind: d.kind,
      direction: d.direction,
      amount: d.amountUnknown ? null : d.amount,
      currency,
      amountIsEstimate: d.amountUnknown ? false : d.amountIsEstimate,
      cadence: d.cadence,
      dayOfMonth: day,
      nextDueOn: d.nextDueOn || null,
      status: d.status,
      internalCounterpartyEntityId: item?.internalCounterpartyEntityId ?? null,
    };
    save.mutate(
      { id: item?.id ?? null, input },
      {
        onSuccess: () => {
          toast({ title: item ? 'Recurring item updated' : 'Recurring item added', tone: 'success' });
          onClose();
        },
      },
    );
  };

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={item ? `Edit ${item.name}` : 'Add a recurring item'}
      description="Bills, subscriptions, income and transfers that repeat."
      modalLock={save.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!valid}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {save.isError && <Callout tone="critical">{userMessage(save.error)}</Callout>}
        {entities.isError && <Callout tone="warning">Entities could not be loaded: {userMessage(entities.error)}</Callout>}
        <TextField label="Name" value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={120} required />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Belongs to" value={entityId} onValueChange={(v) => set('entityId', v)} options={entityOptions(entities.data)} placeholder={entities.isPending ? 'Loading…' : 'Choose'} />
          <Select label="Kind" value={d.kind} onValueChange={(v) => set('kind', v as RecurringItem['kind'])} options={Object.entries(RECURRING_KIND_LABEL).map(([value, label]) => ({ value, label }))} />
        </div>
        <div className="flex flex-col gap-2">
          <span className="fos-field__label">Direction</span>
          <SegmentedControl
            label="Direction"
            value={d.direction}
            onValueChange={(v) => set('direction', v)}
            options={[
              { value: 'out', label: 'Money out' },
              { value: 'in', label: 'Money in' },
            ]}
          />
        </div>
        <TextField label="Paid to / from" optional value={d.counterparty} onChange={(e) => set('counterparty', e.target.value)} maxLength={120} />
        <Checkbox label="Amount unknown" description="Keep it unknown rather than guessing. Safe-to-spend flags it as provisional." checked={d.amountUnknown} onCheckedChange={(v) => set('amountUnknown', v)} />
        {!d.amountUnknown && (
          <>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
              <NumberField label="Amount" value={d.amount} onValueChange={(v) => set('amount', v)} scale={minorUnits(currency)} prefix={currency ?? undefined} required />
              <Select label="Currency" value={currency} onValueChange={(v) => set('currency', v)} options={currencies} />
            </div>
            <Switch label="This is an estimate" checked={d.amountIsEstimate} onCheckedChange={(v) => set('amountIsEstimate', v)} />
          </>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Repeats" value={d.cadence} onValueChange={(v) => set('cadence', v as RecurringItem['cadence'])} options={Object.entries(CADENCE_LABEL).map(([value, label]) => ({ value, label }))} />
          <NumberField label="Day of month" optional value={d.dayOfMonth} onValueChange={(v) => set('dayOfMonth', v)} scale={0} hint="1–31" error={day !== null && (day < 1 || day > 31) ? 'Use a day from 1 to 31' : undefined} />
        </div>
        <DateField label="Next due" optional value={d.nextDueOn} onChange={(v) => set('nextDueOn', v)} />
        <Select
          label="Status"
          value={d.status}
          onValueChange={(v) => set('status', v as RecurringDraft['status'])}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'paused', label: 'Paused' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
        />
      </div>
    </Drawer>
  );
}

function ObligationEditor({ item, onClose }: { item: Obligation | null; onClose: () => void }) {
  const entities = useEntities();
  const { options: currencies, defaultCurrency } = useCurrencyOptions();
  const save = useSaveObligation();
  const { toast } = useToast();
  const [label, setLabel] = useState(item?.label ?? '');
  const [entity, setEntity] = useState<string | null>(item?.entityId ?? null);
  const [dueOn, setDueOn] = useState(item?.dueOn ?? '');
  const [amount, setAmount] = useState<string | null>(item?.amount.amount ?? null);
  const [unknown, setUnknown] = useState(item ? item.amount.amount === null : false);
  const [currencyChoice, setCurrency] = useState<string | null>(item?.amount.currency ?? null);
  const [kind, setKind] = useState<Obligation['kind']>(item?.kind ?? 'bill');
  const [status, setStatus] = useState<Obligation['status']>(item?.status ?? 'upcoming');
  const entityId = entity ?? primaryEntity(entities.data)?.id ?? null;
  const currency = currencyChoice ?? defaultCurrency;
  const valid = label.trim() && entityId && dueOn && currency && (unknown || amount);
  const submit = () => {
    if (!valid || !entityId || !currency) return;
    const input: ObligationInput = { entityId, dueOn, amount: unknown ? null : amount, currency, label: label.trim(), kind, status };
    save.mutate(
      { id: item?.id ?? null, input },
      {
        onSuccess: () => {
          toast({ title: item ? 'Obligation updated' : 'Obligation added', tone: 'success' });
          onClose();
        },
      },
    );
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={item ? `Edit ${item.label}` : 'Add a one-off obligation'}
      description="A dated payment that happens once, such as a tax bill or a deposit."
      modalLock={save.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!valid}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {save.isError && <Callout tone="critical">{userMessage(save.error)}</Callout>}
        <TextField label="What is it?" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} required />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Belongs to" value={entityId} onValueChange={setEntity} options={entityOptions(entities.data)} placeholder={entities.isPending ? 'Loading…' : 'Choose'} />
          <Select label="Kind" value={kind} onValueChange={(v) => setKind(v as Obligation['kind'])} options={Object.entries(OBLIGATION_KIND).map(([value, l]) => ({ value, label: l }))} />
        </div>
        <DateField label="Due on" value={dueOn} onChange={setDueOn} required />
        <Checkbox label="Amount unknown" checked={unknown} onCheckedChange={setUnknown} />
        {!unknown && (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <NumberField label="Amount" value={amount} onValueChange={setAmount} scale={minorUnits(currency)} prefix={currency ?? undefined} required />
            <Select label="Currency" value={currency} onValueChange={setCurrency} options={currencies} />
          </div>
        )}
        <Select
          label="Status"
          value={status}
          onValueChange={(v) => setStatus(v as Obligation['status'])}
          options={[
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'paid', label: 'Paid' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
        />
      </div>
    </Drawer>
  );
}

function Suggestions() {
  const suggested = useRecurring('suggested');
  const decide = useRecurringDecision();
  const { toast } = useToast();
  if (suggested.isPending || suggested.isError || suggested.data.length === 0) return null;
  return (
    <Section title="Detected — confirm or dismiss" description="Patterns FinancialOS noticed in your transactions. Nothing is added until you confirm.">
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {suggested.data.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="fos-datalist__leading" aria-hidden="true">
                <Radar size={18} />
              </span>
              <div className="min-w-0">
                <p className="font-medium break-words">{s.name}</p>
                <p className="text-sm text-ink-3">
                  {CADENCE_LABEL[s.cadence]}
                  {s.lastSeenOn ? ` · last seen ${formatDate(s.lastSeenOn, 'short')}` : ''} · <AmountCell amount={s.amount} estimate={s.amountIsEstimate} />
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<X size={16} />}
                loading={decide.isPending && decide.variables?.id === s.id && decide.variables.decision === 'dismiss'}
                onClick={() => decide.mutate({ id: s.id, decision: 'dismiss' }, { onSuccess: () => toast({ title: `Dismissed ${s.name}` }), onError: (e) => toast({ title: 'Could not dismiss', description: userMessage(e), tone: 'error' }) })}
              >
                Dismiss
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<Check size={16} />}
                loading={decide.isPending && decide.variables?.id === s.id && decide.variables.decision === 'confirm'}
                onClick={() => decide.mutate({ id: s.id, decision: 'confirm' }, { onSuccess: () => toast({ title: `Confirmed ${s.name}`, tone: 'success' }), onError: (e) => toast({ title: 'Could not confirm', description: userMessage(e), tone: 'error' }) })}
              >
                Confirm
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function CommitmentsTab() {
  const recurring = useRecurring(null);
  const obligations = useObligations();
  const [params] = useSearchParams();
  const [editRecurring, setEditRecurring] = useState<RecurringItem | 'new' | null>(null);
  const [editObligation, setEditObligation] = useState<Obligation | 'new' | null>(null);
  const focusRecurring = params.get('recurring');
  const focusObligation = params.get('obligation');

  return (
    <div className="flex flex-col gap-12">
      <Suggestions />
      <Section
        title="Recurring"
        description="Repeating bills, subscriptions, income and transfers."
        actions={
          <Button variant="secondary" size="sm" leadingIcon={<Plus size={16} />} onClick={() => setEditRecurring('new')}>
            Add recurring
          </Button>
        }
      >
        <QueryState
          query={recurring}
          loadingLabel="Loading recurring items"
          isEmpty={(list) => list.filter((r) => r.status !== 'suggested').length === 0}
          empty={<EmptyState size="sm" title="No recurring items" description="Add rent, salary, insurance and subscriptions so the plan can reserve for them." />}
        >
          {(list) => {
            const items = list.filter((r) => r.status !== 'suggested');
            const annual = items.filter((r) => r.kind === 'annual_bill' || r.cadence === 'annually');
            return (
              <div className="flex flex-col gap-8">
                <Table
                  caption="Recurring items"
                  hideCaption
                  rows={items}
                  getRowKey={(r) => r.id}
                  onRowClick={(r) => setEditRecurring(r)}
                  rowActionLabel={(r) => `Edit ${r.name}`}
                  columns={[
                    {
                      key: 'name',
                      header: 'Name',
                      primary: true,
                      cell: (r) => (
                        <span className={r.id === focusRecurring ? 'font-semibold text-accent-ink' : undefined}>
                          {r.name}
                          <span className="block text-sm text-ink-3">
                            {RECURRING_KIND_LABEL[r.kind]} · {r.direction === 'in' ? 'In' : 'Out'}
                            {r.counterparty ? ` · ${r.counterparty}` : ''}
                          </span>
                        </span>
                      ),
                    },
                    { key: 'amount', header: 'Amount', numeric: true, cell: (r) => <AmountCell amount={r.amount} estimate={r.amountIsEstimate} /> },
                    { key: 'cadence', header: 'Repeats', cell: (r) => CADENCE_LABEL[r.cadence] },
                    { key: 'next', header: 'Next due', cell: (r) => (r.nextDueOn ? formatDate(r.nextDueOn, 'short') : '—') },
                    {
                      key: 'status',
                      header: 'Status',
                      cell: (r) => <StatusBadge status={r.status === 'active' ? 'ok' : r.status} label={r.status === 'active' ? 'Active' : undefined} size="sm" />,
                    },
                  ]}
                />
                {annual.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-md font-semibold">Annual bills</h3>
                    <p className="mb-3 text-sm text-ink-3">Once-a-year costs. Consider a sinking fund so they don’t land all at once.</p>
                    <DataList
                      label="Annual bills"
                      items={annual.map((r) => ({
                        id: r.id,
                        title: r.name,
                        subtitle: r.nextDueOn ? `Next due ${formatDate(r.nextDueOn)}` : 'Due date not set',
                        value: <AmountCell amount={r.amount} estimate={r.amountIsEstimate} />,
                        onSelect: () => setEditRecurring(r),
                        actionLabel: `Edit ${r.name}`,
                      }))}
                    />
                  </div>
                )}
              </div>
            );
          }}
        </QueryState>
      </Section>

      <Section
        title="One-off obligations"
        description="Dated payments that happen once."
        actions={
          <Button variant="secondary" size="sm" leadingIcon={<Plus size={16} />} onClick={() => setEditObligation('new')}>
            Add obligation
          </Button>
        }
      >
        <QueryState
          query={obligations}
          loadingLabel="Loading obligations"
          isEmpty={(list) => list.length === 0}
          empty={<EmptyState size="sm" title="No one-off obligations" description="Add tax payments, deposits or planned purchases with a date." />}
        >
          {(list) => (
            <Table
              caption="One-off obligations"
              hideCaption
              rows={[...list].sort((a, b) => a.dueOn.localeCompare(b.dueOn))}
              getRowKey={(o) => o.id}
              onRowClick={(o) => setEditObligation(o)}
              rowActionLabel={(o) => `Edit ${o.label}`}
              columns={[
                {
                  key: 'label',
                  header: 'What',
                  primary: true,
                  cell: (o) => <span className={o.id === focusObligation ? 'font-semibold text-accent-ink' : undefined}>{o.label}</span>,
                },
                { key: 'due', header: 'Due', cell: (o) => formatDate(o.dueOn) },
                { key: 'amount', header: 'Amount', numeric: true, cell: (o) => <AmountCell amount={o.amount} /> },
                { key: 'kind', header: 'Kind', cell: (o) => OBLIGATION_KIND[o.kind] },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (o) => <StatusBadge status={o.status === 'paid' ? 'ok' : o.status === 'cancelled' ? 'cancelled' : 'open'} label={o.status === 'upcoming' ? 'Upcoming' : o.status === 'paid' ? 'Paid' : 'Cancelled'} size="sm" />,
                },
              ]}
            />
          )}
        </QueryState>
      </Section>

      {editRecurring && <RecurringEditor key={editRecurring === 'new' ? 'new' : editRecurring.id} item={editRecurring === 'new' ? null : editRecurring} onClose={() => setEditRecurring(null)} />}
      {editObligation && <ObligationEditor key={editObligation === 'new' ? 'new' : editObligation.id} item={editObligation === 'new' ? null : editObligation} onClose={() => setEditObligation(null)} />}
    </div>
  );
}
