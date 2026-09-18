import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Check, Download, Plus, Trash2, X } from 'lucide-react';
import type { ClassificationInput, SplitLine, Transaction, TransactionNature, TransactionQuery } from '@financialos/contracts';
import {
  Badge,
  Button,
  Callout,
  Combobox,
  DateField,
  Drawer,
  EmptyState,
  Money,
  NumberField,
  Section,
  Select,
  StatusBadge,
  Switch,
  Table,
  TextField,
  useToast,
} from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useAccounts, useCategories } from '../../lib/endpoints';
import { useClassifyTransaction, useTransaction, useTransactions, useTransferMatchAction, transactionsExportUrl } from './api';

const NATURE_OPTIONS: Array<{ value: TransactionNature; label: string }> = [
  'consumption', 'income', 'salary', 'transfer_internal', 'transfer_external', 'intercompany', 'owner_contribution', 'owner_drawing',
  'business_support', 'third_party', 'investment_contribution', 'investment_withdrawal', 'investment_trade', 'property_purchase',
  'loan_repayment', 'fee', 'interest', 'dividend', 'refund', 'tax', 'payroll', 'fx_conversion', 'unknown',
].map((v) => ({ value: v as TransactionNature, label: v.replace(/_/g, ' ') }));

function SplitEditor({ splits, onChange, currency }: { splits: SplitLine[]; onChange: (s: SplitLine[]) => void; currency: string | null }) {
  const categories = useCategories();
  const add = () => onChange([...splits, { amount: '', categoryId: null, nature: 'consumption', economicOwnerEntityId: null, memo: null }]);
  const update = (i: number, patch: Partial<SplitLine>) => onChange(splits.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const remove = (i: number) => onChange(splits.filter((_, idx) => idx !== i));
  return (
    <div className="flex flex-col gap-3">
      {splits.map((s, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
          <NumberField label="Amount" value={s.amount} onValueChange={(v) => update(i, { amount: v ?? '' })} prefix={currency ?? undefined} allowNegative />
          <Select label="Category" value={s.categoryId} onValueChange={(v) => update(i, { categoryId: v })} options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Category" />
          <Select label="Nature" value={s.nature} onValueChange={(v) => update(i, { nature: (v as TransactionNature) ?? s.nature })} options={NATURE_OPTIONS} />
          <Button variant="ghost" size="sm" leadingIcon={<Trash2 size={14} />} onClick={() => remove(i)}>
            Remove
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" leadingIcon={<Plus size={14} />} onClick={add}>
        Add split
      </Button>
    </div>
  );
}

function ClassifyDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const tx = useTransaction(id);
  const categories = useCategories();
  const classify = useClassifyTransaction();
  const transferAction = useTransferMatchAction();
  const { toast } = useToast();
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [nature, setNature] = useState<TransactionNature>('consumption');
  const [note, setNote] = useState('');
  const [splits, setSplits] = useState<SplitLine[] | null>(null);
  const [createRule, setCreateRule] = useState(false);

  useEffect(() => {
    if (tx.data) {
      setCategoryId(tx.data.category?.id ?? null);
      setNature(tx.data.nature);
      setSplits(tx.data.splits);
      setNote('');
      setCreateRule(false);
    }
  }, [tx.data]);

  if (!id) return null;
  const t = tx.data;

  const submit = () => {
    if (!t) return;
    const input: ClassificationInput = {
      categoryId,
      nature,
      economicOwnerEntityId: t.economicOwnerEntityId,
      counterpartyId: null,
      splits,
      note: note.trim() || null,
      createRule: createRule ? { matchDescription: t.description || null, matchCounterparty: t.counterparty } : null,
    };
    classify.mutate({ id, input }, { onSuccess: () => { toast({ title: 'Transaction categorised', tone: 'success' }); onClose(); } });
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={t ? t.description || 'Transaction' : 'Transaction'} modalLock={classify.isPending}>
      {!t ? (
        tx.isError ? <Callout tone="critical">{userMessage(tx.error)}</Callout> : <p className="text-sm text-ink-3">Loading…</p>
      ) : (
        <div className="flex flex-col gap-5">
          {classify.isError && <Callout tone="critical">{userMessage(classify.error)}</Callout>}
          <div className="flex items-center justify-between">
            <Money value={t.amount} size="lg" weight="semibold" tone="sign" />
            <StatusBadge status={t.status} />
          </div>
          <p className="text-sm text-ink-3">
            {t.bookedOn} {t.counterparty ? `· ${t.counterparty}` : ''}
          </p>

          {t.transferMatch && t.transferMatch.status === 'suggested' && (
            <Callout tone="info" title="Possible transfer match">
              <div className="flex gap-2 mt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Check size={14} />}
                  loading={transferAction.isPending}
                  onClick={() => transferAction.mutate({ matchId: t.transferMatch!.matchId, action: 'confirm' })}
                >
                  Confirm match
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<X size={14} />}
                  loading={transferAction.isPending}
                  onClick={() => transferAction.mutate({ matchId: t.transferMatch!.matchId, action: 'reject' })}
                >
                  Not a transfer
                </Button>
              </div>
            </Callout>
          )}

          <Select label="Category" value={categoryId} onValueChange={setCategoryId} options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="No category" />
          <Select label="Nature" value={nature} onValueChange={(v) => setNature((v as TransactionNature) ?? nature)} options={NATURE_OPTIONS} />

          <Switch label="Split into multiple categories" checked={!!splits} onCheckedChange={(v) => setSplits(v ? [] : null)} />
          {splits && <SplitEditor splits={splits} onChange={setSplits} currency={t.amount.currency} />}

          <Switch label="Always categorise similar transactions this way" checked={createRule} onCheckedChange={setCreateRule} />
          <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />

          <div className="flex justify-end">
            <Button variant="primary" onClick={submit} loading={classify.isPending}>
              Save
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

export function TransactionsTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const accounts = useAccounts();
  const categories = useCategories();
  const [q, setQ] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [needsReview, setNeedsReview] = useState(searchParams.get('needsReview') === '1');
  const [openId, setOpenId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  useEffect(() => {
    const openParam = searchParams.get('open');
    if (openParam) {
      setOpenId(openParam);
      const next = new URLSearchParams(searchParams);
      next.delete('open');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const query: TransactionQuery = useMemo(
    () => ({
      q: q.trim() || undefined,
      accountId: accountId ?? undefined,
      categoryId: categoryId ?? undefined,
      needsReview: needsReview || undefined,
      cursor,
      limit: 50,
    }),
    [q, accountId, categoryId, needsReview, cursor],
  );
  const page = useTransactions(query);
  const [allItems, setAllItems] = useState<Transaction[]>([]);
  useEffect(() => {
    if (!page.data) return;
    setAllItems((prev) => (cursor ? [...prev, ...page.data.items] : page.data.items));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.data]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <TextField label="Search" hideLabel value={q} onChange={(e) => { setQ(e.target.value); setCursor(undefined); }} placeholder="Search description or counterparty" />
        <Select label="Account" hideLabel value={accountId} onValueChange={(v) => { setAccountId(v); setCursor(undefined); }} options={(accounts.data ?? []).map((a) => ({ value: a.id, label: a.name }))} placeholder="All accounts" />
        <Select label="Category" hideLabel value={categoryId} onValueChange={(v) => { setCategoryId(v); setCursor(undefined); }} options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="All categories" />
        <Switch label="Needs review" checked={needsReview} onCheckedChange={(v) => { setNeedsReview(v); setCursor(undefined); }} />
        <a href={transactionsExportUrl(query)} className="ml-auto">
          <Button variant="ghost" size="sm" leadingIcon={<Download size={14} />}>
            Export CSV
          </Button>
        </a>
      </div>

      <QueryState
        query={page}
        loadingLabel="Loading transactions"
        isEmpty={() => allItems.length === 0}
        empty={<EmptyState title="No transactions" description="Import a statement or connect an account to see transactions here." />}
      >
        {(p) => (
          <Section title="Transactions">
            <Table
              caption="Transactions"
              hideCaption
              rows={allItems}
              getRowKey={(t: Transaction) => t.id}
              onRowClick={(t) => setOpenId(t.id)}
              rowActionLabel={(t) => `Open ${t.description}`}
              columns={[
                { key: 'date', header: 'Date', cell: (t) => t.bookedOn },
                {
                  key: 'desc',
                  header: 'Description',
                  primary: true,
                  cell: (t) => (
                    <span className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        {t.description || t.counterparty || 'Transaction'}
                        {t.classification.needsReview && <Badge tone="caution">Needs review</Badge>}
                        {t.transferMatch?.status === 'suggested' && <Badge tone="info">Possible transfer</Badge>}
                      </span>
                      <span className="text-sm text-ink-3">{t.category?.name ?? 'Uncategorised'}</span>
                    </span>
                  ),
                },
                { key: 'amount', header: 'Amount', numeric: true, cell: (t) => <Money value={t.amount} tone="sign" /> },
              ]}
            />
            <div className="flex justify-center pt-4">
              {p.nextCursor && (
                <Button variant="secondary" onClick={() => setCursor(p.nextCursor ?? undefined)} loading={page.isFetching}>
                  Load more
                </Button>
              )}
            </div>
          </Section>
        )}
      </QueryState>

      <ClassifyDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
