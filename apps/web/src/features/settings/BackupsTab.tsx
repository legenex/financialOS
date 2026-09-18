import { Badge, Button, Callout, DataList, EmptyState, Section, Switch, useToast } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useBackups, useCreateBackup, useSchedules, useUpdateSchedule } from './api';

function backupTone(status: string): 'positive' | 'negative' | 'caution' {
  if (status === 'succeeded') return 'positive';
  if (status === 'failed') return 'negative';
  return 'caution';
}

export function BackupsTab() {
  const backups = useBackups();
  const createBackup = useCreateBackup();
  const schedules = useSchedules();
  const updateSchedule = useUpdateSchedule();
  const { toast } = useToast();

  return (
    <div className="flex flex-col gap-8">
      <Section
        title="Backups"
        description="Encrypted, atomic archives of the database and documents. Retention: 14 daily plus 8 weekly."
        actions={
          <Button variant="secondary" loading={createBackup.isPending} onClick={() => createBackup.mutate(undefined, { onSuccess: () => toast({ title: 'Backup scheduled', tone: 'success' }) })}>
            Back up now
          </Button>
        }
      >
        {createBackup.isError && <Callout tone="critical">{userMessage(createBackup.error)}</Callout>}
        <QueryState
          query={backups}
          loadingLabel="Loading backups"
          isEmpty={(list) => list.length === 0}
          empty={<EmptyState title="No backups yet" description="Run one now, or wait for the daily schedule." />}
        >
          {(list) => (
            <DataList
              label="Backups"
              items={list.slice(0, 20).map((b) => ({
                id: b.id,
                title: new Date(b.startedAt).toLocaleString(),
                subtitle: `${b.sizeBytes ? `${(b.sizeBytes / 1_048_576).toFixed(1)} MB` : ''}${b.restoreVerifiedAt ? ' · restore verified' : ' · not yet restore-verified'}${b.error ? ` · ${b.error}` : ''}`,
                value: <Badge tone={backupTone(b.status)}>{b.status}</Badge>,
              }))}
            />
          )}
        </QueryState>
      </Section>

      <Section title="Automations" description="Scheduled background jobs (backups, restore verification, reconciliation).">
        <QueryState
          query={schedules}
          loadingLabel="Loading schedules"
          isEmpty={(list) => list.length === 0}
          empty={<EmptyState title="No schedules configured" />}
        >
          {(list) => (
            <div className="flex flex-col gap-3">
              {list.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3">
                  <div>
                    <p className="font-medium">{s.label}</p>
                    <p className="text-sm text-ink-3">
                      {s.description} · {s.cron} ({s.timezone})
                    </p>
                    {s.lastRunAt && <p className="text-xs text-ink-3">Last run {new Date(s.lastRunAt).toLocaleString()} · {s.lastStatus}</p>}
                  </div>
                  <Switch
                    label="Enabled"
                    checked={s.enabled}
                    onCheckedChange={(v) => updateSchedule.mutate({ id: s.id, input: { cron: s.cron, timezone: s.timezone, enabled: v } })}
                  />
                </div>
              ))}
            </div>
          )}
        </QueryState>
      </Section>
    </div>
  );
}
