import { Navigate, useLocation } from 'react-router';
import { Button, ErrorState, OfflineState } from '@financialos/ui';
import { NeutralCover } from '../components/NeutralCover';
import { useSession } from '../lib/session';
import { AppShell } from './shell/AppShell';

/**
 * Gate for every private route. Private content renders only while the session is authenticated; any other
 * state unmounts it.
 */
export function PrivateLayout() {
  const { status, refresh } = useSession();
  const location = useLocation();
  switch (status) {
    case 'authenticated':
      return <AppShell />;
    case 'checking':
      return <NeutralCover />;
    case 'anonymous': {
      const next = `${location.pathname}${location.search}`;
      return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
    }
    case 'locked':
      return <Navigate to="/locked" replace />;
    case 'offline':
      return (
        <div className="fos-public">
          <main className="fos-public__main">
            <div className="fos-public__card">
              <OfflineState onRetry={() => void refresh()} />
            </div>
          </main>
        </div>
      );
    default:
      return (
        <div className="fos-public">
          <main className="fos-public__main">
            <div className="fos-public__card">
              <ErrorState
                title="FinancialOS is not responding"
                description="The session could not be checked. Nothing private is shown until it can be."
                actions={
                  <Button variant="primary" size="sm" onClick={() => void refresh()}>
                    Check again
                  </Button>
                }
              />
            </div>
          </main>
        </div>
      );
  }
}
