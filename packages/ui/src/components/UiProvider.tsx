import type { ReactNode } from 'react';
import { LinkProvider, type LinkComponentProps } from '../lib/link';
import { PrivacyProvider } from '../lib/privacy';
import { ToastProvider } from './Toast';
import { TooltipProvider } from './Tooltip';

export interface UiProviderProps {
  children: ReactNode;
  /** Router-aware anchor component. Defaults to a plain <a>. */
  linkComponent?: React.ComponentType<LinkComponentProps & { ref?: React.Ref<HTMLAnchorElement> }>;
  initialMasked?: boolean;
}

/** Providers every FinancialOS surface needs: links, privacy mask, tooltips, toasts. */
export function UiProvider({ children, linkComponent, initialMasked }: UiProviderProps) {
  const content = (
    <PrivacyProvider initialMasked={initialMasked}>
      <TooltipProvider delayDuration={300} skipDelayDuration={200}>
        <ToastProvider>{children}</ToastProvider>
      </TooltipProvider>
    </PrivacyProvider>
  );
  return linkComponent ? <LinkProvider component={linkComponent}>{content}</LinkProvider> : content;
}
