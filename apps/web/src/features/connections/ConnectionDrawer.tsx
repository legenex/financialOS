import { useState } from 'react';
import type { Connection, CredentialField, ProviderDescriptor } from '@financialos/contracts';
import { Badge, Button, Callout, DataList, Drawer, Select, Switch, TextField, useToast } from '@financialos/ui';
import { connectionStatusTone } from './status';
import { userMessage } from '../../lib/api';
import { useAccounts, useEntities } from '../../lib/endpoints';
import {
  useDiscoverAccounts,
  useMapAccounts,
  useRemoveConnectionCredentials,
  useRevokeConnection,
  useSetConnectionCredentials,
  useStartOAuth,
  useSyncConnection,
  useTestConnection,
  useUpdateConnection,
} from './api';

function CredentialForm({ connection, fields }: { connection: Connection; fields: CredentialField[] }) {
  const secretFields = fields.filter((f) => f.kind !== 'boolean');
  const [values, setValues] = useState<Record<string, string>>({});
  const set = useSetConnectionCredentials();
  const remove = useRemoveConnectionCredentials();
  const { toast } = useToast();

  if (secretFields.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {set.isError && <Callout tone="critical">{userMessage(set.error)}</Callout>}
      {connection.hasCredential && (
        <Callout tone="info">
          Credentials are stored ({connection.credentialUpdatedAt ? new Date(connection.credentialUpdatedAt).toLocaleString() : 'unknown date'}). Enter a value below only to replace it.
        </Callout>
      )}
      {secretFields.map((f) =>
        f.kind === 'select' ? (
          <Select
            key={f.key}
            label={f.label}
            value={values[f.key] ?? ''}
            onValueChange={(v) => setValues((s) => ({ ...s, [f.key]: v ?? '' }))}
            options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
          />
        ) : (
          <TextField
            key={f.key}
            label={f.label}
            type={f.kind === 'secret' ? 'password' : f.kind === 'url' ? 'url' : 'text'}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
            hint={f.help}
          />
        ),
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          loading={set.isPending}
          disabled={Object.values(values).every((v) => !v.trim())}
          onClick={() =>
            set.mutate(
              { id: connection.id, input: { secrets: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())) } },
              { onSuccess: () => { toast({ title: 'Credentials saved', tone: 'success' }); setValues({}); } },
            )
          }
        >
          Save credentials
        </Button>
        {connection.hasCredential && (
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(connection.id, { onSuccess: () => toast({ title: 'Credentials removed', tone: 'success' }) })}>
            Remove stored credentials
          </Button>
        )}
      </div>
    </div>
  );
}

function AccountMapping({ connection }: { connection: Connection }) {
  const accounts = useAccounts();
  const map = useMapAccounts();
  const { toast } = useToast();
  const [links, setLinks] = useState(() => connection.accounts.map((a) => ({ externalAccountId: a.externalAccountId, accountId: a.accountId, excluded: a.excluded })));

  if (connection.accounts.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {connection.accounts.map((a) => {
        const link = links.find((l) => l.externalAccountId === a.externalAccountId)!;
        return (
          <div key={a.externalAccountId} className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{a.externalName}</p>
              <p className="text-xs text-ink-3">{a.externalMask ? `····${a.externalMask}` : a.currency ?? ''}</p>
            </div>
            <Select
              label="Maps to"
              hideLabel
              value={link.accountId}
              onValueChange={(v) => setLinks((ls) => ls.map((l) => (l.externalAccountId === a.externalAccountId ? { ...l, accountId: v } : l)))}
              options={(accounts.data ?? []).map((acc) => ({ value: acc.id, label: acc.name }))}
              placeholder="Not mapped"
            />
            <Switch
              label="Exclude"
              checked={link.excluded}
              onCheckedChange={(v) => setLinks((ls) => ls.map((l) => (l.externalAccountId === a.externalAccountId ? { ...l, excluded: v } : l)))}
            />
          </div>
        );
      })}
      <div>
        <Button
          variant="secondary"
          size="sm"
          loading={map.isPending}
          onClick={() => map.mutate({ id: connection.id, input: { links } }, { onSuccess: () => toast({ title: 'Account mapping saved', tone: 'success' }) })}
        >
          Save mapping
        </Button>
      </div>
    </div>
  );
}

