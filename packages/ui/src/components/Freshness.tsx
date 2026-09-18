import { cx } from '../lib/cx';
import { formatRelativeTime } from '../lib/time';

export type FreshnessState = 'fresh' | 'aging' | 'stale' | 'never' | 'unknown';

const STATE_LABEL: Record<FreshnessState, string> = {
  fresh: 'Fresh',
  aging: 'Ageing',
  stale: 'Stale',
  never: 'Never updated',
  unknown: 'Unknown',
};

export interface FreshnessProps {
  state: FreshnessState;
  lastUpdatedAt: string | null;
  /** Current time in ms (server-aligned when available). */
  now?: number;
  label?: string;
  className?: string;
  compact?: boolean;
}

/** Shows how current a data source is: a shaped marker (not colour alone), state, and relative time. */
export function Freshness({ state, lastUpdatedAt, now, label, className, compact }: FreshnessProps) {
  const when = lastUpdatedAt ? formatRelativeTime(lastUpdatedAt, now) : null;
  return (
    <span className={cx('fos-fresh', `fos-fresh--${state}`, compact && 'fos-fresh--compact', className)}>
      <span className="fos-fresh__marker" aria-hidden="true" />
      {label && <span className="fos-fresh__label">{label}</span>}
      <span className="fos-fresh__state">{STATE_LABEL[state]}</span>
      {when && (
        <time className="fos-fresh__time" dateTime={lastUpdatedAt ?? undefined}>
          {compact ? when : `updated ${when}`}
        </time>
      )}
    </span>
  );
}
