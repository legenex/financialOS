import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight } from 'lucide-react';
import { cx } from '../lib/cx';

export interface StatDelta {
  /** Rendered value, e.g. <Money signed …/> or "+3%". */
  value: ReactNode;
  direction: 'up' | 'down' | 'flat';
  /** Whether this direction is good for the owner. Drives colour; the arrow carries direction. */
  good?: boolean;
  /** Named comparison period, e.g. "vs last month". */
  period?: string;
}

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  delta?: StatDelta;
  status?: ReactNode;
  /** Short context under the value (e.g. horizon or basis). */
  caption?: ReactNode;
  /** Opens the explanation drawer. Renders a "How this is calculated" control. */
  onExplain?: () => void;
  explainLabel?: string;
  size?: 'hero' | 'default' | 'compact';
  className?: string;
  children?: ReactNode;
}

/** Stat tile: label · value · delta · status · explanation trigger. */
export function Stat({ label, value, delta, status, caption, onExplain, explainLabel = 'How this is calculated', size = 'default', className, children }: StatProps) {
  return (
    <div className={cx('fos-stat', `fos-stat--${size}`, className)}>
      <div className="fos-stat__top">
        <p className="fos-stat__label">{label}</p>
        {status && <div className="fos-stat__status">{status}</div>}
      </div>
      <div className="fos-stat__value">{value}</div>
      {delta && (
        <p className={cx('fos-stat__delta', delta.good === undefined ? 'fos-stat__delta--neutral' : delta.good ? 'fos-stat__delta--good' : 'fos-stat__delta--bad')}>
          <span aria-hidden="true" className="fos-stat__delta-icon">
            {delta.direction === 'up' ? <ArrowUpRight size={14} /> : delta.direction === 'down' ? <ArrowDownRight size={14} /> : <ArrowRight size={14} />}
          </span>
          <span className="fos-sr-only">{delta.direction === 'up' ? 'Up' : delta.direction === 'down' ? 'Down' : 'Unchanged'} </span>
          <span className="fos-num">{delta.value}</span>
          {delta.period && <span className="fos-stat__period"> {delta.period}</span>}
        </p>
      )}
      {caption && <p className="fos-stat__caption">{caption}</p>}
      {children}
      {onExplain && (
        <button type="button" className="fos-stat__explain" onClick={onExplain}>
          {explainLabel}
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
