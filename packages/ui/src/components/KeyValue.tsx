import type { ReactNode } from 'react';
import { cx } from '../lib/cx';

export interface KeyValueItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
}

export interface KeyValueProps {
  items: KeyValueItem[];
  layout?: 'rows' | 'grid';
  className?: string;
  /** Right-align values (default true for rows). */
  alignValues?: 'start' | 'end';
}

/** Definition list for label/value pairs. Values are right-aligned with tabular figures in rows layout. */
export function KeyValue({ items, layout = 'rows', className, alignValues }: KeyValueProps) {
  const align = alignValues ?? (layout === 'rows' ? 'end' : 'start');
  return (
    <dl className={cx('fos-kv', `fos-kv--${layout}`, `fos-kv--align-${align}`, className)}>
      {items.map((item) => (
        <div key={item.key} className="fos-kv__row">
          <dt className="fos-kv__label">
            {item.label}
            {item.hint && <span className="fos-kv__hint">{item.hint}</span>}
          </dt>
          <dd className="fos-kv__value fos-num">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
