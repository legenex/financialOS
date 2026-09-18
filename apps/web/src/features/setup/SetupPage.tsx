import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { CheckCircle2, Copy, Download, Fingerprint, KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { PASSWORD_MIN_LENGTH, type SetupStatus, type TotpEnrollment } from '@financialos/contracts';
import { Button, Callout, Checkbox, CodeBlock, KeyValue, LoadingRegion, ProgressBar, Skeleton, Stepper, StatusBadge, TextField } from '@financialos/ui';
import { ApiErrorState } from '../../components/QueryState';
import { ApiError, userMessage } from '../../lib/api';
import { keys, setupApi, useSetupStatus } from '../../lib/endpoints';

export const SETUP_STEPS = [
  { id: 'secret', label: 'Setup secret' },
  { id: 'owner', label: 'Owner & password' },
  { id: 'totp', label: 'Authenticator app' },
  { id: 'recovery', label: 'Recovery codes' },
  { id: 'passkey', label: 'Passkey', optional: true },
  { id: 'seal', label: 'Seal setup' },
] as const;

type StepId = (typeof SETUP_STEPS)[number]['id'];

/** Which step the server state says comes next. */
export function stepFromStatus(status: SetupStatus, passkeyDecided: boolean): StepId {
  if (status.state === 'awaiting_bootstrap_secret') return 'secret';
  if (!status.steps.owner) return 'owner';
  if (!status.steps.totp) return 'totp';
  if (!status.steps.recoveryCodes) return 'recovery';
  if (!status.steps.passkey && !passkeyDecided) return 'passkey';
  return 'seal';
}

/** UTF-8 safe base64 for rendering the server's QR SVG as an image (never injected as HTML). */
export function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function StepHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-6">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {children && <div className="mt-2 text-ink-2">{children}</div>}
    </header>
  );
}

function ErrorCallout({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Callout tone="critical" live className="mb-4">
      {userMessage(error)}
    </Callout>
  );
}

function SecretStep({ onDone }: { onDone: (status: SetupStatus) => void }) {
  const [secret, setSecret] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = secret.trim().length >= 32;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setPending(true);
    setError(null);
    try {
      const status = await setupApi.begin(secret.trim());
      setSecret('');
      onDone(status);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} noValidate>
      <StepHeading title="Enter the one-time setup secret">
        <p>FinancialOS has no default account. Setup is unlocked by a secret that only the host operator can read.</p>
      </StepHeading>
      <Callout tone="info" title="Where to find it" className="mb-5">
        <p>
          The operator reads the one-time setup secret file in the FinancialOS runtime directory on the host. Never paste it anywhere
          else — not in chat, email, notes or screenshots.
        </p>
      </Callout>
      <ErrorCallout error={error} />
      <TextField
        label="Setup secret"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        hint="At least 32 characters. It works once and is removed after setup is sealed."
        className="font-mono"
        required
        autoFocus
      />
      <div className="mt-6 flex justify-end">
        <Button type="submit" variant="primary" loading={pending} disabled={!valid} leadingIcon={<KeyRound size={16} />}>
          Unlock setup
        </Button>
      </div>
    </form>
  );
}

function passwordAdvice(password: string): { tone: 'negative' | 'caution' | 'positive'; text: string } {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { tone: 'negative', text: `${PASSWORD_MIN_LENGTH - password.length} more character${PASSWORD_MIN_LENGTH - password.length === 1 ? '' : 's'} needed` };
  }
  const words = password.trim().split(/\s+/).filter(Boolean);
  if (password.length < 20 && words.length < 4) return { tone: 'caution', text: 'Long enough. Longer passphrases are stronger.' };
  return { tone: 'positive', text: 'Strong length' };
}

function OwnerStep({ onDone }: { onDone: (status: SetupStatus) => void }) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const advice = passwordAdvice(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = name.trim().length > 0 && password.length >= PASSWORD_MIN_LENGTH && confirm === password;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setPending(true);
    setError(null);
    try {
      const status = await setupApi.owner(name.trim(), password);
      setPassword('');
      setConfirm('');
      onDone(status);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <StepHeading title="Create the owner account">
        <p>This is the only account. There is no sign-up and no second user.</p>
      </StepHeading>
      <ErrorCallout error={error} />
      <TextField label="Your name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus hint="Shown in the app only." />
      <TextField
        label="Password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. A passphrase of four or more unrelated words is easy to remember and hard to guess.`}
      />
      <ProgressBar
        label="Password length"
        hideLabel
        size="sm"
        value={Math.min(1, password.length / 24)}
        tone={advice.tone}
        valueText={advice.text}
        ariaValueText={advice.text}
      />
      <TextField
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={mismatch ? 'The passwords do not match.' : undefined}
        required
      />
      <div className="mt-2 flex justify-end">
        <Button type="submit" variant="primary" loading={pending} disabled={!valid}>
          Continue
        </Button>
      </div>
    </form>
  );
}

