import { Outlet } from 'react-router';
import { UiProvider } from '@financialos/ui';
import { RouterLink } from '../components/RouterLink';
import { SessionProvider, useSession } from '../lib/session';
import { PaletteProvider } from './palette';

function SessionScoped() {
  const { epoch, session } = useSession();
  // Remounting on every lock/login discards all in-memory UI state (privacy mask, drafts, palette state).
  return (
    <UiProvider key={epoch} linkComponent={RouterLink} initialMasked={session?.privacyMode ?? false}>
      <PaletteProvider>
        <Outlet />
      </PaletteProvider>
    </UiProvider>
  );
}

export function RootLayout() {
  return (
    <SessionProvider>
      <SessionScoped />
    </SessionProvider>
  );
}
