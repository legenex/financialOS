import { Outlet } from 'react-router';
import { Logo } from '@financialos/ui';
import { OfflineBanner } from '../components/Banners';
import { ThemeSwitcher } from './shell/Controls';

/** Frame for setup, sign-in and the lock screen. Never renders private data. */
export function PublicLayout() {
  return (
    <div className="fos-public">
      <OfflineBanner />
      <header className="fos-public__top">
        <Logo size={30} />
        <div className="w-44">
          <ThemeSwitcher />
        </div>
      </header>
      <main id="main" className="fos-public__main" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="fos-public__foot">
        <p>Private, self-hosted. Sessions end after 10 minutes at most.</p>
      </footer>
    </div>
  );
}
