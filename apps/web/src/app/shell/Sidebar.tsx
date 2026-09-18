import { NavLink, useLocation, useSearchParams } from 'react-router';
import { Logo } from '@financialos/ui';
import { withContext } from '../../lib/context';
import { useSession } from '../../lib/session';
import { CONNECTIONS, PRIMARY, SECONDARY, isActive } from './nav';
import { SignOutButton, ThemeSwitcher } from './Controls';
import { useInboxCount } from './InboxBell';

function expiryTime(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

export function Sidebar() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const { session, timing } = useSession();
  const inboxCount = useInboxCount();
  const initial = session?.ownerName.trim().charAt(0).toUpperCase() || '·';
  const item = (d: (typeof PRIMARY)[number], extra?: string, count?: number) => {
    const Icon = d.icon;
    return (
      <li key={d.id}>
        <NavLink
          to={withContext(d.path, params)}
          className={`fos-navlink ${extra ?? ''}`}
          aria-current={isActive(pathname, d.path) ? 'page' : undefined}
        >
          <span className="fos-navlink__icon" aria-hidden="true">
            <Icon size={18} />
          </span>
          <span className="fos-navlink__label">{d.label}</span>
          {count ? (
            <span className="fos-navlink__count fos-num" aria-label={`${count} open`}>
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </NavLink>
      </li>
    );
  };
  return (
    <aside className="fos-sidebar" aria-label="Sidebar">
      <NavLink to={withContext('/today', params)} className="fos-sidebar__brand" aria-label="FinancialOS, go to Today">
        <Logo size={28} />
      </NavLink>
      <nav aria-label="Primary">
        <ul className="fos-sidebar__group">{PRIMARY.map((d) => item(d))}</ul>
        <ul className="fos-sidebar__group">{item(CONNECTIONS, 'fos-navlink--feature')}</ul>
        <p className="fos-sidebar__heading" id="sidebar-more">
          Workspace
        </p>
        <ul className="fos-sidebar__group" aria-labelledby="sidebar-more">
          {SECONDARY.map((d) => item(d, undefined, d.id === 'inbox' ? inboxCount : undefined))}
        </ul>
      </nav>
      <div className="fos-sidebar__foot">
        <ThemeSwitcher />
        <div className="fos-owner">
          <span className="fos-owner__avatar" aria-hidden="true">
            {initial}
          </span>
          <div className="fos-owner__text">
            <p className="fos-owner__name">{session?.ownerName ?? 'Owner'}</p>
            {timing && <p className="fos-owner__meta fos-num">Session until {expiryTime(timing.deadline)}</p>}
          </div>
          <SignOutButton />
        </div>
      </div>
    </aside>
  );
}
