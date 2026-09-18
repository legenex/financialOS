import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Pencil, Plane, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { Goal, GoalInput } from '@financialos/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  DataList,
  DateField,
  Dialog,
  Drawer,
  EmptyState,
  KeyValue,
  Link,
  Money,
  NumberField,
  ProgressBar,
  RadioGroup,
  SegmentedControl,
  Select,
  Skeleton,
  StatusBadge,
  Switch,
  TextField,
  useToast,
} from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useFinanceContext, withContext } from '../../lib/context';
import { useAccounts, useAddContribution, useDeleteGoal, useGoalContributions, useGoals, useSaveGoal } from '../../lib/endpoints';
import { formatDate, geometryFraction } from '../../lib/format';
import { GOAL_KIND_LABEL, minorUnits, todayIso, useCurrencyOptions } from './shared';

const HELD_IN: Array<{ value: Goal['heldIn']; label: string; description: string }> = [
  {
    value: 'eligible_cash_accounts',
    label: 'In my everyday accounts',
    description: 'The money sits in accounts that count toward safe-to-spend. If protected, it is subtracted so you don’t spend it by accident.',
  },
  {
    value: 'separate_accounts',
    label: 'In separate accounts',
    description: 'The money sits in accounts excluded from safe-to-spend, so it is already out of spending money and is not subtracted again.',
  },
  {
    value: 'not_yet_funded',
    label: 'Not funded yet',
    description: 'Nothing is set aside yet. Nothing is subtracted until money is actually put aside.',
  },
];

const PRIORITY = [
  { value: 'high', label: 'High', n: 10 },
  { value: 'normal', label: 'Normal', n: 50 },
  { value: 'low', label: 'Low', n: 90 },
] as const;

function priorityKey(n: number): (typeof PRIORITY)[number]['value'] {
  if (n <= 25) return 'high';
  if (n >= 75) return 'low';
  return 'normal';
}

interface GoalDraft {
  name: string;
  kind: Goal['kind'];
  targetAmount: string | null;
  currency: string | null;
  targetDate: string;
  protected: boolean;
  heldIn: Goal['heldIn'];
  linkedAccountIds: string[];
  priority: number;
  destination: string;
  routePreference: string;
  departOn: string;
}

function draftFrom(goal: Goal | null, currency: string | null, kind: Goal['kind'] = 'reserve'): GoalDraft {
  return {
    name: goal?.name ?? '',
    kind: goal?.kind ?? kind,
    targetAmount: goal?.target.amount ?? null,
    currency: goal?.target.currency ?? currency,
    targetDate: goal?.targetDate ?? '',
    protected: goal?.protected ?? true,
    heldIn: goal?.heldIn ?? 'not_yet_funded',
    linkedAccountIds: goal?.linkedAccountIds ?? [],
    priority: goal?.priority ?? 50,
    destination: goal?.travel?.destination ?? '',
    routePreference: goal?.travel?.routePreference ?? '',
    departOn: goal?.travel?.departOn ?? '',
  };
}

function toInput(d: GoalDraft): GoalInput | null {
  if (!d.name.trim() || !d.targetAmount || !d.currency) return null;
  return {
    name: d.name.trim(),
    kind: d.kind,
    target: { amount: d.targetAmount, currency: d.currency },
    targetDate: d.targetDate || null,
    protected: d.protected,
    heldIn: d.heldIn,
    linkedAccountIds: d.heldIn === 'not_yet_funded' ? [] : d.linkedAccountIds,
    priority: d.priority,
    travel:
      d.kind === 'travel'
        ? { destination: d.destination.trim() || null, routePreference: d.routePreference.trim() || null, departOn: d.departOn || null }
        : null,
  };
}

