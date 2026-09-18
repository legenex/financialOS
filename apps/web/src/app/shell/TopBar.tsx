import { Plug, Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { IconButton, Kbd, LogoMark, Tooltip } from '@financialos/ui';
import { withContext } from '../../lib/context';
import { isMac, usePalette } from '../palette';
import { ContextBar, ContextButton } from './ContextControls';
import { PrivacyToggle } from './Controls';
import { InboxBell } from './InboxBell';

export function TopBar() {
  const { setOpen } = usePalette();
  const [params] = useSearchParams();
  const shortcut = isMac() ? '⌘K' : 'Ctrl K';
  return (
    <header className="fos-topbar">
      <Link to={withContext('/today', params)} className="fos-topbar__brand" aria-label="FinancialOS, go to Today">
        <LogoMark size={28} title="" />
      </Link>
      <div className="fos-topbar__context">
        <ContextButton />
        <ContextBar />
      </div>
      <div className="fos-topbar__actions">
        <button type="button" className="fos-searchbtn" onClick={() => setOpen(true)} aria-keyshortcuts="Control+K Meta+K">
          <Search size={16} aria-hidden="true" />
          <span>Search or jump to…</span>
          <Kbd>{shortcut}</Kbd>
        </button>
        <span className="fos-search-icon-only">
          <IconButton label="Search and commands" icon={<Search size={20} />} onClick={() => setOpen(true)} aria-keyshortcuts="Control+K Meta+K" />
        </span>
        <PrivacyToggle />
        <InboxBell />
        <span className="fos-hide-desktop">
          <Tooltip content="Connections">
            <Link to={withContext('/connections', params)} className="fos-btn fos-iconbtn fos-btn--ghost fos-iconbtn--md" aria-label="Connections">
              <span className="fos-btn__icon" aria-hidden="true">
                <Plug size={20} />
              </span>
            </Link>
          </Tooltip>
        </span>
      </div>
    </header>
  );
}
