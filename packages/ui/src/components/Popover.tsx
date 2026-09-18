import type { ReactElement, ReactNode } from 'react';
import { Popover as RPopover } from 'radix-ui';
import { cx } from '../lib/cx';

export interface PopoverProps {
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
  /** Accessible label for the popover content region. */
  label?: string;
}

/** Click/tap-anchored panel. Focus moves in on open and returns to the trigger on close. */
export function Popover({ trigger, children, open, onOpenChange, side = 'bottom', align = 'start', className, label }: PopoverProps) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          className={cx('fos-popover', className)}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          aria-label={label}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}

export const PopoverClose = RPopover.Close;

export interface InfoTipProps {
  /** Accessible name of the trigger, e.g. "Why is this unknown?" */
  label: string;
  children: ReactNode;
  trigger: ReactElement;
}

/** A toggletip: like a tooltip but opened by tap or keyboard, so it works on touch screens. */
export function InfoTip({ label, children, trigger }: InfoTipProps) {
  return (
    <Popover trigger={trigger} label={label} side="top" align="center" className="fos-popover--tip">
      <div className="fos-infotip">{children}</div>
    </Popover>
  );
}