function GoalEditor({ goal, open, onOpenChange }: { goal: Goal | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { options: currencies, defaultCurrency } = useCurrencyOptions();
  const [draft, setDraft] = useState<GoalDraft>(() => draftFrom(goal, defaultCurrency));
  const accounts = useAccounts(open && draft.heldIn !== 'not_yet_funded');
  const save = useSaveGoal();
  const { toast } = useToast();
  const currency = draft.currency ?? defaultCurrency;
  const input = toInput({ ...draft, currency });
  const set = <K extends keyof GoalDraft>(key: K, value: GoalDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const submit = () => {
    if (!input) return;
    save.mutate(
      { id: goal?.id ?? null, input },
      {
        onSuccess: () => {
          toast({ title: goal ? 'Goal updated' : 'Goal created', tone: 'success' });
          onOpenChange(false);
        },
      },
    );
  };
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={goal ? `Edit ${goal.name}` : 'New goal'}
      description="Goals and reserves are plans. Progress only counts verified money."
      modalLock={save.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!input}>
            {goal ? 'Save changes' : 'Create goal'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {save.isError && <Callout tone="critical">{userMessage(save.error)}</Callout>}
        <TextField label="Name" value={draft.name} onChange={(e) => set('name', e.target.value)} maxLength={80} required placeholder="e.g. Emergency reserve" />
        <Select
          label="Kind"
          value={draft.kind}
          onValueChange={(v) => set('kind', v as Goal['kind'])}
          options={Object.entries(GOAL_KIND_LABEL).map(([value, label]) => ({ value, label }))}
        />
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <NumberField label="Target amount" value={draft.targetAmount} onValueChange={(v) => set('targetAmount', v)} scale={minorUnits(currency)} prefix={currency ?? undefined} required />
          <Select label="Currency" value={currency} onValueChange={(v) => set('currency', v)} options={currencies} />
        </div>
        <DateField label="Target date" optional value={draft.targetDate} onChange={(v) => set('targetDate', v)} />
        {draft.kind === 'travel' && (
          <fieldset className="fos-fieldset rounded-lg border border-border p-4">
            <legend className="fos-field__label px-1">Trip details</legend>
            <TextField label="Destination" optional value={draft.destination} onChange={(e) => set('destination', e.target.value)} maxLength={120} />
            <TextField
              label="Route preference"
              optional
              value={draft.routePreference}
              onChange={(e) => set('routePreference', e.target.value)}
              maxLength={200}
              hint="For example: direct flights, or a preferred airline alliance."
            />
            <DateField label="Departure date" optional value={draft.departOn} onChange={(v) => set('departOn', v)} />
          </fieldset>
        )}
        <Switch
          label="Protected reserve"
          description="Protected money is kept out of safe-to-spend when it sits in your everyday accounts."
          checked={draft.protected}
          onCheckedChange={(v) => set('protected', v)}
        />
        <RadioGroup label="Where the money is held" variant="cards" value={draft.heldIn} onValueChange={(v) => set('heldIn', v as Goal['heldIn'])} options={HELD_IN} />
        {draft.heldIn !== 'not_yet_funded' && (
          <fieldset className="fos-fieldset">
            <legend className="fos-field__label">Accounts holding this money</legend>
            {accounts.isPending ? (
              <Skeleton lines={2} />
            ) : accounts.isError ? (
              <Callout tone="warning">Accounts could not be loaded: {userMessage(accounts.error)}</Callout>
            ) : accounts.data.length === 0 ? (
              <p className="text-sm text-ink-3">No accounts yet. Add accounts in Money to link them.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {accounts.data
                  .filter((a) => a.status === 'active')
                  .map((a) => (
                    <Checkbox
                      key={a.id}
                      label={a.name}
                      description={[a.institution?.name, a.maskedIdentifier, a.includeInSafeToSpend ? 'counts toward safe-to-spend' : 'excluded from safe-to-spend'].filter(Boolean).join(' · ')}
                      checked={draft.linkedAccountIds.includes(a.id)}
                      onCheckedChange={(on) =>
                        set('linkedAccountIds', on ? [...draft.linkedAccountIds, a.id] : draft.linkedAccountIds.filter((id) => id !== a.id))
                      }
                    />
                  ))}
              </div>
            )}
          </fieldset>
        )}
        <div className="flex flex-col gap-2">
          <span className="fos-field__label" id="goal-priority">
            Priority
          </span>
          <SegmentedControl
            label="Priority"
            value={priorityKey(draft.priority)}
            onValueChange={(v) => set('priority', PRIORITY.find((p) => p.value === v)?.n ?? 50)}
            options={PRIORITY.map((p) => ({ value: p.value, label: p.label }))}
          />
        </div>
      </div>
    </Drawer>
  );
}

function GoalDetail({ goal, onClose, onEdit }: { goal: Goal; onClose: () => void; onEdit: () => void }) {
  const contributions = useGoalContributions(goal.id);
  const add = useAddContribution(goal.id);
  const remove = useDeleteGoal();
  const { toast } = useToast();
  const { params } = useFinanceContext();
  const [amount, setAmount] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const submit = () => {
    if (!amount || !date) return;
    add.mutate(
      { amount, date, status: 'planned', transactionId: null, note: note.trim() || null },
      {
        onSuccess: () => {
          toast({ title: 'Planned contribution added', description: 'It will count once it is verified against a real transaction.', tone: 'success' });
          setAmount(null);
          setNote('');
        },
      },
    );
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={goal.name}
      description={GOAL_KIND_LABEL[goal.kind]}
      width="lg"
      footer={
        <>
          <Button variant="danger" className="mr-auto" leadingIcon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
          <Button variant="secondary" leadingIcon={<Pencil size={16} />} onClick={onEdit}>
            Edit
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-8">
        <GoalProgress goal={goal} />
        <KeyValue
          items={[
            { key: 'held', label: 'Held', value: HELD_IN.find((h) => h.value === goal.heldIn)?.label },
            { key: 'protected', label: 'Protected from spending', value: goal.protected ? 'Yes' : 'No' },
            { key: 'date', label: 'Target date', value: goal.targetDate ? formatDate(goal.targetDate) : 'None' },
            { key: 'monthly', label: 'Needed per month', value: <Money value={goal.monthlyNeeded} unknownReason="Set a target date to see a monthly amount." /> },
            ...(goal.travel
              ? [
                  { key: 'dest', label: 'Destination', value: goal.travel.destination ?? '—' },
                  { key: 'route', label: 'Route preference', value: goal.travel.routePreference ?? '—' },
                  { key: 'depart', label: 'Departs', value: goal.travel.departOn ? formatDate(goal.travel.departOn) : '—' },
                ]
              : []),
          ]}
        />
        <section aria-labelledby="contrib-title" className="flex flex-col gap-4">
          <h3 id="contrib-title" className="text-md font-semibold">
            Contributions
          </h3>
          <Callout tone="neutral">
            Planned contributions are intentions and do not count toward progress. Verified contributions come from real transactions: link a
            transfer to this goal in <Link href={withContext('/money/transactions', params)}>Money → Transactions</Link>.
          </Callout>
          <QueryState
            query={contributions}
            size="sm"
            loadingLabel="Loading contributions"
            isEmpty={(list) => list.length === 0}
            empty={<p className="text-sm text-ink-3">No contributions yet.</p>}
          >
            {(list) => (
              <DataList
                dense
                label="Contributions"
                items={list.map((c) => ({
                  id: c.id,
                  title: formatDate(c.date),
                  subtitle: c.note ?? undefined,
                  value: <Money value={c.amount} />,
                  valueCaption: <StatusBadge status={c.status === 'verified' ? 'ok' : 'insufficient_data'} label={c.status === 'verified' ? 'Verified' : 'Planned'} size="sm" />,
                }))}
              />
            )}
          </QueryState>
          <div className="rounded-lg border border-border p-4">
            <p className="mb-3 text-sm font-medium">Plan a contribution</p>
            {add.isError && (
              <Callout tone="critical" className="mb-3">
                {userMessage(add.error)}
              </Callout>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField label="Amount" value={amount} onValueChange={setAmount} scale={minorUnits(goal.target.currency)} prefix={goal.target.currency} />
              <DateField label="Date" value={date} onChange={setDate} />
            </div>
            <TextField label="Note" optional value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} fieldClassName="mt-3" />
            <div className="mt-3 flex justify-end">
              <Button variant="secondary" size="sm" onClick={submit} loading={add.isPending} disabled={!amount || !date}>
                Add planned contribution
              </Button>
            </div>
          </div>
        </section>
      </div>
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        role="alertdialog"
        size="sm"
        title={`Delete ${goal.name}?`}
        description="The goal and its planned contributions are removed. Verified transactions are not changed."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep goal
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(goal.id, {
                  onSuccess: () => {
                    toast({ title: 'Goal deleted', tone: 'success' });
                    setConfirmDelete(false);
                    onClose();
                  },
                })
              }
            >
              Delete goal
            </Button>
          </>
        }
      >
        {remove.isError && <Callout tone="critical">{userMessage(remove.error)}</Callout>}
      </Dialog>
    </Drawer>
  );
}

function GoalProgress({ goal }: { goal: Goal }) {
  const fraction = geometryFraction(goal.progress);
  return (
    <div className="flex flex-col gap-2">
      <ProgressBar
        label="Verified progress"
        value={fraction}
        tone={goal.status === 'achieved' ? 'positive' : 'accent'}
        valueText={
          <>
            <Money value={goal.fundedVerified} /> of <Money value={goal.target} />
          </>
        }
        ariaValueText="Verified amount compared with target"
      />
      <p className="text-xs text-ink-3">
        Planned, not yet verified: <Money value={goal.fundedPlanned} size="sm" />
      </p>
    </div>
  );
}

function GoalCard({ goal, onOpen }: { goal: Goal; onOpen: () => void }) {
  return (
    <Card as="article" padding="md" className="flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-md font-semibold break-words">{goal.name}</h3>
          <p className="text-sm text-ink-3">
            {GOAL_KIND_LABEL[goal.kind]}
            {goal.targetDate ? ` · by ${formatDate(goal.targetDate, 'short')}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {goal.protected && (
            <Badge tone="accent">
              <ShieldCheck size={12} aria-hidden="true" /> Protected
            </Badge>
          )}
          {goal.kind === 'travel' && (
            <Badge tone="info">
              <Plane size={12} aria-hidden="true" /> {goal.travel?.destination ?? 'Trip'}
            </Badge>
          )}
          {goal.status !== 'active' && <Badge>{goal.status}</Badge>}
        </div>
      </div>
      <div className="mt-4">
        <GoalProgress goal={goal} />
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onOpen} aria-label={`Open ${goal.name}`}>
          Details
        </Button>
      </div>
    </Card>
  );
}

export function GoalsTab() {
  const goals = useGoals();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Goal | 'new' | null>(null);
  const openId = params.get('goal');
  const creating = params.get('new') === '1';

  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const editorGoal = editing === 'new' || creating ? null : editing;
  const editorOpen = editing !== null || creating;
  const detail = goals.data?.find((g) => g.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-ink-2">Reserves protect money from everyday spending. Progress counts only verified money, never plans.</p>
        <Button variant="primary" leadingIcon={<Plus size={16} />} onClick={() => setEditing('new')}>
          New goal
        </Button>
      </div>
      <QueryState
        query={goals}
        loadingLabel="Loading goals"
        isEmpty={(list) => list.length === 0}
        empty={
          <EmptyState
            title="No goals yet"
            description="Start with an emergency reserve, then add travel, annual bills or planned purchases."
            actions={
              <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
                Create a goal
              </Button>
            }
          />
        }
      >
        {(list) => (
          <div className="grid gap-4 md:grid-cols-2">
            {[...list]
              .filter((g) => g.status !== 'archived')
              .sort((a, b) => a.priority - b.priority)
              .map((g) => (
                <GoalCard key={g.id} goal={g} onOpen={() => setParam('goal', g.id)} />
              ))}
          </div>
        )}
      </QueryState>
      {editorOpen && (
        <GoalEditor
          key={editorGoal?.id ?? 'new'}
          goal={editorGoal}
          open
          onOpenChange={(o) => {
            if (!o) {
              setEditing(null);
              if (creating) setParam('new', null);
            }
          }}
        />
      )}
      {detail && !editorOpen && (
        <GoalDetail
          key={detail.id}
          goal={detail}
          onClose={() => setParam('goal', null)}
          onEdit={() => {
            setParam('goal', null);
            setEditing(detail);
          }}
        />
      )}
    </div>
  );
}
