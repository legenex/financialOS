import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Pencil, Plus } from 'lucide-react';
import type { Account, AccountInput, AccountKind, BalanceSnapshotInput, LiquidityClass } from '@financialos/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  Combobox,
  DateField,
  Dialog,
  Drawer,
  EmptyState,
  Freshness,
  Money,
  NumberField,
  Section,
  Select,
  Switch,
  Table,
  TextField,
  useToast,
} from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useAccounts, useEntities } from '../../lib/endpoints';
import { useAccountSnapshots, useAddSnapshot, useCreateAccount, useCreateInstitution, useInstitutions, useUpdateAccount } from './api';

const KIND_OPTIONS: Array<{ value: AccountKind; label: string }> = [
  { value: 'current', label: 'Current account' },
  { value: 'savings', label: 'Savings account' },
  { value: 'card', label: 'Debit card' },
  { value: 'credit_card', label: 'Credit card' },
  { value: 'brokerage', label: 'Brokerage' },
  { value: 'crypto_wallet', label: 'Crypto wallet (self-custody)' },
  { value: 'crypto_custodial', label: 'Crypto (custodial)' },
  { value: 'private_investment', label: 'Private investment' },
  { value: 'restricted_equity', label: 'Restricted equity' },
  { value: 'pension', label: 'Pension' },
  { value: 'property', label: 'Property' },
  { value: 'mortgage', label: 'Mortgage' },
  { value: 'loan', label: 'Loan' },
  { value: 'receivable', label: 'Receivable' },
  { value: 'clearing', label: 'Clearing (third-party)' },
  { value: 'other', label: 'Other' },
];

const LIQUIDITY_OPTIONS: Array<{ value: LiquidityClass; label: string }> = [
  { value: 'cash', label: 'Cash' },
  { value: 'near_cash', label: 'Near cash' },
  { value: 'marketable', label: 'Marketable' },
  { value: 'restricted', label: 'Restricted' },
  { value: 'illiquid', label: 'Illiquid' },
  { value: 'property', label: 'Property' },
  { value: 'liability', label: 'Liability' },
  { value: 'receivable', label: 'Receivable' },
  { value: 'contingent', label: 'Contingent' },
];

function emptyInput(): AccountInput {
  return {
    name: '',
    kind: 'current',
    currency: null,
    institutionId: null,
    legalEntityId: null,
    economicOwnerEntityId: null,
    ownershipConfirmed: false,
    liquidityClass: 'cash',
    includeInSafeToSpend: false,
    maskedIdentifier: null,
    notes: null,
  };
}

function toInput(a: Account): AccountInput {
  return {
    name: a.name,
    kind: a.kind,
    currency: a.currency,
    institutionId: a.institution?.id ?? null,
    legalEntityId: a.legalEntityId,
    economicOwnerEntityId: a.economicOwnerEntityId,
    ownershipConfirmed: a.ownershipConfirmed,
    liquidityClass: a.liquidityClass,
    includeInSafeToSpend: a.includeInSafeToSpend,
    maskedIdentifier: a.maskedIdentifier,
    notes: a.notes,
  };
}

function AddInstitution({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const create = useCreateInstitution();
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Add an institution"
      trigger={
        <Button type="button" variant="ghost" size="sm" leadingIcon={<Plus size={14} />}>
          Add institution
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                { name: name.trim(), country: null, kind: 'other', providerKey: null },
                {
                  onSuccess: (inst) => {
                    onCreated(inst.id);
                    setName('');
                    setOpen(false);
                  },
                },
              )
            }
          >
            Add
          </Button>
        </>
      }
    >
      {create.isError && <Callout tone="critical">{userMessage(create.error)}</Callout>}
      <TextField label="Institution name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
    </Dialog>
  );
}

