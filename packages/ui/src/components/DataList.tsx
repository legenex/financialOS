import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cx } from '../lib/cx';
import { useLinkComponent } from '../lib/link';

export interface DataListItem {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  /** Right-aligned value, usually <Money/>. */
  value?: ReactNode;
  /** Small text under the value (e.g. a date or status). */
  valueCaption?: ReactNode;
  href?: string;
  onSelect?: () => void;
  /** Accessible label when the row is interactive and the title is not plain text. */
  actionLabel?: string;
}

export interface DataListProps {
  items: DataListItem[];
  label?: string;
  className?: string;
  dense?: boolean;
  divided?: boolean;
}

/** Mobile-first row list: leading icon, title/subtitle, and a right-aligned tabular value. */
export function DataList({ items, label, className, dense, divided = true }: DataListProps) {
  const Anchor = useLinkComponent();
  return (
    <ul className={cx('fos-datalist', dense && 'fos-datalist--dense', divided && 'fos-datalist--divided', className)} aria-label={label}>
      {items.map((item) => {
        const content = (
          <>
            {item.leading && (
              <span className="fos-datalist__leading" aria-hidden="true">
                {item.leading}
              </span>
            )}
            <span className="fos-datalist__main">
              <span className="fos-datalist__title">{item.title}</span>
              {item.subtitle && <span className="fos-datalist__subtitle">{item.subtitle}</span>}
            </span>
            {(item.value || item.valueCaption) && (
              <span className="fos-datalist__trail">
                {item.value && <span className="fos-datalist__value fos-num">{item.value}</span>}
                {item.valueCaption && <span className="fos-datalist__caption">{item.valueCaption}</span>}
              </span>
            )}
            {(item.href || item.onSelect) && <ChevronRight className="fos-datalist__chevron" size={16} aria-hidden="true" />}
          </>
        );
        return (
          <li key={item.id} className="fos-datalist__item">
            {item.href ? (
              <Anchor href={item.href} className="fos-datalist__row fos-datalist__row--interactive" aria-label={item.actionLabel}>
                {content}
              </Anchor>
            ) : item.onSelect ? (
              <button type="button" className="fos-datalist__row fos-datalist__row--interactive" onClick={item.onSelect} aria-label={item.actionLabel}>
                {content}
              </button>
            ) : (
              <div className="fos-datalist__row">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
