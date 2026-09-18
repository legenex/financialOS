import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { Budget, BudgetLine, BudgetLineInput } from '@financialos/contracts';
import {
  BarComparison,
  Badge,
  Button,
  Callout,
  Combobox,
  Dialog,
  Drawer,
  EmptyState,
  KeyValue,
  Link,
  Money,
  NumberField,
  ProgressBar,
  RadioGroup,
  Section,
  Select,
  StatusBadge,
  Switch,
  Table,
  TextField,
  decimalSign,
  useToast,
} from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { periodRange, useFinanceContext, withContext } from '../../lib/context';
import { useBudgets, useCategories, useEntities, useSaveBudget } from '../../lib/endpoints';
import { ratioForGeometry } from '../../lib/format';
import { entityOptions, minorUnits, primaryEntity, useCurrencyOptions } from './shared';

const KIND_OPTIONS: Array<{ value: BudgetLine['kind']; label: string; description: string }> = [
  { value: 'spending', label: 'Spending limit', description: 'A monthly cap for day-to-day spending in this category.' },
  { value: 'envelope', label: 'Envelope', description: 'A virtual envelope. Money stays in your accounts; FinancialOS only tracks it.' },
  { value: 'sinking_fund', label: 'Sinking fund', description: 'Set aside a little each month for a known future cost.' },
  { value: 'fixed', label: 'Fixed bill', description: 'A predictable amount that is the same every period.' },
];

const KIND_LABEL = Object.fromEntries(KIND_OPTIONS.map((k) => [k.value, k.label])) as Record<BudgetLine['kind'], string>;

function toInput(line: Pick<BudgetLine, 'categoryId' | 'kind' | 'planned' | 'rollover'>): BudgetLineInput {
  return { categoryId: line.categoryId, kind: line.kind, planned: line.planned.amount, rollover: line.rollover };
}

interface LineDraft {
  categoryId: string | null;
  kind: BudgetLine['kind'];
  planned: string | null;
  rollover: boolean;
}