function BalanceSection({ account }: { account: Account }) {
  const snapshots = useAccountSnapshots(account.id);
  const add = useAddSnapshot(account.id);
  const { toast } = useToast();
  const [amount, setAmount] = useState<string | null>(null);
  const [currency, setCurrency] = useState(account.currency ?? 'USD');
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));

  const submit = () => {
    if (amount === null) return;
    const input: BalanceSnapshotInput = {
      accountId: account.id,
      kind: 'manual',
      balance: { amount, currency },
      approximate: false,
      completeness: 'complete',
      sourceAsOf: `${asOf}T00:00:00Z`,
      source: 'Manually entered',
      documentId: null,
    };
    add.mutate(input, {
      onSuccess: () => {
        toast({ title: 'Balance recorded', tone: 'success' });
        setAmount(null);
      },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <Money value={account.valuation.value} size="lg" weight="semibold" unknownReason="No balance recorded yet." />
      <Freshness state={account.freshness.state} lastUpdatedAt={account.freshness.lastUpdatedAt} label={account.freshness.label} compact />
      {add.isError && <Callout tone="critical">{userMessage(add.error)}</Callout>}
      <div className="flex flex-wrap items-end gap-2">
        <NumberField label="New balance" value={amount} onValueChange={setAmount} prefix={currency} allowNegative />
        <TextField label="Currency" hideLabel value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} className="w-24" maxLength={10} />
        <DateField label="As of" value={asOf} onChange={setAsOf} />
        <Button variant="secondary" onClick={submit} disabled={amount === null} loading={add.isPending}>
          Record
        </Button>
      </div>
      {snapshots.data && snapshots.data.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-ink-3">
          {snapshots.data.slice(0, 5).map((s) => (
            <li key={s.id}>
              <Money value={s.balance} /> — {s.kind.replace(/_/g, ' ')} — {new Date(s.reportedAt).toLocaleDateString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AccountEditor({ account, open, onOpenChange }: { account: Account | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const institutions = useInstitutions();
  const entities = useEntities();
  const create = useCreateAccount();
  const update = useUpdateAccount();
  const { toast } = useToast();
  const [draft, setDraft] = useState<AccountInput>(() => (account ? toInput(account) : emptyInput()));
  const [createdId, setCreatedId] = useState<string | null>(account?.id ?? null);
  const accounts = useAccounts(!!createdId);
  const created = accounts.data?.find((a) => a.id === createdId) ?? account;

  useEffect(() => {
    setDraft(account ? toInput(account) : emptyInput());
    setCreatedId(account?.id ?? null);
  }, [account, open]);

  const mutation = createdId ? update : create;
  const valid = draft.name.trim().length > 0 && !!draft.liquidityClass;

  const submit = () => {
    if (!valid) return;
    if (createdId) {
      update.mutate(
        { id: createdId, input: draft },
        { onSuccess: () => toast({ title: 'Account updated', tone: 'success' }) },
      );
    } else {
      create.mutate(draft, {
        onSuccess: (a) => {
          setCreatedId(a.id);
          toast({ title: 'Account added', description: 'Record a balance below to complete it.', tone: 'success' });
        },
      });
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={createdId ? `Edit ${draft.name || 'account'}` : 'Add an account'} modalLock={mutation.isPending}>
      <div className="flex flex-col gap-5">
        {mutation.isError && <Callout tone="critical">{userMessage(mutation.error)}</Callout>}
        <TextField label="Name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} required maxLength={120} />
        <Select label="Kind" value={draft.kind} onValueChange={(v) => setDraft((d) => ({ ...d, kind: (v as AccountKind) ?? d.kind }))} options={KIND_OPTIONS} />
        <div className="flex items-end gap-2">
          <Select
            label="Institution"
            value={draft.institutionId}
            onValueChange={(v) => setDraft((d) => ({ ...d, institutionId: v }))}
            options={(institutions.data ?? []).map((i) => ({ value: i.id, label: i.name }))}
            placeholder="No institution"
          />
          <AddInstitution onCreated={(id) => setDraft((d) => ({ ...d, institutionId: id }))} />
        </div>
        <TextField label="Currency" value={draft.currency ?? ''} onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value.toUpperCase() || null }))} maxLength={10} placeholder="USD" />
        <Select label="Liquidity class" value={draft.liquidityClass} onValueChange={(v) => setDraft((d) => ({ ...d, liquidityClass: (v as LiquidityClass) ?? d.liquidityClass }))} options={LIQUIDITY_OPTIONS} required />
        <Combobox
          label="Legal entity (who legally holds it)"
          value={draft.legalEntityId}
          onValueChange={(v) => setDraft((d) => ({ ...d, legalEntityId: v }))}
          options={(entities.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          placeholder="Not set"
          emptyText="No entities yet"
        />
        <Combobox
          label="Economic owner (whose money it is)"
          value={draft.economicOwnerEntityId}
          onValueChange={(v) => setDraft((d) => ({ ...d, economicOwnerEntityId: v }))}
          options={(entities.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          placeholder="Not set"
          emptyText="No entities yet"
        />
        <Switch
          label="Ownership confirmed"
          description="Turn on once you've verified who legally holds and economically owns this account."
          checked={draft.ownershipConfirmed}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, ownershipConfirmed: v }))}
        />
        <Switch
          label="Count toward safe-to-spend"
          description="Only eligible personal cash accounts should be included."
          checked={draft.includeInSafeToSpend}
          onCheckedChange={(v) => setDraft((d) => ({ ...d, includeInSafeToSpend: v }))}
        />
        <TextField
          label="Masked identifier (optional)"
          value={draft.maskedIdentifier ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, maskedIdentifier: e.target.value || null }))}
          placeholder="****1234"
        />
        <TextField label="Notes (optional)" value={draft.notes ?? ''} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value || null }))} maxLength={2000} />
        <div className="flex justify-end">
          <Button variant="primary" onClick={submit} loading={mutation.isPending} disabled={!valid}>
            {createdId ? 'Save changes' : 'Add account'}
          </Button>
        </div>

        {created && (
          <Section title="Balance">
            <BalanceSection account={created} />
          </Section>
        )}
      </div>
    </Drawer>
  );
}

