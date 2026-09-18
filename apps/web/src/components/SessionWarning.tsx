import { Dialog, LiveRegion } from '@financialos/ui';
import { useNow } from '../lib/hooks';
import { useSession } from '../lib/session';
import { LoginForm } from './LoginForm';

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Discreet near-expiry notice. It never extends the session: "Sign in again" opens a fresh login, which
 * creates a new, separately bounded session.
 */
export function SessionWarning() {
  const { warning, timing, setReauthOpen } = useSession();
  const now = useNow(1000, warning);
  if (!warning || !timing) return null;
  const remaining = timing.deadline - now;
  return (
    <>
      <LiveRegion visuallyHidden>Your session ends in less than a minute. Sign in again to keep working.</LiveRegion>
      <div className="fos-session-warning" data-testid="session-warning">
        <span>
          Session ends in{' '}
          <span className="fos-session-warning__time fos-num" aria-hidden="true">
            {mmss(remaining)}
          </span>
        </span>
        <button type="button" className="fos-btn fos-btn--sm" onClick={() => setReauthOpen(true)}>
          Sign in again
        </button>
      </div>
    </>
  );
}

export function ReauthDialog() {
  const { reauthOpen, setReauthOpen, status } = useSession();
  if (status !== 'authenticated') return null;
  return (
    <Dialog
      open={reauthOpen}
      onOpenChange={setReauthOpen}
      title="Sign in again"
      description="Signing in starts a new session of up to 10 minutes. Your current session is not extended."
      size="sm"
      modalLock
    >
      <LoginForm onSuccess={() => setReauthOpen(false)} submitLabel="Start new session" />
    </Dialog>
  );
}
