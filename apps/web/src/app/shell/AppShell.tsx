import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router';
import { OfflineBanner } from '../../components/Banners';
import { ReauthDialog, SessionWarning } from '../../components/SessionWarning';
import { CommandPaletteHost } from '../../features/palette/CommandPaletteHost';
import { BottomTabs } from './BottomTabs';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/** Authenticated layout: sidebar (desktop) or bottom tabs (mobile), top bar, and the routed page. */
export function AppShell() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // Move focus to the page on client-side navigation so screen readers announce the new view.
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [pathname]);
  return (
    <div className="fos-app">
      <a className="fos-skip" href="#main">
        Skip to content
      </a>
      <Sidebar />
      <div className="fos-main-col">
        <OfflineBanner />
        <TopBar />
        <main id="main" ref={mainRef} tabIndex={-1} className="fos-main">
          <Outlet />
        </main>
      </div>
      <BottomTabs />
      <SessionWarning />
      <ReauthDialog />
      <CommandPaletteHost />
    </div>
  );
}
