import { useMemo, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { Money } from '../components/Money';
import { moneyText, type MoneyValue } from '../lib/money';
import { usePrivacy } from '../lib/privacy';
import { AXIS_TICK, CHART_MUTED, ChartFrame, ChartLegend, compactTick, toGeometry, TooltipCard, usePrefersReducedMotion } from './shared';

export interface ComparisonRow {
  key: string;
  label: string;
  plan: MoneyValue | null;
  actual: MoneyValue | null;
}

export interface BarComparisonProps {
  title: ReactNode;
  description?: ReactNode;
  rows: ComparisonRow[];
  currency: string;
  planLabel?: string;
  actualLabel?: string;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  footnote?: ReactNode;
  hideTitle?: boolean;
}

interface BarDatum {
  key: string;
  label: string;
  plan: number | null;
  actual: number | null;
  /** Direct label text, formatted from the decimal string (not from the geometry number). */
  actualText: string;
  row: ComparisonRow;
}

/**
 * Plan vs actual per category as horizontal grouped bars (emphasis form: actual in the accent, plan muted).
 * Unknown actuals are drawn as gaps and listed as "Unknown" in the table, never as zero.
 */
export function BarComparison({ title, description, rows, currency, planLabel = 'Plan', actualLabel = 'Actual', emptyDescription, emptyAction, footnote, hideTitle }: BarComparisonProps) {
  const { masked } = usePrivacy();
  const reducedMotion = usePrefersReducedMotion();
  const data = useMemo<BarDatum[]>(
    () =>
      rows.map((r) => ({
        key: r.key,
        label: r.label,
        plan: toGeometry(r.plan?.amount),
        actual: toGeometry(r.actual?.amount),
        actualText: r.actual ? moneyText(r.actual, { wholeUnits: true, masked }) : '',
        row: r,
      })),
    [rows, masked],
  );
  const plotted = data.filter((d) => d.plan !== null || d.actual !== null);
  const height = Math.max(120, plotted.length * 48 + 36);
  const summary = `${actualLabel} compared with ${planLabel.toLowerCase()} for ${plotted.length} ${plotted.length === 1 ? 'category' : 'categories'}.`;

  return (
    <ChartFrame
      title={title}
      description={description}
      hideTitle={hideTitle}
      summary={summary}
      empty={plotted.length === 0}
      emptyDescription={emptyDescription}
      emptyAction={emptyAction}
      footnote={footnote}
      legend={
        <ChartLegend
          entries={[
            { key: 'actual', label: actualLabel, color: 'var(--fos-chart-1)' },
            { key: 'plan', label: planLabel, color: CHART_MUTED },
          ]}
        />
      }
      columns={[
        { key: 'label', header: 'Category' },
        { key: 'plan', header: planLabel, numeric: true },
        { key: 'actual', header: actualLabel, numeric: true },
      ]}
      rows={rows.map((r) => ({
        key: r.key,
        cells: {
          label: r.label,
          plan: <Money value={r.plan} />,
          actual: <Money value={r.actual} unknownReason="Spending for this category is not fully classified yet." />,
        },
      }))}
    >
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={plotted} layout="vertical" margin={{ top: 4, right: masked ? 12 : 72, bottom: 0, left: 4 }} barCategoryGap={12} barGap={2}>
          <CartesianGrid horizontal={false} stroke="var(--fos-chart-grid)" strokeWidth={1} />
          <XAxis type="number" tickFormatter={(v: number) => compactTick(v, currency, masked)} tick={AXIS_TICK} tickLine={false} axisLine={false} height={24} />
          <YAxis type="category" dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--fos-chart-axis)' }} width={112} interval={0} />
          <RTooltip
            cursor={{ fill: 'var(--fos-surface-hover)' }}
            content={({ active, payload }) => {
              const d = active ? (payload?.[0]?.payload as BarDatum | undefined) : undefined;
              if (!d) return null;
              return (
                <TooltipCard
                  title={d.label}
                  rows={[
                    { key: 'a', label: actualLabel, value: <Money value={d.row.actual} />, color: 'var(--fos-chart-1)' },
                    { key: 'p', label: planLabel, value: <Money value={d.row.plan} />, color: CHART_MUTED },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="actual" name={actualLabel} fill="var(--fos-chart-1)" radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={!reducedMotion} animationDuration={220}>
            {!masked && (
              <LabelList dataKey="actualText" position="right" offset={6} className="fos-chart__barlabel" />
            )}
          </Bar>
          <Bar dataKey="plan" name={planLabel} fill={CHART_MUTED} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={!reducedMotion} animationDuration={220} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
