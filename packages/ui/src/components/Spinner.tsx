import { cx } from '../lib/cx';

export interface SpinnerProps {
  size?: number;
  /** Accessible label. Pass an empty string when the parent already announces busy state. */
  label?: string;
  className?: string;
}

export function Spinner({ size = 20, label = 'Loading', className }: SpinnerProps) {
  return (
    <span
      className={cx('fos-spinner', className)}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}
