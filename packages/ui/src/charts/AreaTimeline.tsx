import { useMemo, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { Money } from '../components/Money';
import { moneyText, type MoneyValue } from '../lib/money';
import { usePrivacy } from '../lib/privacy';
import { formatIsoDate } from '../lib/time';
import { AXIS_TICK, ChartFrame, compactTick, toGeometry, TooltipCard, usePrefersReducedMotion } from './shared';

export interface TimelineEvent {
  date: string;
  label: string;
  change: MoneyValue | null;
  balanceAfter: MoneyValue;
}

export interface AreaTimelineProps {
  title: ReactNode;
  description?: ReactNode;
  events: TimelineEvent[];
  currency: string;
  /** The lowest projected balance and its date, as computed by the server. */
  lowest?: { date: string; balance: MoneyValue } | null;
  height?: number;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  footnote?: ReactNode;
  hideTitle?: boolean;
}

interface DayPoint {
  t: number;
  date: string;
  y: number;
  balance: MoneyValue;
  events: TimelineEvent[];
}

function dayMs(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map((p) => Number.parseInt(p, 10));
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/**
 * Cash-flow timeline: end-of-day projected balance as a stepped area, with the server's lowest point marked
 * and labelled. Balances change on dated events, so the series steps rather than interpolating.
 */
export function AreaTimeline({ title, description, events, currency, lowest, height = 220, emptyDescription, emptyAction, footnote, hideTitle }: AreaTimelineProps) {
  const { masked } = usePrivacy();
  const reducedMotion = usePrefersReducedMotion();

  const days = useMemo<DayPoint[]>(() => {
    const byDate = new Map<string, DayPoint>();
    for (const e of events) {
      const y = toGeometry(e.balanceAfter.amount);
      if (y === null) continue;
      const existing = byDate.get(e.date);
      if (existing) {
        existing.y = y;
        existing.balance = e.balanceAfter;
        existing.events.push(e);
      } else {
        byDate.set(e.date, { t: dayMs(e.date), date: e.date, y, balance: e.balanceAfter, events: [e] });
      }
    }
    return [...byDate.values()].sort((a, b) => a.t - b.t);
  }, [events]);

  const lowestY = lowest ? toGeometry(lowest.balance.amount) : null;
  const minY = Math.min(0, ...days.map((d) => d.y), lowestY ?? 0);
  const crossesZero = days.some((d) => d.y < 0);
  const lowestText = lowest ? `${moneyText(lowest.balance, { masked })} on ${formatIsoDate(lowest.date)}` : null;
  const first = days[0];
  const last = days[days.length - 1];
  const summary =
    first && last
      ? `Projected balance from ${formatIsoDate(first.date)} to ${formatIsoDate(last.date)}${lowestText ? `; lowest point ${lowestText}` : ''}.`
      : 'No projected balances.';

  return (
    <ChartFrame
      title={title}
      description={description}
      hideTitle={hideTitle}
      summary={summary}
      empty={days.length === 0}
      emptyDescription={emptyDescription}
      emptyAction={emptyAction}
      footnote={footnote}
      legend={
        lowest && lowestY !== null ? (
          <p className="fos-chart__callout">
            <span className="fos-chart__callout-dot" aria-hidden="true" />
            Lowest point <Money value={lowest.balance} weight="semibold" /> on {formatIsoDate(lowest.date, 'short')}
          </p>
        ) : null
      }
      columns={[
        { key: 'date', header: 'Date' },
        { key: 'event', header: 'Item' },
        { key: 'change', header: 'Change', numeric: true },
        { key: 'balance', header: 'Balance after', numeric: true },
      ]}
      rows={events.map((e, i) => ({
        key: `${e.date}-${i}`,
        cells: {
          date: formatIsoDate(e.date),
          event: e.label,
          change: e.change ? <Money value={e.change} signed /> : <Money value={null} unknownLabel="Amount unknown" unknownReason="This commitment has no known amount yet." />,
          balance: <Money value={e.balanceAfter} />,
        },
      }))}
    >
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={days} margin={{ top: 16, right: 12, bottom: 0, left: 4 }}>
          <CartesianGrid vertical={false} stroke="var(--fos-chart-grid)" strokeWidth={1} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t: number) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(t))}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: 'var(--fos-chart-axis)' }}
            minTickGap={24}
            height={28}
          />
          <YAxis
            dataKey="y"
            domain={[minY < 0 ? 'auto' : 0, 'auto']}
            tickFormatter={(v: number) => compactTick(v, currency, masked)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={masked ? 8 : 56}
          />
          {crossesZero && <ReferenceLine y={0} stroke="var(--fos-chart-axis)" strokeWidth={1} />}
          <RTooltip
            cursor={{ stroke: 'var(--fos-chart-axis)', strokeWidth: 1 }}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as DayPoint | undefined) : undefined;
              if (!p) return null;
              return (
                <TooltipCard
                  title={formatIsoDate(p.date)}
                  rows={[
                    { key: 'bal', label: 'Balance after', value: <Money value={p.balance} weight="semibold" />, color: 'var(--fos-chart-1)' },
                    ...p.events.slice(0, 4).map((e, i) => ({
                      key: `e${i}`,
                      label: e.label,
                      value: e.change ? <Money value={e.change} signed /> : 'Amount unknown',
                    })),
                  ]}
                />
              );
            }}
          />
          <Area
            type="stepAfter"
            dataKey="y"
            stroke="var(--fos-chart-1)"
            strokeWidth={2}
            fill="var(--fos-chart-wash)"
            fillOpacity={1}
            isAnimationActive={!reducedMotion}
            animationDuration={220}
            activeDot={{ r: 4, fill: 'var(--fos-chart-1)', stroke: 'var(--fos-chart-surface)', strokeWidth: 2 }}
          />
          {lowest && lowestY !== null && (
            <ReferenceDot
              x={dayMs(lowest.date)}
              y={lowestY}
              r={5}
              fill={lowestY < 0 ? 'var(--fos-negative-solid)' : 'var(--fos-ink)'}
              stroke="var(--fos-chart-surface)"
              strokeWidth={2}
              ifOverflow="extendDomain"
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
