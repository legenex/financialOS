import { useState } from 'react';
import { Badge, Button, Callout, DataList, KeyValue, Section, Select, useToast } from '@financialos/ui';
import { QueryState } from '../../components/QueryState';
import { userMessage } from '../../lib/api';
import { useRevokeSession, useSecurityOverview, useSetIdleTimeout } from './api';

const IDLE_OPTIONS = [
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
  { value: '600', label: '10 minutes' },
];

function hms(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

export function SecurityTab() {
  const security = useSecurityOverview();
  const revoke = useRevokeSession();
  const setIdle = useSetIdleTimeout();
  const { toast } = useToast();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  return (
    <QueryState query={security} loadingLabel="Loading security settings">
      {(s) => (
        <div className="flex flex-col gap-8">
          <Section title="Session timeouts">
            <KeyValue
              items={[
                { key: 'absolute', label: 'Absolute session limit', value: hms(s.absoluteTimeoutSeconds), hint: 'Fixed; every session ends by then, active or not.' },
              ]}
            />
            <Select
              label="Idle timeout"
              value={String(s.idleTimeoutSeconds)}
              onValueChange={(v) => v && setIdle.mutate(Number(v), { onSuccess: () => toast({ title: 'Idle timeout updated', tone: 'success' }) })}
              options={IDLE_OPTIONS}
              className="max-w-xs"
            />
          </Section>

          <Section title={`Two-factor authentication & recovery`}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={s.totpEnabled ? 'positive' : 'caution'}>{s.totpEnabled ? 'TOTP enabled' : 'TOTP not set up'}</Badge>
              <Badge tone={s.recoveryCodesRemaining > 0 ? 'neutral' : 'caution'}>{s.recoveryCodesRemaining} recovery code{s.recoveryCodesRemaining === 1 ? '' : 's'} remaining</Badge>
              <Badge tone="neutral">{s.passkeys.length} passkey{s.passkeys.length === 1 ? '' : 's'}</Badge>
            </div>
          </Section>

          <Section title="Active sessions">
            {revoke.isError && <Callout tone="critical">{userMessage(revoke.error)}</Callout>}
            <DataList
              label="Sessions"
              items={s.sessions
                .filter((session) => !session.revokedAt)
                .map((session) => ({
                  id: session.id,
                  title: session.current ? 'This device (current session)' : session.userAgent ?? 'Unknown device',
                  subtitle: `${session.authMethod} · signed in ${new Date(session.createdAt).toLocaleString()} · expires ${new Date(session.absoluteExpiresAt).toLocaleString()}`,
                  value: session.current ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={revoke.isPending && revokingId === session.id}
                      onClick={() => {
                        setRevokingId(session.id);
                        revoke.mutate(session.id, { onSuccess: () => toast({ title: 'Session revoked', tone: 'success' }) });
                      }}
                    >
                      Revoke
                    </Button>
                  ),
                }))}
            />
          </Section>
        </div>
      )}
    </QueryState>
  );
}