export function ConnectionDrawer({ connection, provider, open, onOpenChange }: { connection: Connection; provider: ProviderDescriptor | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const entities = useEntities();
  const update = useUpdateConnection();
  const revoke = useRevokeConnection();
  const test = useTestConnection();
  const discover = useDiscoverAccounts();
  const sync = useSyncConnection();
  const startOAuth = useStartOAuth();
  const { toast } = useToast();
  const method = provider?.methods.find((m) => m.method === connection.method) ?? null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title={connection.name}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={connectionStatusTone(connection.status)}>{connection.status.replace(/_/g, ' ')}</Badge>
          <Badge tone="neutral">{connection.providerName}</Badge>
          {connection.paused && <Badge tone="caution">Paused</Badge>}
        </div>
        <p className="text-sm text-ink-3">{connection.statusDetail}</p>
        {connection.nextOwnerStep && <Callout tone="warning">Owner action needed: {connection.nextOwnerStep}</Callout>}
        {connection.lastError && <Callout tone="critical">{connection.lastError}</Callout>}

        <Select
          label="Entity"
          value={connection.entityId}
          onValueChange={(v) => update.mutate({ id: connection.id, input: { entityId: v } })}
          options={(entities.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
          placeholder="Not set"
        />

        {method && method.method !== 'oauth' && method.method !== 'mcp_oauth' && <CredentialForm connection={connection} fields={method.fields} />}

        {(method?.method === 'oauth' || method?.method === 'mcp_oauth') && (
          <Button
            variant="secondary"
            loading={startOAuth.isPending}
            onClick={() =>
              startOAuth.mutate(connection.id, {
                onSuccess: (r) => {
                  window.location.assign(r.authorizationUrl);
                },
              })
            }
          >
            Authorize with {connection.providerName}
          </Button>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" loading={test.isPending} onClick={() => test.mutate(connection.id, { onSuccess: () => toast({ title: 'Test scheduled', tone: 'success' }) })}>
            Test connection
          </Button>
          <Button variant="secondary" size="sm" loading={discover.isPending} onClick={() => discover.mutate(connection.id, { onSuccess: () => toast({ title: 'Account discovery scheduled', tone: 'success' }) })}>
            Discover accounts
          </Button>
          <Button variant="secondary" size="sm" loading={sync.isPending} onClick={() => sync.mutate(connection.id, { onSuccess: () => toast({ title: 'Sync scheduled', tone: 'success' }) })}>
            Sync now
          </Button>
        </div>

        <Switch label="Paused" description="Stop scheduled syncs without deleting the connection." checked={connection.paused} onCheckedChange={(v) => update.mutate({ id: connection.id, input: { paused: v } })} />

        <AccountMapping connection={connection} />

        {connection.recentRuns.length > 0 && (
          <DataList
            label="Recent runs"
            dense
            items={connection.recentRuns.map((r) => ({
              id: r.id,
              title: r.kind,
              subtitle: `${r.status}${r.finishedAt ? ` · ${new Date(r.finishedAt).toLocaleString()}` : ''}`,
              value: r.error ? <span className="text-negative">Failed</span> : null,
            }))}
          />
        )}

        <div className="border-t border-line pt-4">
          <Button
            variant="danger"
            loading={revoke.isPending}
            onClick={() => {
              if (!window.confirm('Revoke this connection and delete its stored credentials?')) return;
              revoke.mutate(connection.id, { onSuccess: () => { toast({ title: 'Connection revoked', tone: 'success' }); onOpenChange(false); } });
            }}
          >
            Revoke connection
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
