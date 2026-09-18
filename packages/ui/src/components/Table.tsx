import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cx } from '../lib/cx';
import { useLinkComponent } from '../lib/link';

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'start' | 'end' | 'center';
  /** Numeric columns get tabular figures and end alignment. */
  numeric?: boolean;
  /** The column used as the card title on small screens. */
  primary?: boolean;
  /** Omit from the small-screen card. */
  hideOnMobile?: boolean;
  width?: string;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  caption: ReactNode;
  hideCaption?: boolean;
  onRowClick?: (row: T) => void;
  /** Accessible label for the row action, e.g. (row) => `Open ${row.name}`. */
  rowActionLabel?: (row: T) => string;
  getRowHref?: (row: T) => string | null;
  className?: string;
  empty?: ReactNode;
  footer?: ReactNode;
}

/**
 * Responsive table. Wide screens get a semantic <table>; below 768px the same rows render as a card list,
 * so the page never scrolls horizontally.
 */
export function Table<T>({ columns, rows, getRowKey, caption, hideCaption, onRowClick, rowActionLabel, getRowHref, className, empty, footer }: TableProps<T>) {
  const Anchor = useLinkComponent();
  if (rows.length === 0 && empty) return <>{empty}</>;
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const rest = columns.filter((c) => c !== primary && !c.hideOnMobile);
  const interactive = !!onRowClick || !!getRowHref;

  return (
    <div className={cx('fos-table', className)}>
      <div className="fos-table__wide">
        <table className="fos-table__table">
          <caption className={cx('fos-table__caption', hideCaption && 'fos-sr-only')}>{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cx('fos-table__th', (c.numeric || c.align === 'end') && 'fos-table__cell--end', c.align === 'center' && 'fos-table__cell--center')}
                  style={c.width ? { width: c.width } : undefined}
                >
                  {c.header}
                </th>
              ))}
              {interactive && (
                <th scope="col" className="fos-table__th fos-table__th--action">
                  <span className="fos-sr-only">Open</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const href = getRowHref?.(row) ?? null;
              return (
                <tr
                  key={getRowKey(row)}
                  className={cx('fos-table__row', interactive && 'fos-table__row--interactive')}
                  // Pointer convenience only; the action cell is the keyboard path.
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cx('fos-table__td', (c.numeric || c.align === 'end') && 'fos-table__cell--end', c.numeric && 'fos-num', c.align === 'center' && 'fos-table__cell--center')}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                  {interactive && (
                    <td className="fos-table__td fos-table__td--action">
                      {href ? (
                        <Anchor href={href} className="fos-table__action" aria-label={rowActionLabel?.(row) ?? 'Open'}>
                          <ChevronRight size={16} aria-hidden="true" />
                        </Anchor>
                      ) : (
                        <button
                          type="button"
                          className="fos-table__action"
                          aria-label={rowActionLabel?.(row) ?? 'Open'}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRowClick?.(row);
                          }}
                        >
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {footer && <div className="fos-table__footer">{footer}</div>}
      </div>

      <div className="fos-table__narrow">
        <p className={cx('fos-table__caption', hideCaption && 'fos-sr-only')}>{caption}</p>
        <ul className="fos-table__cards">
          {rows.map((row) => {
            const href = getRowHref?.(row) ?? null;
            const body = (
              <>
                <div className="fos-table__card-title">{primary?.cell(row)}</div>
                <dl className="fos-table__card-fields">
                  {rest.map((c) => (
                    <div key={c.key} className="fos-table__card-field">
                      <dt>{c.header}</dt>
                      <dd className={cx(c.numeric && 'fos-num')}>{c.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              </>
            );
            return (
              <li key={getRowKey(row)} className="fos-table__card">
                {href ? (
                  <Anchor href={href} className="fos-table__card-hit" aria-label={rowActionLabel?.(row)}>
                    {body}
                    <ChevronRight size={16} aria-hidden="true" className="fos-table__card-chevron" />
                  </Anchor>
                ) : onRowClick ? (
                  <button type="button" className="fos-table__card-hit" onClick={() => onRowClick(row)} aria-label={rowActionLabel?.(row)}>
                    {body}
                    <ChevronRight size={16} aria-hidden="true" className="fos-table__card-chevron" />
                  </button>
                ) : (
                  <div className="fos-table__card-static">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
        {footer && <div className="fos-table__footer">{footer}</div>}
      </div>
    </div>
  );
}
