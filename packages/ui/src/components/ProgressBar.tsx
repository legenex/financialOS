import type { ReactNode } from 'react';
import { Progress } from 'radix-ui';
import { cx } from '../lib/cx';
import type { Tone } from './StatusBadge';

export interface ProgressBarProps {
  /**
   * Fraction complete, 0..1. Presentation geometry only: callers derive it from decimal strings and never feed
   * it back into calculations. Null renders an indeterminate/unknown track.
   */
  value: number | null;
  label: ReactNode;
  /** Visible value text, e.g. "R 1 200 of R 2 000". */
  valueText?: ReactNode;
  /** Accessible value text when valueText is not plain text. */
  ariaValueText?: string;
  tone?: Extract<Tone, 'accent' | 'positive' | 'caution' | 'negative' | 'neutral'>;
  size?: 'sm' | 'md';
  hideLabel?: boolean;
  className?: string;
}

/** Meter-style bar. The unfilled track is a lighter step of the same hue. Overflow (>1) is clamped visually. */
export function ProgressBar({ value, label, valueText, ariaValueText, tone = 'accent', size = 'md', hideLabel, className }: ProgressBarProps) {
  const clamped = value === null ? null : Math.max(0, Math.min(1, value));
  const pct = clamped === null ? null : Math.round(clamped * 1000) / 10;
  return (
    <div className={cx('fos-progress', `fos-progress--${tone}`, `fos-progress--${size}`, className)}>
      {(!hideLabel || valueText) && (
        <div className="fos-progress__meta">
          <span className={cx('fos-progress__label', hideLabel && 'fos-sr-only')}>{label}</span>
          {valueText && <span className="fos-progress__value fos-num">{valueText}</span>}
        </div>
      )}
      <Progress.Root
        className="fos-progress__track"
        value={pct}
        max={100}
        aria-label={typeof label === 'string' ? label : undefined}
        getValueLabel={ariaValueText ? () => ariaValueText : undefined}
      >
        {/* Width is set via transform so the bar animates without layout shift. */}
        <Progress.Indicator
          className={cx('fos-progress__fill', pct === null && 'fos-progress__fill--unknown')}
          style={{ transform: `translateX(-${100 - (pct ?? 0)}%)` }}
        />
      </Progress.Root>
    </div>
  );
}