export function AccountsTab() {
  const accounts = useAccounts();
  const [searchParams, setSearchParams] = useSearchParams();
  const [liquidity, setLiquidity] = useState('');
  const [editing, setEditing] = useState<Account | null | 'new'>(null);

  useEffect(() => {
    const openId = searchParams.get('open');
    if (openId && accounts.data) {
      const found = accounts.data.find((a) => a.id === openId);
      if (found) {
        setEditing(found);
        const next = new URLSearchParams(searchParams);
        next.delete('open');
        setSearchParams(next, { replace: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.data]);

  const filtered = (accounts.data ?? []).filter((a) => !liquidity || a.liquidityClass === liquidity);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Select label="Liquidity class" hideLabel value={liquidity} onValueChange={(v) => setLiquidity(v ?? '')} options={[{ value: '', label: 'All accounts' }, ...LIQUIDITY_OPTIONS]} />
        <Button variant="primary" leadingIcon={<Plus size={16} />} onClick={() => setEditing('new')}>
          Add account
        </Button>
      </div>

      <QueryState
        query={accounts}
        loadingLabel="Loading accounts"
        isEmpty={() => filtered.length === 0}
        empty={<EmptyState title="No accounts" description="Add an account, or connect a provider from Connections." />}
      >
        {() => (
          <Table
            caption="Accounts"
            hideCaption
            rows={filtered}
            getRowKey={(a) => a.id}
            onRowClick={setEditing}
            rowActionLabel={(a) => `Edit ${a.name}`}
            columns={[
              {
                key: 'name',
                header: 'Account',
                primary: true,
                cell: (a) => (
                  <span className="flex flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {a.name}
                      {a.openExceptions > 0 && <Badge tone="caution">{a.openExceptions} exception{a.openExceptions === 1 ? '' : 's'}</Badge>}
                      {!a.ownershipConfirmed && <Badge tone="caution">Ownership unconfirmed</Badge>}
                    </span>
                    <span className="text-sm text-ink-3">
                      {a.institution?.name ?? 'No institution'} · {KIND_OPTIONS.find((k) => k.value === a.kind)?.label ?? a.kind}
                    </span>
                  </span>
                ),
              },
              { key: 'liquidity', header: 'Liquidity', hideOnMobile: true, cell: (a) => LIQUIDITY_OPTIONS.find((l) => l.value === a.liquidityClass)?.label },
              { key: 'balance', header: 'Balance', numeric: true, cell: (a) => <Money value={a.valuation.value} unknownReason="Balance unknown." /> },
              { key: 'freshness', header: 'Updated', hideOnMobile: true, cell: (a) => <Freshness state={a.freshness.state} lastUpdatedAt={a.freshness.lastUpdatedAt} label={a.freshness.label} compact /> },
              {
                key: 'actions',
                header: <span className="fos-sr-only">Edit</span>,
                align: 'end',
                cell: (a) => (
                  <button type="button" className="fos-table__action" aria-label={`Edit ${a.name}`} onClick={(e) => { e.stopPropagation(); setEditing(a); }}>
                    <Pencil size={15} aria-hidden="true" />
                  </button>
                ),
              },
            ]}
          />
        )}
      </QueryState>

      {editing && (
        <AccountEditor
          key={editing === 'new' ? 'new' : editing.id}
          account={editing === 'new' ? null : editing}
          open
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </div>
  );
}
