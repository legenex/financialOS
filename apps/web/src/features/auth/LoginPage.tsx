import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ExternalLink } from 'lucide-react';
import { Callout, Link, LoadingRegion, Skeleton } from '@financialos/ui';
import type { LoginResult } from '@financialos/contracts';
import { LoginForm } from '../../components/LoginForm';
import { NeutralCover } from '../../components/NeutralCover';
import { useLaunchInfo, useSetupStatus } from '../../lib/endpoints';
import { safeRedirect } from '../../lib/redirect';
import { useSession } from '../../lib/session';

interface LoginState {
  reason?: string;
  sealed?: boolean;
}

/**
 * Sign-in. Never shows private data.
 * Launch mode (?launch=1) always requires a fresh sign-in, even when a session exists, and never redirects
 * using an existing session; after success it goes to the server-provided, same-origin destination.
 */
export function Component() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { status } = useSession();
  const launchMode = params.get('launch') === '1';
  const next = safeRedirect(params.get('next'));
  const state = (location.state ?? {}) as LoginState;
  const launch = useLaunchInfo(launchMode);
  const setup = useSetupStatus({ enabled: !launchMode });

  if (!launchMode && setup.data && setup.data.state !== 'sealed') {
    return <Navigate to="/setup" replace />;
  }
  if (!launchMode && status === 'authenticated') {
    // Normal mode only: an existing valid session continues without a second sign-in.
    return <Navigate to={next} replace />;
  }
  if (!launchMode && status === 'checking') {
    return <NeutralCover />;
  }

  const onSuccess = (result: LoginResult) => {
    const destination = launchMode ? safeRedirect(result.redirectTo, '/today') : safeRedirect(result.redirectTo ?? next);
    navigate(destination, { replace: true });
  };

  const launchInfo = launchMode ? launch.data : undefined;

  return (
    <div className="fos-public__card">
      <header className="mb-6">
        {launchMode ? (
          <>
            <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium tracking-wide text-ink-3 uppercase">
              <ExternalLink size={14} aria-hidden="true" /> Opening from a shortcut
            </p>
            <h1 className="fos-auth-title">{launchInfo ? `Sign in to open ${launchInfo.targetLabel}` : 'Sign in to continue'}</h1>
            <p className="fos-auth-sub">For your security, opening FinancialOS from outside always needs a fresh sign-in.</p>
          </>
        ) : (
          <>
            <h1 className="fos-auth-title">Sign in</h1>
            <p className="fos-auth-sub">Welcome back. Sessions last up to 10 minutes.</p>
          </>
        )}
      </header>

      {state.sealed && (
        <Callout tone="success" className="mb-5" live>
          Setup is sealed. Sign in with the password and authenticator you just set up.
        </Callout>
      )}
      {state.reason === 'signed_out' && (
        <Callout tone="neutral" className="mb-5" live>
          You signed out. Nothing from your session remains on this device.
        </Callout>
      )}
      {launchMode && launch.isError && (
        <Callout tone="warning" className="mb-5" title="This shortcut has expired">
          Open it again from where you started, or sign in normally.{' '}
          <Link href="/login" variant="default">
            Sign in normally
          </Link>
        </Callout>
      )}

      {launchMode && launch.isPending ? (
        <LoadingRegion label="Checking the shortcut">
          <Skeleton variant="block" height="3rem" />
          <Skeleton variant="block" height="3rem" />
        </LoadingRegion>
      ) : (
        <LoginForm launchId={launchInfo?.launchId} onSuccess={onSuccess} />
      )}
    </div>
  );
}
