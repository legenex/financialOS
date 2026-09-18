import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Toast as RToast } from 'radix-ui';
import { AlertOctagon, CheckCircle2, Info, X } from 'lucide-react';
import { cx } from '../lib/cx';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: 'info' | 'success' | 'error';
  /** Milliseconds. Errors stay until dismissed by default. */
  duration?: number;
}

interface ToastEntry extends ToastInput {
  id: number;
}

interface ToastApi {
  toast: (input: ToastInput) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => undefined, dismissAll: () => undefined });

/** Result notifications for async actions. Radix Toast announces them through an aria-live region. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(1);
  const toast = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-3), { ...input, id }]);
  }, []);
  const dismissAll = useCallback(() => setToasts([]), []);
  const api = useMemo(() => ({ toast, dismissAll }), [toast, dismissAll]);
  return (
    <ToastContext.Provider value={api}>
      <RToast.Provider swipeDirection="down" label="Notification">
        {children}
        {toasts.map((t) => (
          <RToast.Root
            key={t.id}
            className={cx('fos-toast', `fos-toast--${t.tone ?? 'info'}`)}
            duration={t.duration ?? (t.tone === 'error' ? 1_000_000 : 5000)}
            type={t.tone === 'error' ? 'foreground' : 'background'}
            onOpenChange={(open) => {
              if (!open) setToasts((list) => list.filter((x) => x.id !== t.id));
            }}
          >
            <span className="fos-toast__icon" aria-hidden="true">
              {t.tone === 'success' ? <CheckCircle2 size={18} /> : t.tone === 'error' ? <AlertOctagon size={18} /> : <Info size={18} />}
            </span>
            <div className="fos-toast__content">
              <RToast.Title className="fos-toast__title">{t.title}</RToast.Title>
              {t.description && <RToast.Description className="fos-toast__description">{t.description}</RToast.Description>}
            </div>
            <RToast.Close className="fos-btn fos-iconbtn fos-btn--ghost fos-iconbtn--sm" aria-label="Dismiss notification">
              <X size={16} aria-hidden="true" />
            </RToast.Close>
          </RToast.Root>
        ))}
        <RToast.Viewport className="fos-toast-viewport" />
      </RToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export interface LiveRegionProps {
  children: ReactNode;
  politeness?: 'polite' | 'assertive';
  className?: string;
  /** Hide visually while still announcing. */
  visuallyHidden?: boolean;
}

/** A persistent aria-live region. Render it once and change its children to announce. */
export function LiveRegion({ children, politeness = 'polite', className, visuallyHidden }: LiveRegionProps) {
  return (
    <div
      className={cx(visuallyHidden && 'fos-sr-only', className)}
      role={politeness === 'assertive' ? 'alert' : 'status'}
      aria-live={politeness}
      aria-atomic="true"
    >
      {children}
    </div>
  );
}
