import { Bell } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { Tooltip } from '@financialos/ui';
import { withContext } from '../../lib/context';
import { useExceptions, useNotifications } from '../../lib/endpoints';

/** Open exceptions + unread notifications (polled in the background; polling never extends the session). */
export function useInboxCount(): number {
  const exceptions = useExceptions('open', null, { background: true, poll: true });
  const notifications = useNotifications(true);
  return (exceptions.data?.length ?? 0) + (notifications.data?.unread ?? 0);
}

export function InboxBell() {
  const count = useInboxCount();
  const [params] = useSearchParams();
  const label = count ? `Inbox, ${count} need${count === 1 ? 's' : ''} attention` : 'Inbox';
  return (
    <Tooltip content="Inbox">
      <Link to={withContext('/inbox', params)} className="fos-btn fos-iconbtn fos-btn--ghost fos-iconbtn--md" aria-label={label}>
        <span className="fos-btn__icon" aria-hidden="true">
          <Bell size={20} />
        </span>
        {count > 0 && (
          <span className="fos-iconbtn__badge fos-num" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Link>
    </Tooltip>
  );
}
