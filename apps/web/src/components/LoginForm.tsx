import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { browserSupportsWebAuthn, startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { Eye, EyeOff, Fingerprint, KeyRound } from 'lucide-react';
import type { LoginResult } from '@financialos/contracts';
import { Button, Callout, TextField } from '@financialos/ui';
import { ApiError } from '../lib/api';
import { authApi } from '../lib/endpoints';
import { broadcastLogin, useSession } from '../lib/session';

export interface LoginFormProps {
  launchId?: string;
  onSuccess: (result: LoginResult) => void;
  autoFocus?: boolean;
  submitLabel?: string;
}

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429 || error.code === 'rate_limited' || error.code === 'throttled') {
      return error.retryAfterSeconds
        ? `Too many attempts. For your security, sign-in is paused for ${formatWait(error.retryAfterSeconds)}.`
        : 'Too many attempts. For your security, sign-in is paused for a while.';
    }
    if (error.status === 401 || error.code === 'invalid_credentials') return 'That password or code is not right. Check both and try again.';
    if (error.code === 'setup_required' || error.status === 409) return 'FinancialOS is not set up yet. Finish setup first.';
    if (error.code === 'launch_expired') return 'This sign-in link has expired. Open it again from where you started.';
    if (error.status === 0) return 'Could not reach FinancialOS. Check your connection.';
    return error.message;
  }
  if (error instanceof Error && error.name === 'NotAllowedError') return 'Passkey sign-in was cancelled or timed out.';
  return error instanceof Error ? error.message : 'Sign-in failed.';
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Password + authenticator code (or a recovery code), plus passkey sign-in where the browser supports it. */
export function LoginForm({ launchId, onSuccess, autoFocus = true, submitLabel = 'Sign in' }: LoginFormProps) {
  const { adopt } = useSession();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [pending, setPending] = useState<'password' | 'passkey' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [supportsPasskey] = useState(() => {
    try {
      return browserSupportsWebAuthn();
    } catch {
      return false;
    }
  });
  const codeRef = useRef<HTMLInputElement>(null);
  const formId = useId();

  useEffect(() => {
    if (!blockedUntil) return;
    const id = setTimeout(() => setBlockedUntil(null), Math.max(0, blockedUntil - Date.now()));
    return () => clearTimeout(id);
  }, [blockedUntil]);

  const finish = (result: LoginResult, startedAt: number) => {
    adopt(result.session, startedAt);
    broadcastLogin();
    setPassword('');
    setCode('');
    setRecoveryCode('');
    onSuccess(result);
  };

  const fail = (err: unknown) => {
    setError(loginErrorMessage(err));
    if (err instanceof ApiError && err.retryAfterSeconds) setBlockedUntil(Date.now() + err.retryAfterSeconds * 1000);
    setCode('');
    setRecoveryCode('');
  };

  const codeValid = mode === 'totp' ? /^\d{6}$/.test(code) : recoveryCode.trim().length >= 8;
  const canSubmit = password.length > 0 && codeValid && !pending && !blockedUntil;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending('password');
    setError(null);
    const startedAt = Date.now();
    try {
      const result = await authApi.loginPassword({
        password,
        ...(mode === 'totp' ? { totpCode: code } : { recoveryCode: recoveryCode.trim() }),
        ...(launchId ? { launchId } : {}),
      });
      finish(result, startedAt);
    } catch (err) {
      fail(err);
      codeRef.current?.focus();
    } finally {
      setPending(null);
    }
  };

  const passkey = async () => {
    setPending('passkey');
    setError(null);
    try {
      const options = await authApi.passkeyOptions(launchId);
      const response = await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
      const startedAt = Date.now();
      const result = await authApi.passkeyVerify(response as unknown as Record<string, unknown>, launchId);
      finish(result, startedAt);
    } catch (err) {
      fail(err);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <Callout tone="critical" live>
          {error}
        </Callout>
      )}
      <form id={formId} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          label="Password"
          type={showPassword ? 'text' : 'password'}
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus={autoFocus}
          trailing={
            <button
              type="button"
              className="fos-btn fos-iconbtn fos-btn--ghost fos-iconbtn--sm"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
            </button>
          }
        />
        {mode === 'totp' ? (
          <TextField
            ref={codeRef}
            label="Authenticator code"
            hint="The 6-digit code from your authenticator app."
            name="totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            required
            className="fos-num tracking-[0.2em]"
            labelAside={
              <button type="button" className="fos-link fos-link--subtle text-xs" onClick={() => setMode('recovery')}>
                Use a recovery code
              </button>
            }
          />
        ) : (
          <TextField
            ref={codeRef}
            label="Recovery code"
            hint="Each recovery code works once."
            name="recovery"
            autoComplete="off"
            spellCheck={false}
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            required
            className="font-mono"
            labelAside={
              <button type="button" className="fos-link fos-link--subtle text-xs" onClick={() => setMode('totp')}>
                Use authenticator code
              </button>
            }
          />
        )}
        <Button type="submit" variant="primary" size="lg" fullWidth loading={pending === 'password'} disabled={!canSubmit} leadingIcon={<KeyRound size={18} />}>
          {blockedUntil ? 'Sign-in paused' : submitLabel}
        </Button>
      </form>
      {supportsPasskey ? (
        <>
          <p className="fos-divider-text">or</p>
          <Button variant="secondary" size="lg" fullWidth onClick={passkey} loading={pending === 'passkey'} disabled={!!pending || !!blockedUntil} leadingIcon={<Fingerprint size={18} />}>
            Sign in with passkey
          </Button>
        </>
      ) : (
        <p className="text-center text-xs text-ink-3">This browser does not support passkeys. Use your password and authenticator code.</p>
      )}
    </div>
  );
}
