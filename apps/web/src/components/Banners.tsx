import { WifiOff, Clock } from 'lucide-react';
import { Link } from '@financialos/ui';
import { useOnline } from '../lib/hooks';

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="fos-banner fos-banner--offline" role="status">
      <WifiOff size={16} aria-hidden="true" />
      <span>You’re offline. FinancialOS needs a connection, and nothing is stored on this device.</span>
    </div>
  );
}

export function StaleBanner({ count, href = '/connections' }: { count: number; href?: string }) {
  if (count <= 0) return null;
  return (
    <div className="fos-banner fos-banner--caution rounded-lg" role="status">
      <Clock size={16} aria-hidden="true" />
      <span>
        {count === 1 ? 'One data source is' : `${count} data sources are`} out of date, so some figures may be behind.
      </span>
      <Link href={href}>Review connections</Link>
    </div>
  );
}
