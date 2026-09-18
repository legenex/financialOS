import { useMemo, type ReactNode } from 'react';
import { Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip } from 'recharts';
import { dec, sum } from '@financialos/domain';
import { Money } from '../components/Money';
import { decimalSign, type MoneyValue } from '../lib/money';
import { CHART_OTHER, CHART_SLOTS, ChartFrame, ChartLegend, toGeometry, TooltipCard, usePrefersReducedMotion } from './shared';

export interface DonutSegment {
  key: string;
  label: string;
  value: MoneyValue;
}

export interface DonutProps {
  title: ReactNode;
  description?: ReactNode;
  segments: DonutSegment[];
  currency: string;
  /** Label for the centre total. */
  totalLabel?: string;
  /** Maximum coloured segments before folding the tail into "Other" (hard cap 5; see tokens.css). */
  maxSegments?: number;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  footnote?: ReactNode;
  hideTitle?: boolean;
}

interface Slice {
  key: string;
  label: string;
  value: MoneyValue;
  share: string;
  y: number;
  fill: string;
}

function shareText(part: MoneyValue, total: MoneyValue): string {
  const t = dec(total.amount);
  if (t.isZero()) return '—';
  return `${dec(part.amount).dividedBy(t).times(100).toDecimalPlaces(1).toFixed(1)}%`;
}

/**
 * Allocation donut with a legend and table fallback. Only positive, same-currency segments are plotted; the
 * tail folds into "Other" (the fold total uses decimal arithmetic). Use for part-to-whole at a glance only.
 */
export function Donut({ title, description, segments, currency, totalLabel = 'Total', maxSegments = 5, emptyDescription, emptyAction, footnote, hideTitle }: DonutProps) {
  const reducedMotion = usePrefersReducedMotion();
  const cap = Math.min(5, Math.max(1, maxSegments));
  const { slices, total, excluded } = useMemo(() => {
    const positive = segments.filter((s) => s.value.currency === currency && decimalSign(s.value.amount) > 0);
    const excludedCount = segments.length - positive.length;
    const sorted = [...positive].sort((a, b) => dec(b.value.amount).comparedTo(dec(a.value.amount)));
    const head = sorted.length > cap + 1 ? sorted.slice(0, cap) : sorted;
    const tail = sorted.length > cap + 1 ? sorted.slice(cap) : [];
    const totalValue = sum(
      positive.map((s) => s.value),
      currency,
    );
    const list: Slice[] = head.map((s, i) => ({
      key: s.key,
      label: s.label,
      value: s.value,
      share: shareText(s.value, totalValue),
      y: toGeometry(s.value.amount) ?? 0,
      fill: CHART_SLOTS[i] ?? CHART_OTHER,
    }));
    if (tail.length) {
      const otherValue = sum(
        tail.map((s) => s.value),
        currency,
      );
      list.push({ key: '__other', label: `Other (${tail.length})`, value: otherValue, share: shareText(otherValue, totalValue), y: toGeometry(otherValue.amount) ?? 0, fill: CHART_OTHER });
    }
    return { slices: list, total: totalValue, excluded: excludedCount };
  }, [segments, currency, cap]);

  const summary = `${slices.length} segments. ${slices.map((s) => `${s.label} ${s.share}`).join(', ')}.`;
  return (
    <ChartFrame
      title={title}
      description={description}
      hideTitle={hideTitle}
      summary={summary}
      empty={slices.length === 0}
      emptyDescription={emptyDescription}
      emptyAction={emptyAction}
      footnote={
        excluded > 0 || footnote ? (
          <>
            {footnote}
            {excluded > 0 && ` ${excluded} item${excluded === 1 ? '' : 's'} not shown (zero, negative, or in another currency).`}
          </>
        ) : undefined
      }
      columns={[
        { key: 'label', header: 'Segment' },
        { key: 'value', header: 'Value', numeric: true },
        { key: 'share', header: 'Share', numeric: true },
      ]}
      rows={slices.map((s) => ({ key: s.key, cells: { label: s.label, value: <Money value={s.value} />, share: s.share } }))}
    >
      <div className="fos-donut">
        <div className="fos-donut__plot">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={slices}
                dataKey="y"
                nameKey="label"
                innerRadius="66%"
                outerRadius="96%"
                paddingAngle={slices.length > 1 ? 1.2 : 0}
                stroke="var(--fos-chart-surface)"
                strokeWidth={2}
                startAngle={90}
                endAngle={-270}
                isAnimationActive={!reducedMotion}
                animationDuration={220}
              />
              <RTooltip
                content={({ active, payload }) => {
                  const s = active ? (payload?.[0]?.payload as Slice | undefined) : undefined;
                  if (!s) return null;
                  return <TooltipCard title={s.label} rows={[{ key: 'v', label: s.share, value: <Money value={s.value} weight="semibold" />, color: s.fill }]} />;
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="fos-donut__center" aria-hidden="true">
            <span className="fos-donut__center-label">{totalLabel}</span>
            <Money value={total} wholeUnits weight="semibold" tabular={false} />
          </div>
        </div>
        <ChartLegend
          className="fos-legend--stacked"
          entries={slices.map((s) => ({
            key: s.key,
            label: s.label,
            color: s.fill,
            value: (
              <>
                <Money value={s.value} wholeUnits /> <span className="fos-legend__share">{s.share}</span>
              </>
            ),
          }))}
        />
      </div>
    </ChartFrame>
  );
}
