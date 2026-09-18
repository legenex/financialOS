import { useMemo } from 'react';
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';
import { moneyText, type MoneyValue } from '../lib/money';
import { usePrivacy } from '../lib/privacy';
import { toGeometry } from './shared';

export interface SparklinePoint {
  label: string;
  value: MoneyValue | null;
}

export interface SparklineProps {
  points: SparklinePoint[];
  /** Accessible description, e.g. "Cash balance, last 12 weeks". */
  label: string;
  height?: number;
  width?: number | `${number}%`;
}

/**
 * Tiny trend line for stat tiles: de-emphasis line with the latest point in the accent. Unknown points are
 * gaps. Renders nothing (not a flat line) when there are fewer than two known points.
 */
export function Sparkline({ points, label, height = 32, width = '100%' }: SparklineProps) {
  const { masked } = usePrivacy();
  const data = useMemo(() => points.map((p, i) => ({ i, y: toGeometry(p.value?.amount), p })), [points]);
  const known = data.filter((d) => d.y !== null);
  if (known.length < 2) return null;
  const lastIndex = known[known.length - 1]!.i;
  const first = known[0]!.p;
  const last = known[known.length - 1]!.p;
  const description = masked
    ? `${label}: trend hidden`
    : `${label}: from ${moneyText(first.value)} (${first.label}) to ${moneyText(last.value)} (${last.label})`;
  return (
    <div className="fos-sparkline" role="img" aria-label={description}>
      <ResponsiveContainer width={width} height={height}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Line
            type="monotone"
            dataKey="y"
            stroke="var(--fos-chart-muted)"
            strokeWidth={2}
            connectNulls={false}
            isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; index?: number }) =>
              props.index === lastIndex && props.cx !== undefined && props.cy !== undefined ? (
                <circle key="last" cx={props.cx} cy={props.cy} r={4} fill="var(--fos-chart-1)" stroke="var(--fos-chart-surface)" strokeWidth={2} />
              ) : (
                <g key={`d${props.index}`} />
              )
            }
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
