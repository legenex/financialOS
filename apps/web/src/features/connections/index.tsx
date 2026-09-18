import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { AuthMethod } from '@financialos/contracts';
import { Badge, Button, Callout, Dialog, EmptyState, PageHeader, Select, Table, TextField } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useEntities } from '../../lib/endpoints';
import { useConnections, useCreateConnection, useProviders } from './api';
import { ConnectionDrawer } from './ConnectionDrawer';
import { connectionStatusTone } from './status';

function AddConnection() {
  const [open, setOpen] = useState(false);
  const providers = useProviders();
  const entities = useEntities();
  const create = useCreateConnection();
  const [providerKey, setProviderKey] = useState<string | null>(null);
  const [method, setMethod] = useState<AuthMethod | null>(null);
  const [name, setName] = useState('');
  const [entityId, setEntityId] = useState<string | null>(null);

  const provider = (providers.data?.items ?? []).find((p) => p.key === providerKey) ?? null;
  const valid = providerKey && method && name.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setProviderKey(null);
          setMethod(null);
          setName('');
        }
      }}
      title="Add a connection"
      trigger={
        <Button variant="primary" leadingIcon={<Plus size={16} />}>
          Add connection
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={create.isPending}
            onClick={() => {
              if (!providerKey || !method) return;
              create.mutate(
                { providerKey, method, name: name.trim(), entityId, config: {} },
                { onSuccess: () => setOpen(false) },
              );
            }}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {create.isError && <Callout tone="critical">{userMessage(create.error)}</Callout>}
        <Select
          label="Provider"
          value={providerKey}
          onValueChange={(v) => {
            setProviderKey(v);
            setMethod(null);
          }}
          options={(providers.data?.items ?? []).map((p) => ({ value: p.key, label: p.name }))}
          placeholder="Choose a provider"
        />
        {provider && (
          <Select
            label="Method"
            value={method}
            onValueChange={(v) => setMethod((v as AuthMethod) ?? null)}
            options={provider.methods.map((m) => ({ value: m.method, label: m.label }))}
            placeholder="Choose a method"
          />
        )}
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder={provider?.name ?? ''} />
        <Select
          label="Entity (optional)"
          value={entityId}
          onValueChange={setEntityId}
          options={(entities.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          placeholder="Not set"
        />
      </div>
    </Dialog>
  );
}

export function Component() {
  const connections = useConnections();
  const providers = useProviders();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? (connections.data ?? []).find((c) => c.id === selectedId) ?? null : null;
  const provider = selected ? (providers.data?.items ?? []).find((p) => p.key === selected.providerKey) ?? null : null;

  return (
    <>
      <PageHeader
        title="Connections"
        description="Providers you've connected for automatic balances and transactions, and what each one still needs from you."
        actions={<AddConnection />}
      />

      <QueryState
        query={connections}
        loadingLabel="Loading connections"
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No connections yet" description="Add a bank, broker or wallet to start syncing balances and transactions automatically." />}
      >
        {(list) => (
          <Table
            caption="Connections"
            hideCaption
            rows={list}
            getRowKey={(c) => c.id}
            onRowClick={(c) => setSelectedId(c.id)}
            rowActionLabel={(c) => `Manage ${c.name}`}
            columns={[
              {
                key: 'name',
                header: 'Connection',
                primary: true,
                cell: (c) => (
                  <span className="flex flex-col gap-1">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-sm text-ink-3">{c.providerName}</span>
                  </span>
                ),
              },
              { key: 'status', header: 'Status', cell: (c) => <Badge tone={connectionStatusTone(c.status)}>{c.status.replace(/_/g, ' ')}</Badge> },
              { key: 'lastSuccess', header: 'Last successful sync', hideOnMobile: true, cell: (c) => (c.lastSuccessAt ? new Date(c.lastSuccessAt).toLocaleString() : 'Never') },
              { key: 'accounts', header: 'Accounts', numeric: true, hideOnMobile: true, cell: (c) => c.accounts.length },
            ]}
          />
        )}
      </QueryState>

      {selected && <ConnectionDrawer connection={selected} provider={provider} open onOpenChange={(o) => !o && setSelectedId(null)} />}
    </>
  );
}
