import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface PrivacyState {
  masked: boolean;
  setMasked: (masked: boolean) => void;
  toggle: () => void;
}

const PrivacyContext = createContext<PrivacyState>({
  masked: false,
  setMasked: () => undefined,
  toggle: () => undefined,
});

/**
 * Session-scoped privacy mask. State lives only in memory; it is never persisted. The app resets it on lock.
 */
export function PrivacyProvider({ children, initialMasked = false }: { children: ReactNode; initialMasked?: boolean }) {
  const [masked, setMasked] = useState(initialMasked);
  const value = useMemo(() => ({ masked, setMasked, toggle: () => setMasked((m) => !m) }), [masked]);
  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

export function usePrivacy(): PrivacyState {
  return useContext(PrivacyContext);
}
