import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { AiProvider, AiProviderInput } from '@financialos/contracts';
import { Badge, Button, Callout, Card, Dialog, EmptyState, NumberField, Select, Switch, TextField, useToast } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useAiProviders } from '../../lib/endpoints';
import { useCreateAiProvider, useSetAiProviderCredentials, useTestAiProvider, useUpdateAiProvider } from './api';

function emptyInput(): AiProviderInput {
  return {
    name: '',
    kind: 'openai_compatible',
    baseUrl: '',
    model: '',
    locality: 'local',
    enabled: false,
    allowIdentifiableData: false,
    monthlyBudgetUsd: null,
    taskRouting: [],
    isOrchestrator: false,
  };
}

function AddProvider() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AiProviderInput>(emptyInput());
  const create = useCreateAiProvider();
  const valid = draft.name.trim() && draft.baseUrl.trim() && draft.model.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setDraft(emptyInput());
      }}
      title="Add an AI provider"
      trigger={
        <Button variant="primary" leadingIcon={<Plus size={16} />}>
          Add provider
        </Button>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={create.isPending} onClick={() => create.mutate(draft, { onSuccess: () => setOpen(false) })}>
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {create.isError && <Callout tone="critical">{userMessage(create.error)}</Callout>}
        <TextField label="Name" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} required maxLength={60} placeholder="Local GX gateway" />
        <Select label="Kind" value={draft.kind} onValueChange={(v) => setDraft((d) => ({ ...d, kind: (v as AiProviderInput['kind']) ?? d.kind }))} options={[{ value: 'openai_compatible', label: 'OpenAI-compatible' }, { value: 'anthropic', label: 'Anthropic' }]} />
        <Select label="Locality" value={draft.locality} onValueChange={(v) => setDraft((d) => ({ ...d, locality: (v as AiProviderInput['locality']) ?? d.locality }))} options={[{ value: 'local', label: 'Local (self-hosted)' }, { value: 'cloud', label: 'Cloud' }]} />
        <TextField label="Base URL" value={draft.baseUrl} onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))} required placeholder="http://127.0.0.1:4000/v1" />
        <TextField label="Model" value={draft.model} onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))} required placeholder="gpt-oss-120b" />
        <NumberField label="Monthly budget (USD, optional)" value={draft.monthlyBudgetUsd} onValueChange={(v) => setDraft((d) => ({ ...d, monthlyBudgetUsd: v }))} />
        <Switch label="Allow identifiable data" description="Send account names and descriptions, not just amounts and categories." checked={draft.allowIdentifiableData} onCheckedChange={(v) => setDraft((d) => ({ ...d, allowIdentifiableData: v }))} />
        <Switch label="Enabled" checked={draft.enabled} onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} />
      </div>
    </Dialog>
  );
}

function ProviderCard({ provider }: { provider: AiProvider }) {
  const update = useUpdateAiProvider();
  const setCredentials = useSetAiProviderCredentials();
  const test = useTestAiProvider();
  const { toast } = useToast();
  const [apiKey, setApiKey] = useState('');

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className="font-medium">{provider.name}</span>
          <p className="text-sm text-ink-3">
            {provider.model} · {provider.locality}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {provider.isOrchestrator && <Badge tone="accent">Orchestrator</Badge>}
          <Badge tone={provider.enabled ? 'positive' : 'neutral'}>{provider.enabled ? 'Enabled' : 'Disabled'}</Badge>
          <Badge tone={provider.hasCredential ? 'neutral' : 'caution'}>{provider.hasCredential ? 'Credential stored' : 'No credential'}</Badge>
        </div>
      </div>

      {provider.lastTest && (
        <p className="text-sm text-ink-3">
          Last test: <Badge tone={provider.lastTest.ok ? 'positive' : 'negative'}>{provider.lastTest.ok ? 'ok' : 'failed'}</Badge> {provider.lastTest.detail}
        </p>
      )}
      <p className="text-sm text-ink-3">
        Spent this month: {provider.usedThisMonthUsd} USD{provider.monthlyBudgetUsd ? ` of ${provider.monthlyBudgetUsd}` : ''}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <TextField label="API key" hideLabel type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="New API key" className="max-w-xs" />
        <Button variant="secondary" size="sm" disabled={!apiKey.trim()} loading={setCredentials.isPending} onClick={() => setCredentials.mutate({ id: provider.id, input: { secrets: { api_key: apiKey } } }, { onSuccess: () => { toast({ title: 'Credential stored', tone: 'success' }); setApiKey(''); } })}>
          Save key
        </Button>
        <Button variant="ghost" size="sm" loading={test.isPending} onClick={() => test.mutate(provider.id, { onSuccess: (r) => toast({ title: r.ok ? 'Test passed' : 'Test failed', description: r.detail, tone: r.ok ? 'success' : 'error' }) })}>
          Test
        </Button>
      </div>

      <Switch label="Enabled" checked={provider.enabled} onCheckedChange={(v) => update.mutate({ id: provider.id, enabled: v })} />
    </Card>
  );
}

export function AiProvidersTab() {
  const providers = useAiProviders();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <AddProvider />
      </div>
      <QueryState
        query={providers}
        loadingLabel="Loading AI providers"
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No AI providers configured" description="Add a local or cloud AI provider to enable the Coach and classification suggestions." />}
      >
        {(list) => (
          <div className="grid gap-3 sm:grid-cols-2">
            {list.map((p) => (
              <ProviderCard key={p.id} provider={p} />
            ))}
          </div>
        )}
      </QueryState>
    </div>
  );
}
