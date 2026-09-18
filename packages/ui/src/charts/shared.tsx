import { useEffect, useId, useState, type ReactNode } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { cx } from '../lib/cx';
import { EmptyState } from '../components/States';
import { SegmentedControl } from '../components/Tabs';

/** Categorical chart slots in fixed order (validated palette; see tokens.css). */
export const CHART_SLOTS = ['var(--fos-chart-1)', 'var(--fos-chart-2)', 'var(--fos-chart-3)', 'var(--fos-chart-4)', 'var(--fos-chart-5)', 'var(--fos-chart-6)'] as const;
export const CHART_OTHER = 'var(--fos-chart-other)';
export const CHART_MUTED = 'var(--fos-chart-muted)';

export const AXIS_TICK = { fill: 'var(--fos-chart-label)', fontSize: 12 } as const;

/**
 * Chart geometry needs JS numbers. This is the ONLY conversion of money to floating point in the UI, and the
 * result is used solely for pixel positions — never displayed, summed for display, or sent anywhere.
 */
export function toGeometry(amount: string | null | undefined): number | null {
  if (amount === null || amount === undefined || !/^-?\d+(\.\d+)?$/.test(amount)) return null;
  return Number(amount);
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Compact axis tick for a currency amount (geometry value). Masked charts show no amounts. */
export function compactTick(value: number, currency: string, masked: boolean, locale = 'en-US'): string {
  if (masked) return '';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(value);
  } catch {
    return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
}

export interface ChartTableColumn {
  key: string;
  header: string;
  numeric?: boolean;
}

export interface ChartFrameProps {
  title: ReactNode;
  description?: ReactNode;
  /** One-sentence summary used as the chart's accessible name. */
  summary: string;
  columns: ChartTableColumn[];
  rows: Array<{ key: string; cells: Record<string, ReactNode> }>;
  /** True when there is nothing honest to plot. */
  empty?: boolean;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  legend?: ReactNode;
  footnote?: ReactNode;
  children: ReactNode;
  className?: string;
  headingLevel?: 2 | 3;
  /** Hide the visible title (when the surrounding section already names the chart). */
  hideTitle?: boolean;
}

/**
 * Figure wrapper for every chart: title, chart/table toggle, legend, footnote, honest empty state.
 * The data table is always in the DOM (visually hidden in chart view) so assistive technology can read it.
 */
export function ChartFrame({
  title,
  description,
  summary,
  columns,
  rows,
  empty,
  emptyTitle = 'Nothing to chart yet',
  emptyDescription = 'This chart appears once there is real data for it. Nothing is estimated or filled in.',
  emptyAction,
  legend,
  footnote,
  children,
  className,
  headingLevel = 3,
  hideTitle,
}: ChartFrameProps) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const id = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <figure className={cx('fos-chart', className)} aria-labelledby={`${id}-title`}>
      <div className="fos-chart__head">
        <div className={cx('fos-chart__titles', hideTitle && 'fos-sr-only')}>
          <Heading id={`${id}-title`} className="fos-chart__title">
            {title}
          </Heading>
          {description && <p className="fos-chart__description">{description}</p>}
        </div>
        {!empty && (
          <SegmentedControl
            size="sm"
            label="Chart view"
            value={view}
            onValueChange={setView}
            options={[
              { value: 'chart', label: <span className="fos-chart__toggle"><BarChart3 size={14} aria-hidden="true" /><span>Chart</span></span> },
              { value: 'table', label: <span className="fos-chart__toggle"><Table2 size={14} aria-hidden="true" /><span>Table</span></span> },
            ]}
          />
        )}
      </div>
      {empty ? (
        <EmptyState size="sm" title={emptyTitle} description={emptyDescription} actions={emptyAction} />
      ) : (
        <>
          {view === 'chart' && (
            <>
              {legend}
              <div className="fos-chart__plot" role="img" aria-label={summary}>
                {children}
              </div>
            </>
          )}
          <div className={cx('fos-chart__table', view === 'chart' && 'fos-sr-only')}>
            <table className="fos-table__table">
              <caption className="fos-sr-only">{summary}</caption>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} scope="col" className={cx('fos-table__th', c.numeric && 'fos-table__cell--end')}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="fos-table__row">
                    {columns.map((c, i) =>
                      i === 0 ? (
                        <th key={c.key} scope="row" className="fos-table__td fos-table__rowhead">
                          {r.cells[c.key]}
                        </th>
                      ) : (
                        <td key={c.key} className={cx('fos-table__td', c.numeric && 'fos-table__cell--end fos-num')}>
                          {r.cells[c.key]}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {footnote && <figcaption className="fos-chart__footnote">{footnote}</figcaption>}
    </figure>
  );
}

export interface LegendEntry {
  key: string;
  label: ReactNode;
  color: string;
  shape?: 'line' | 'rect' | 'dot';
  value?: ReactNode;
}

/** Legend mirrors the mark shape; text stays in ink colours, never the series colour. */
export function ChartLegend({ entries, className }: { entries: LegendEntry[]; className?: string }) {
  return (
    <ul className={cx('fos-legend', className)}>
      {entries.map((e) => (
        <li key={e.key} className="fos-legend__item">
          <span className={cx('fos-legend__key', `fos-legend__key--${e.shape ?? 'rect'}`)} style={{ background: e.color }} aria-hidden="true" />
          <span className="fos-legend__label">{e.label}</span>
          {e.value !== undefined && <span className="fos-legend__value fos-num">{e.value}</span>}
        </li>
      ))}
    </ul>
  );
}

export function TooltipCard({ title, rows }: { title: ReactNode; rows: Array<{ key: string; label: ReactNode; value: ReactNode; color?: string }> }) {
  return (
    <div className="fos-charttip">
      <p className="fos-charttip__title">{title}</p>
      <ul className="fos-charttip__rows">
        {rows.map((r) => (
          <li key={r.key} className="fos-charttip__row">
            {r.color && <span className="fos-charttip__key" style={{ background: r.color }} aria-hidden="true" />}
            <span className="fos-charttip__value fos-num">{r.value}</span>
            <span className="fos-charttip__label">{r.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
