import type { ReactElement, ReactNode } from 'react';
import { Tooltip as RTooltip } from 'radix-ui';

export const TooltipProvider = RTooltip.Provider;

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Delay before opening, in ms. */
  delay?: number;
}

/**
 * Hover/focus hint. Tooltips enhance and never gate: anything shown here must also be reachable another way
 * (visible text, a popover, or an accessible name). Requires a TooltipProvider (UiProvider includes one).
 */
export function Tooltip({ content, children, side = 'top', align = 'center', delay }: TooltipProps) {
  if (content === null || content === undefined || content === '') return children;
  return (
    <RTooltip.Root delayDuration={delay}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className="fos-tooltip" side={side} align={align} sideOffset={6} collisionPadding={8}>
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
