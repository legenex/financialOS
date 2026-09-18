import type { ReactElement, ReactNode } from 'react';
import { Dialog as RDialog } from 'radix-ui';
import { X } from 'lucide-react';
import { cx } from '../lib/cx';

interface OverlayBaseProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  trigger?: ReactElement;
  /** Hide the visible title (still announced). */
  hideTitle?: boolean;
  /** Prevent closing by clicking outside (e.g. forms with unsaved input). */
  modalLock?: boolean;
  className?: string;
  closeLabel?: string;
  /** Element to focus when the dialog opens (defaults to the first focusable). */
  onOpenAutoFocus?: (event: Event) => void;
}

export interface DialogProps extends OverlayBaseProps {
  size?: 'sm' | 'md' | 'lg';
  role?: 'dialog' | 'alertdialog';
}

/** Centered modal dialog. Traps focus, restores it to the trigger on close, closes on Escape. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  trigger,
  hideTitle,
  modalLock,
  size = 'md',
  className,
  closeLabel = 'Close',
  role,
  onOpenAutoFocus,
}: DialogProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RDialog.Trigger asChild>{trigger}</RDialog.Trigger>}
      <RDialog.Portal>
        <RDialog.Overlay className="fos-overlay" />
        <RDialog.Content
          className={cx('fos-dialog', `fos-dialog--${size}`, className)}
          role={role}
          onOpenAutoFocus={onOpenAutoFocus}
          onPointerDownOutside={modalLock ? (e) => e.preventDefault() : undefined}
          onInteractOutside={modalLock ? (e) => e.preventDefault() : undefined}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <header className="fos-dialog__header">
            <RDialog.Title className={cx('fos-dialog__title', hideTitle && 'fos-sr-only')}>{title}</RDialog.Title>
            <RDialog.Close className="fos-btn fos-iconbtn fos-btn--ghost fos-iconbtn--sm fos-dialog__close" aria-label={closeLabel}>
              <X size={18} aria-hidden="true" />
            </RDialog.Close>
          </header>
          {description && <RDialog.Description className="fos-dialog__description">{description}</RDialog.Description>}
          <div className="fos-dialog__body">{children}</div>
          {footer && <footer className="fos-dialog__footer">{footer}</footer>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export const DialogClose = RDialog.Close;

export interface DrawerProps extends OverlayBaseProps {
  /** Width of the side panel on wide screens. */
  width?: 'md' | 'lg';
}

/**
 * Bottom sheet on small screens, side panel from the right on wide screens (≥ 768px).
 * Same focus management as Dialog.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  trigger,
  hideTitle,
  modalLock,
  width = 'md',
  className,
  closeLabel = 'Close',
  onOpenAutoFocus,
}: DrawerProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <RDialog.Trigger asChild>{trigger}</RDialog.Trigger>}
      <RDialog.Portal>
        <RDialog.Overlay className="fos-overlay" />
        <RDialog.Content
          className={cx('fos-drawer', `fos-drawer--${width}`, className)}
          onOpenAutoFocus={onOpenAutoFocus}
          onPointerDownOutside={modalLock ? (e) => e.preventDefault() : undefined}
          onInteractOutside={modalLock ? (e) => e.preventDefault() : undefined}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="fos-drawer__grip" aria-hidden="true" />
          <header className="fos-drawer__header">
            <div className="fos-drawer__titles">
              <RDialog.Title className={cx('fos-drawer__title', hideTitle && 'fos-sr-only')}>{title}</RDialog.Title>
              {description && <RDialog.Description className="fos-drawer__description">{description}</RDialog.Description>}
            </div>
            <RDialog.Close className="fos-btn fos-iconbtn fos-btn--ghost fos-iconbtn--md" aria-label={closeLabel}>
              <X size={18} aria-hidden="true" />
            </RDialog.Close>
          </header>
          <div className="fos-drawer__body">{children}</div>
          {footer && <footer className="fos-drawer__footer">{footer}</footer>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
