import { useId } from 'react';
import { cx } from '../lib/cx';

export interface LogoProps {
  /** Show the wordmark next to the mark. */
  wordmark?: boolean;
  size?: number;
  className?: string;
  /** Accessible name; pass '' when a visible label sits next to it. */
  title?: string;
}

/**
 * FinancialOS identity: a rounded-square tile holding a geometric "F" whose arms read as ledger lines, with a
 * signal dot completing the middle arm. Mirrors packages/ui/assets/logo-mark.svg.
 */
export function LogoMark({ size = 28, className, title = 'FinancialOS' }: Omit<LogoProps, 'wordmark'>) {
  const id = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={cx('fos-logo__mark', className)}
      role={title ? 'img' : undefined}
      aria-labelledby={title ? `${id}-t` : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title id={`${id}-t`}>{title}</title>}
      <rect width="64" height="64" rx="15" className="fos-logo__tile" />
      <rect x="18" y="15" width="8" height="34" rx="4" className="fos-logo__ink" />
      <rect x="18" y="15" width="28" height="8" rx="4" className="fos-logo__ink" />
      <rect x="18" y="28" width="16" height="8" rx="4" className="fos-logo__ink" />
      <circle cx="42" cy="32" r="4" className="fos-logo__dot" />
    </svg>
  );
}

export function Logo({ wordmark = true, size = 28, className, title }: LogoProps) {
  if (!wordmark) return <LogoMark size={size} className={className} title={title} />;
  return (
    <span className={cx('fos-logo', className)}>
      <LogoMark size={size} title="" />
      <span className="fos-logo__word">
        Financial<span className="fos-logo__os">OS</span>
      </span>
    </span>
  );
}
