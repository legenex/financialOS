import { useState } from 'react';
import type { JobRecord } from '@financialos/contracts';
import { Badge, Button, Callout, Card, DataList, EmptyState, KeyValue, PageHeader, Section, Table, TextField } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useCancelJob, useJobs, usePlanDomainMigration, useSystemStatus } from './api';

function healthTone(status: string): 'positive' | 'caution' | 'negative' {
  if (status === 'ok' || status === 'active') return 'positive';
  if (status === 'down' || status === 'error') return 'negative';
  return 'caution';
}

function bytes(n: number | null): string {
  if (n === null) return 'Unknown';
  if (n > 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  return `${(n / 1_048_576).toFixed(0)} MB`;
}

const JOB_STATUS_TONE: Record<string, 'positive' | 'caution' | 'negative' | 'neutral'> = {
  queued: 'neutral',
  running: 'caution',
  succeeded: 'positive',
  failed: 'negative',
  cancelled: 'neutral',
  cancelling: 'caution',
  dead_letter: 'negative',
  retrying: 'caution',
};

function StatusOverview() {
  const status = useSystemStatus();
  return (
    <QueryState query={status} loadingLabel="Loading system status">
      {(s) => (
        <div className="flex flex-col gap-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="flex flex-col gap-2 p-4">
              <span className="text-sm text-ink-3">Route</span>
              <Badge tone={healthTone(s.route.status)}>{s.route.kind.replace(/_/g, ' ')} · {s.route.status.replace(/_/g, ' ')}</Badge>
              <p className="text-xs text-ink-3">{s.route.detail}</p>
              {s.route.ownerSteps.map((step) => (
                <Callout key={step} tone="warning">
                  {step}
                </Callout>
              ))}
            </Card>
            <Card className="flex flex-col gap-2 p-4">
              <span className="text-sm text-ink-3">Database</span>
              <Badge tone={healthTone(s.database.status)}>{s.database.status}</Badge>
              <p className="text-xs text-ink-3">{bytes(s.database.sizeBytes)} · {s.database.migrations}</p>
            </Card>
            <Card className="flex flex-col gap-2 p-4">
              <span className="text-sm text-ink-3">Worker</span>
              <Badge tone={healthTone(s.worker.status)}>{s.worker.status}</Badge>
              <p className="text-xs text-ink-3">{s.worker.lastHeartbeatAt ? `Last heartbeat ${new Date(s.worker.lastHeartbeatAt).toLocaleString()}` : 'No heartbeat yet'}</p>
            </Card>
            <Card className="flex flex-col gap-2 p-4">
              <span className="text-sm text-ink-3">Disk</span>
              <Badge tone={s.disk.warning ? 'caution' : 'positive'}>{bytes(s.disk.freeBytes)} free</Badge>
              <p className="text-xs text-ink-3">of {bytes(s.disk.totalBytes)}</p>
            </Card>
          </div>

          <Section title="Jobs">
            <KeyValue
              layout="grid"
              items={[
                { key: 'queued', label: 'Queued', value: s.jobs.queued },
                { key: 'running', label: 'Running', value: s.jobs.running },
                { key: 'failed', label: 'Failed (24h)', value: s.jobs.failed24h },
                { key: 'dead', label: 'Dead letter', value: s.jobs.deadLetter },
              ]}
            />
          </Section>

          <Section title="Backups">
            {s.backups.last ? (
              <KeyValue
                items={[
                  { key: 'last', label: 'Last backup', value: `${new Date(s.backups.last.startedAt).toLocaleString()} (${s.backups.last.status})` },
                  { key: 'offhost', label: 'Off-host copy', value: s.backups.offhost.configured ? 'Configured' : 'Not configured' },
                  { key: 'encryption', label: 'Encryption', value: s.backups.encryption },
                ]}
              />
            ) : (
              <Callout tone="warning">No backup has run yet.</Callout>
            )}
          </Section>

          <Section title="Encryption at rest">
            <KeyValue
              items={[
                { key: 'secrets', label: 'Secrets', value: s.encryptionAtRest.secrets },
                { key: 'documents', label: 'Documents', value: s.encryptionAtRest.documents },
                { key: 'database', label: 'Database', value: s.encryptionAtRest.database },
                { key: 'disk', label: 'Host disk', value: s.encryptionAtRest.hostDisk },
              ]}
            />
          </Section>

          {s.recentErrors.length > 0 && (
            <Section title="Recent errors">
              <DataList
                label="Recent errors"
                items={s.recentErrors.map((e, i) => ({ id: `${e.at}-${i}`, title: e.message, subtitle: `${e.source} · ${new Date(e.at).toLocaleString()}` }))}
              />
            </Section>
          )}
        </div>
      )}
    </QueryState>
  );
}

function JobRow({ job, onCancel, cancelling }: { job: JobRecord; onCancel: () => void; cancelling: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3">
      <div>
        <p className="font-medium">{job.label}</p>
        <p className="text-sm text-ink-3">
          {job.queue} · attempt {job.attempts}
          {job.error ? ` · ${job.error}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={JOB_STATUS_TONE[job.status] ?? 'neutral'}>{job.status.replace(/_/g, ' ')}</Badge>
        {job.cancellable && (job.status === 'queued' || job.status === 'running' || job.status === 'retrying') && (
          <Button variant="ghost" size="sm" loading={cancelling} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function JobsSection() {
  const jobs = useJobs();
  const cancel = useCancelJob();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  return (
    <Section title="Recent jobs">
      <QueryState query={jobs} loadingLabel="Loading jobs" isEmpty={(list) => list.length === 0} empty={<EmptyState title="No jobs recorded yet" />}>
        {(list) => (
          <div className="flex flex-col gap-2">
            {list.slice(0, 30).map((j) => (
              <JobRow
                key={j.id}
                job={j}
                cancelling={cancel.isPending && cancellingId === j.id}
                onCancel={() => {
                  setCancellingId(j.id);
                  cancel.mutate(j.id);
                }}
              />
            ))}
          </div>
        )}
      </QueryState>
    </Section>
  );
}

function DomainMigrationSection() {
  const plan = usePlanDomainMigration();
  const [origin, setOrigin] = useState('');

  return (
    <Section title="Domain migration" description="Plan moving to a new origin (custom domain or a different Tailscale hostname) before doing it.">
      <div className="flex flex-wrap items-end gap-2">
        <TextField label="Proposed origin" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://financialos.example.com" className="max-w-md" />
        <Button variant="secondary" loading={plan.isPending} disabled={!origin.trim()} onClick={() => plan.mutate({ proposedOrigin: origin.trim() })}>
          Check
        </Button>
      </div>
      {plan.isError && <Callout tone="critical">{userMessage(plan.error)}</Callout>}
      {plan.data && (
        <div className="flex flex-col gap-3">
          <Table
            caption="Migration checks"
            hideCaption
            rows={plan.data.checks}
            getRowKey={(c) => c.id}
            columns={[
              { key: 'label', header: 'Check', primary: true, cell: (c) => c.label },
              { key: 'status', header: 'Status', cell: (c) => <Badge tone={c.status === 'pass' ? 'positive' : c.status === 'fail' ? 'negative' : c.status === 'warning' ? 'caution' : 'neutral'}>{c.status}</Badge> },
              { key: 'detail', header: 'Detail', cell: (c) => c.detail },
            ]}
          />
          {plan.data.consequences.length > 0 && (
            <Callout tone="warning">
              <ul className="list-disc pl-4">
                {plan.data.consequences.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </Callout>
          )}
        </div>
      )}
    </Section>
  );
}

export function Component() {
  return (
    <>
      <PageHeader title="System" description="Deployment route, database and worker health, jobs, backups and domain migration." />
      <div className="flex flex-col gap-8">
        <StatusOverview />
        <JobsSection />
        <DomainMigrationSection />
      </div>
    </>
  );
}
