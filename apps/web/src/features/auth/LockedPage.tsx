import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Lock } from 'lucide-react';
import { Button, Callout } from '@financialos/ui';
import { safeRedirect } from '../../lib/redirect';
import { useSession } from '../../lib/session';

interface LockedState {
  reason?: string;
  from?: string | null;
}

const COPY: Record<string, { title: string; body: string }> = {
  other_tab: { title: 'Your session ended', body: 'It ended in another tab, so this tab is locked too.' },
  signed_out_elsewhere: { title: 'You signed out', body: 'You signed out in another tab, so this tab is locked too.' },
  expired: { title: 'Your session ended', body: 'For your security, sessions last at most 10 minutes.' },
};

/** Calm lock screen. Shows no data. */
export function Component() {
  const location = useLocation();
  const navigate = useNavigate();
  const { lockReason, signedInElsewhere, refresh } = useSession();
  const state = (location.state ?? {}) as LockedState;
  const reason = state.reason ?? lockReason ?? 'expired';
  const copy = COPY[reason] ?? COPY.expired!;
  const next = safeRedirect(state.from ?? null);
  const [checking, setChecking] = useState(false);

  const signIn = () => navigate(`/login?next=${encodeURIComponent(next)}`);
  const continueHere = async () => {
    setChecking(true);
    const result = await refresh();
    setChecking(false);
    if (result === 'authenticated') navigate(next, { replace: true });
    else signIn();
  };

  return (
    <div className="fos-public__card text-center">
      <div className="mb-5 flex justify-center">
        <span className="fos-lock-icon" aria-hidden="true">
          <Lock size={24} />
        </span>
      </div>
      <h1 className="fos-auth-title">{copy.title}</h1>
      <p className="fos-auth-sub">{copy.body}</p>
      {reason !== 'expired' && <p className="mt-1 text-sm text-ink-3">Sessions last at most 10 minutes, whatever you are doing.</p>}
      {signedInElsewhere && (
        <Callout tone="info" className="mt-5 text-left" live>
          You signed in again in another tab.
        </Callout>
      )}
      <div className="mt-8 flex flex-col gap-2">
        {signedInElsewhere ? (
          <Button variant="primary" size="lg" fullWidth onClick={continueHere} loading={checking}>
            Continue
          </Button>
        ) : (
          <Button variant="primary" size="lg" fullWidth onClick={signIn}>
            Sign in again
          </Button>
        )}
      </div>
    </div>
  );
}