function LineEditor({
  budget,
  line,
  open,
  onOpenChange,
  period,
  onRemove,
}: {
  budget: Budget;
  line: BudgetLine | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  period: string;
  onRemove: (line: BudgetLine) => void;
}) {
  const categories = useCategories(open);
  const save = useSaveBudget(period);
  const { toast } = useToast();
  const [draft, setDraft] = useState<LineDraft>(() =>
    line ? { categoryId: line.categoryId, kind: line.kind, planned: line.planned.amount, rollover: line.rollover } : { categoryId: null, kind: 'spending', planned: null, rollover: false },
  );
  const used = new Set(budget.lines.map((l) => l.categoryId));
  const categoryOptions = (categories.data ?? [])
    .filter((c) => c.kind === 'expense' && (!used.has(c.id) || c.id === line?.categoryId))
    .map((c) => ({ value: c.id, label: c.name, description: c.essential ? 'Essential' : undefined }));
  const valid = !!draft.categoryId && draft.planned !== null;

  const submit = () => {
    if (!valid || !draft.categoryId || draft.planned === null) return;
    const edited: BudgetLineInput = { categoryId: draft.categoryId, kind: draft.kind, planned: draft.planned, rollover: draft.rollover };
    const lines = line ? budget.lines.map((l) => (l.id === line.id ? edited : toInput(l))) : [...budget.lines.map(toInput), edited];
    save.mutate(
      { id: budget.id, input: { name: budget.name, entityId: budget.entityId, currency: budget.currency, lines } },
      {
        onSuccess: () => {
          toast({ title: line ? 'Budget line updated' : 'Budget line added', tone: 'success' });
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={line ? `Edit ${line.categoryName}` : 'Add a budget line'}
      description={`Amounts in ${budget.currency}.`}
      modalLock={save.isPending}
      footer={
        <>
          {line && (
            <Button variant="danger" className="mr-auto" leadingIcon={<Trash2 size={16} />} onClick={() => onRemove(line)}>
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
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
        {line ? (
          <KeyValue items={[{ key: 'cat', label: 'Category', value: line.categoryName }]} />
        ) : categories.isError ? (
          <Callout tone="warning">Categories could not be loaded: {userMessage(categories.error)}</Callout>
        ) : (
          <Combobox
            label="Category"
            value={draft.categoryId}
            onValueChange={(v) => setDraft((d) => ({ ...d, categoryId: v }))}
            options={categoryOptions}
            placeholder={categories.isPending ? 'Loading categories…' : 'Choose a category'}
            emptyText="No unused expense categories"
            required
          />
        )}
        <RadioGroup
          label="Type"
          variant="cards"
          value={draft.kind}
          onValueChange={(v) => setDraft((d) => ({ ...d, kind: v as BudgetLine['kind'] }))}
          options={KIND_OPTIONS}
        />
        <NumberField
          label="Planned per period"
          value={draft.planned}
          onValueChange={(v) => setDraft((d) => ({ ...d, planned: v }))}
          scale={minorUnits(budget.currency)}
          prefix={budget.currency}
          required
        />
        <Switch
          label="Roll over what’s left"
          description="Unspent (or overspent) amounts carry into the next period for this line."
          checked={draft.rollover}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, rollover: v }))}
        />
      </div>
    </Drawer>
  );
}

function CreateBudget({ period }: { period: string }) {
  const [open, setOpen] = useState(false);
  const entities = useEntities();
  const { options: currencyOptions, budgetCurrency } = useCurrencyOptions();
  const save = useSaveBudget(period);
  const { toast } = useToast();
  const [name, setName] = useState('Monthly budget');
  const [entityId, setEntityId] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const effectiveEntity = entityId ?? primaryEntity(entities.data)?.id ?? null;
  const effectiveCurrency = currency ?? budgetCurrency;
  const valid = name.trim().length > 0 && !!effectiveEntity && !!effectiveCurrency;
  const submit = () => {
    if (!valid || !effectiveEntity || !effectiveCurrency) return;
    save.mutate(
      { id: null, input: { name: name.trim(), entityId: effectiveEntity, currency: effectiveCurrency, lines: [] } },
      {
        onSuccess: () => {
          toast({ title: 'Budget created', description: 'Add lines for the categories you want to plan.', tone: 'success' });
          setOpen(false);
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Create a budget"
      trigger={
        <Button variant="primary" leadingIcon={<Plus size={16} />}>
          Create a budget
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!valid}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {save.isError && <Callout tone="critical">{userMessage(save.error)}</Callout>}
        {entities.isError && <Callout tone="warning">Entities could not be loaded, so a budget can’t be created yet.</Callout>}
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        <Select label="For" value={effectiveEntity} onValueChange={setEntityId} options={entityOptions(entities.data)} placeholder={entities.isPending ? 'Loading…' : 'Choose'} />
        <Select label="Currency" value={effectiveCurrency} onValueChange={setCurrency} options={currencyOptions} />
      </div>
    </Dialog>
  );
}

function RemoveLine({ budget, line, period, onDone }: { budget: Budget; line: BudgetLine | null; period: string; onDone: () => void }) {
  const save = useSaveBudget(period);
  const { toast } = useToast();
  if (!line) return null;
  return (
    <Dialog
      open={!!line}
      onOpenChange={(o) => !o && onDone()}
      title={`Remove ${line.categoryName}?`}
      description="Spending in this category will show as unbudgeted. Past transactions are not changed."
      size="sm"
      role="alertdialog"
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            Keep
          </Button>
          <Button
            variant="danger"
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { id: budget.id, input: { name: budget.name, entityId: budget.entityId, currency: budget.currency, lines: budget.lines.filter((l) => l.id !== line.id).map(toInput) } },
                {
                  onSuccess: () => {
                    toast({ title: 'Budget line removed', tone: 'success' });
                    onDone();
                  },
                },
              )
            }
          >
            Remove line
          </Button>
        </>
      }
    >
      {save.isError && <Callout tone="critical">{userMessage(save.error)}</Callout>}
    </Dialog>
  );
}

function BudgetView({ budget, period }: { budget: Budget; period: string }) {
  const [editing, setEditing] = useState<BudgetLine | 'new' | null>(null);
  const [removing, setRemoving] = useState<BudgetLine | null>(null);
  const { params } = useFinanceContext();
  const unclassified = budget.unclassifiedSpending && decimalSign(budget.unclassifiedSpending.amount) !== 0;
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{budget.name}</h2>
            <p className="text-sm text-ink-3">
              {budget.period.label} · {budget.currency}
            </p>
          </div>
          <StatusBadge status={budget.status} />
        </div>
        <KeyValue
          layout="grid"
          items={[
            { key: 'planned', label: 'Planned', value: <Money value={budget.totals.planned} size="lg" weight="semibold" /> },
            { key: 'actual', label: 'Spent', value: <Money value={budget.totals.actual} size="lg" weight="semibold" unknownReason="Some spending is not classified yet." /> },
            { key: 'remaining', label: 'Remaining', value: <Money value={budget.totals.remaining} size="lg" weight="semibold" tone="sign" /> },
          ]}
        />
        <Callout tone="neutral">
          Envelopes and sinking funds are virtual: they don’t move money between accounts. {budget.note}
        </Callout>
        {unclassified && (
          <Callout
            tone="warning"
            title="Unclassified spending"
            actions={
              <Link href={withContext('/money/transactions?needsReview=1', params)}>Classify transactions</Link>
            }
          >
            <Money value={budget.unclassifiedSpending} weight="medium" /> of spending this period has no category, so actuals may be understated.
          </Callout>
        )}
      </div>

      <BarComparison
        title="Plan vs actual"
        currency={budget.currency}
        rows={budget.lines.map((l) => ({ key: l.id, label: l.categoryName, plan: l.planned, actual: l.actual }))}
        emptyDescription="Add budget lines to compare plan with actual spending."
      />

      <Section
        title="Budget lines"
        actions={
          <Button variant="secondary" size="sm" leadingIcon={<Plus size={16} />} onClick={() => setEditing('new')}>
            Add line
          </Button>
        }
      >
        <Table
          caption={`Budget lines for ${budget.period.label}`}
          hideCaption
          rows={budget.lines}
          getRowKey={(l) => l.id}
          onRowClick={(l) => setEditing(l)}
          rowActionLabel={(l) => `Edit ${l.categoryName}`}
          empty={<EmptyState size="sm" title="No lines yet" description="Add a line for each category you want to plan." />}
          columns={[
            {
              key: 'category',
              header: 'Category',
              primary: true,
              cell: (l) => (
                <span className="flex flex-col gap-1.5">
                  <span className="flex flex-wrap items-center gap-2">
                    {l.categoryName} <Badge>{KIND_LABEL[l.kind]}</Badge>
                    {l.rollover && <Badge tone="info">Rolls over</Badge>}
                  </span>
                  <ProgressBar
                    label={`${l.categoryName} progress`}
                    hideLabel
                    size="sm"
                    value={ratioForGeometry(l.actual?.amount, l.planned.amount)}
                    tone={l.remaining && decimalSign(l.remaining.amount) < 0 ? 'negative' : 'accent'}
                  />
                </span>
              ),
            },
            { key: 'planned', header: 'Planned', numeric: true, cell: (l) => <Money value={l.planned} /> },
            { key: 'actual', header: 'Actual', numeric: true, cell: (l) => <Money value={l.actual} unknownReason="Spending in this category is not fully classified." /> },
            {
              key: 'remaining',
              header: 'Remaining',
              numeric: true,
              cell: (l) => (
                <span className="inline-flex flex-col items-end">
                  <Money value={l.remaining} tone="sign" />
                  {l.remaining && decimalSign(l.remaining.amount) < 0 && <span className="text-xs text-negative">Over plan</span>}
                  {l.carriedIn && decimalSign(l.carriedIn.amount) !== 0 && (
                    <span className="text-xs text-ink-3">
                      incl. <Money value={l.carriedIn} signed /> carried in
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'actions',
              header: <span className="fos-sr-only">Remove</span>,
              hideOnMobile: true,
              align: 'end',
              cell: (l) => (
                <span className="inline-flex gap-1">
                  <button type="button" className="fos-table__action" aria-label={`Edit ${l.categoryName}`} onClick={(e) => { e.stopPropagation(); setEditing(l); }}>
                    <Pencil size={15} aria-hidden="true" />
                  </button>
                  <button type="button" className="fos-table__action" aria-label={`Remove ${l.categoryName}`} onClick={(e) => { e.stopPropagation(); setRemoving(l); }}>
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </span>
              ),
            },
          ]}
        />
      </Section>

      {editing && (
        <LineEditor
          key={editing === 'new' ? 'new' : editing.id}
          budget={budget}
          line={editing === 'new' ? null : editing}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          period={period}
          onRemove={(l) => {
            setEditing(null);
            setRemoving(l);
          }}
        />
      )}
      <RemoveLine budget={budget} line={removing} period={period} onDone={() => setRemoving(null)} />
    </div>
  );
}

export function BudgetTab() {
  const { ctx } = useFinanceContext();
  const period = periodRange(ctx.period).month;
  const budgets = useBudgets(period);
  return (
    <QueryState
      query={budgets}
      loadingLabel="Loading budget"
      isEmpty={(list) => list.length === 0}
      empty={
        <EmptyState
          title="No budget for this period"
          description="A budget sets a plan per category. Actual spending is filled in from classified transactions."
          actions={<CreateBudget period={period} />}
        />
      }
    >
      {(list) => (
        <div className="flex flex-col gap-12">
          {list.map((b) => (
            <BudgetView key={b.id} budget={b} period={period} />
          ))}
        </div>
      )}
    </QueryState>
  );
}