function groupKey(key: string): string {
  return key.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

function TotpStep({ onDone }: { onDone: (status: SetupStatus) => void }) {
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  const load = () =>
    setupApi
      .totpStart()
      .then(setEnrollment)
      .catch((err: unknown) => setLoadError(err));

  const retry = () => {
    setLoadError(null);
    void load();
  };

  useEffect(() => {
    // Guard against double invocation (StrictMode): one enrolment per visit.
    if (started.current) return;
    started.current = true;
    void load();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return;
    setPending(true);
    setError(null);
    try {
      const status = await setupApi.totpVerify(code);
      setEnrollment(null);
      onDone(status);
    } catch (err) {
      setError(err instanceof ApiError && (err.status === 400 || err.status === 401) ? new Error('That code did not match. Check the time on your phone and try the newest code.') : err);
      setCode('');
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <StepHeading title="Add FinancialOS to your authenticator app">
        <p>Scan the code with an authenticator app (for example a password manager with one-time codes), then enter the 6-digit code it shows.</p>
      </StepHeading>
      {loadError ? (
        <ApiErrorState error={loadError} onRetry={retry} size="sm" />
      ) : !enrollment ? (
        <LoadingRegion label="Preparing your authenticator key">
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <Skeleton variant="block" width="11rem" height="11rem" />
            <Skeleton lines={3} />
          </div>
        </LoadingRegion>
      ) : (
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="flex flex-col items-center gap-3">
            <img className="fos-qr" src={svgToDataUrl(enrollment.qrSvg)} alt="QR code to add FinancialOS to your authenticator app" width={176} height={176} />
            <Button asChild variant="ghost" size="sm">
              <a href={enrollment.otpauthUri}>Open in authenticator app</a>
            </Button>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <CodeBlock label="Can’t scan? Enter this key manually" code={groupKey(enrollment.manualKey)} wrap />
            <form onSubmit={submit} noValidate className="flex flex-col gap-3">
              <ErrorCallout error={error} />
              <TextField
                label="6-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="fos-num tracking-[0.2em]"
                required
              />
              <div className="flex justify-end">
                <Button type="submit" variant="primary" loading={pending} disabled={!/^\d{6}$/.test(code)}>
                  Verify code
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export function recoveryCodesText(codes: string[]): string {
  return [
    'FinancialOS recovery codes',
    'Each code works once. Store them somewhere safe and offline.',
    '',
    ...codes.map((c, i) => `${String(i + 1).padStart(2, ' ')}. ${c}`),
    '',
  ].join('\n');
}

function RecoveryStep({ onDone }: { onDone: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  // Codes exist only in this component's memory; they are dropped on Continue or when the step unmounts.
  const generate = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await setupApi.recoveryCodes();
      setCodes(result.codes);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  const download = () => {
    if (!codes) return;
    const blob = new Blob([recoveryCodesText(codes)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'financialos-recovery-codes.txt';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copy = async () => {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodesText(codes));
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div>
      <StepHeading title="Save your recovery codes">
        <p>If you lose your authenticator, a recovery code replaces the 6-digit code once. They are shown only once.</p>
      </StepHeading>
      <ErrorCallout error={error} />
      {!codes ? (
        <div className="flex flex-col items-start gap-4">
          <Callout tone="warning">Have somewhere safe ready (a password manager or a printed copy kept offline) before you continue.</Callout>
          <Button variant="primary" onClick={generate} loading={pending} leadingIcon={<ShieldCheck size={16} />}>
            Show my recovery codes
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <ol className="fos-codes" aria-label="Recovery codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={download} leadingIcon={<Download size={16} />}>
              Download as text
            </Button>
            <Button variant="secondary" size="sm" onClick={copy} leadingIcon={copied === 'done' ? <CheckCircle2 size={16} /> : <Copy size={16} />}>
              {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy all'}
            </Button>
            <span className="fos-sr-only" role="status">
              {copied === 'done' ? 'Recovery codes copied' : ''}
            </span>
          </div>
          <Checkbox
            label="I stored these codes somewhere safe"
            description="You will not be able to see them again. You can generate a new set later in Settings."
            checked={stored}
            onCheckedChange={setStored}
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!stored}
              onClick={() => {
                setCodes(null);
                onDone();
              }}
            >
              Continue
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PasskeyStep({ status, onDone, onSkip }: { status: SetupStatus; onDone: (status: SetupStatus) => void; onSkip: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [supported] = useState(() => {
    try {
      return browserSupportsWebAuthn();
    } catch {
      return false;
    }
  });
  const enrol = async () => {
    setPending(true);
    setError(null);
    try {
      const options = await setupApi.passkeyOptions();
      const response = await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
      const next = await setupApi.passkeyVerify(response as unknown as Record<string, unknown>);
      onDone(next);
    } catch (err) {
      setError(err instanceof Error && err.name === 'NotAllowedError' ? new Error('Passkey creation was cancelled or timed out.') : err);
    } finally {
      setPending(false);
    }
  };
  return (
    <div>
      <StepHeading title="Add a passkey (optional)">
        <p>A passkey signs you in with your device’s screen lock and cannot be phished. Your password and authenticator keep working either way.</p>
      </StepHeading>
      <KeyValue
        className="mb-5"
        items={[
          { key: 'rp', label: 'Passkey will be bound to', value: <span className="font-mono">{status.rpId}</span> },
          { key: 'origin', label: 'Address', value: <span className="font-mono break-all">{status.origin}</span> },
        ]}
      />
      <Callout tone="info" className="mb-5">
        Passkeys are tied to this hostname. If FinancialOS moves to a different address, you will add a new passkey there; sign in with your
        password and authenticator code in the meantime.
      </Callout>
      <ErrorCallout error={error} />
      {!supported && <Callout tone="warning" className="mb-4">This browser does not support passkeys. You can add one later from a supported browser in Settings.</Callout>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
        {supported && (
          <Button variant="primary" onClick={enrol} loading={pending} leadingIcon={<Fingerprint size={16} />}>
            Add a passkey
          </Button>
        )}
      </div>
    </div>
  );
}

function SealStep({ status, onDone }: { status: SetupStatus; onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const seal = async () => {
    setPending(true);
    setError(null);
    try {
      await setupApi.seal();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  const done = (ok: boolean, optional = false) =>
    ok ? <StatusBadge status="ok" label="Done" size="sm" /> : <StatusBadge status={optional ? 'insufficient_data' : 'open'} label={optional ? 'Skipped' : 'Not done'} size="sm" />;
  const ready = status.steps.owner && status.steps.totp && status.steps.recoveryCodes;
  return (
    <div>
      <StepHeading title="Seal setup">
        <p>Sealing permanently turns off the setup endpoints. After this, the only way in is signing in as the owner.</p>
      </StepHeading>
      <KeyValue
        className="mb-6"
        items={[
          { key: 'owner', label: 'Owner account', value: done(status.steps.owner) },
          { key: 'totp', label: 'Authenticator app', value: done(status.steps.totp) },
          { key: 'codes', label: 'Recovery codes', value: done(status.steps.recoveryCodes) },
          { key: 'passkey', label: 'Passkey', value: done(status.steps.passkey, true) },
        ]}
      />
      <ErrorCallout error={error} />
      <div className="flex justify-end">
        <Button variant="primary" onClick={seal} loading={pending} disabled={!ready} leadingIcon={<Lock size={16} />}>
          Seal setup
        </Button>
      </div>
    </div>
  );
}

export function Component() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statusQuery = useSetupStatus();
  const [override, setOverride] = useState<SetupStatus | null>(null);
  const [passkeyDecided, setPasskeyDecided] = useState(false);

  const status = override ?? statusQuery.data ?? null;

  const adoptStatus = (next: SetupStatus) => {
    setOverride(next);
    queryClient.setQueryData(keys.setupStatus, next);
  };

  if (statusQuery.isPending && !override) {
    return (
      <div className="fos-public__card fos-public__card--wide">
        <LoadingRegion label="Checking setup status">
          <Skeleton variant="figure" />
          <Skeleton lines={4} />
        </LoadingRegion>
      </div>
    );
  }
  if (!status) {
    return (
      <div className="fos-public__card">
        <ApiErrorState error={statusQuery.error} onRetry={() => void statusQuery.refetch()} retrying={statusQuery.isFetching} />
      </div>
    );
  }
  if (status.state === 'sealed') {
    return <Navigate to="/login" replace state={{ sealed: true }} />;
  }

  // The status only advances from this page's own responses, so the recovery step stays on screen until the owner
  // confirms the codes are stored (generating codes does not return a new status).
  const step = stepFromStatus(status, passkeyDecided);
  const index = SETUP_STEPS.findIndex((s) => s.id === step);

  return (
    <div className="fos-public__card fos-public__card--wide">
      <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <div>
          <p className="mb-1 text-xs font-medium tracking-wide text-ink-3 uppercase">First-run setup</p>
          <h1 className="fos-auth-title mb-5">Set up FinancialOS</h1>
          <Stepper steps={SETUP_STEPS.map((s) => ({ id: s.id, label: s.label, optional: 'optional' in s ? s.optional : false }))} current={index} label="Setup progress" />
        </div>
        <div className="min-w-0" aria-live="polite">
          {step === 'secret' && <SecretStep onDone={adoptStatus} />}
          {step === 'owner' && <OwnerStep onDone={adoptStatus} />}
          {step === 'totp' && <TotpStep onDone={adoptStatus} />}
          {step === 'recovery' && (
            <RecoveryStep
              onDone={() => adoptStatus({ ...status, steps: { ...status.steps, recoveryCodes: true } })}
            />
          )}
          {step === 'passkey' && (
            <PasskeyStep
              status={status}
              onDone={(next) => {
                setPasskeyDecided(true);
                adoptStatus(next);
              }}
              onSkip={() => setPasskeyDecided(true)}
            />
          )}
          {step === 'seal' && (
            <SealStep
              status={status}
              onDone={() => {
                queryClient.removeQueries({ queryKey: keys.setupStatus });
                navigate('/login', { replace: true, state: { sealed: true } });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
