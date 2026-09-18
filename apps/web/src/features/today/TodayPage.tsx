import { useState, type ReactNode } from 'react';
import {
  ArrowRightLeft,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileUp,
  Link2,
  PiggyBank,
  Plug,
  Scale,
  ShieldCheck,
  Sparkles,
  Tags,
} from 'lucide-react';
import type { NextAction, RunwayResult, TodayResponse, WealthSummary } from '@financialos/contracts';
import {
  AreaTimeline,
  Badge,
  Button,
  Callout,
  Card,
  DataList,
  Donut,
  EmptyState,
  Freshness,
  KeyValue,
  Link,
  LoadingRegion,
  Money,
  PageHeader,
  ProgressBar,
  Section,
  Skeleton,
  Stat,
  StatusBadge,
  decimalSign,
} from '@financialos/ui';
import { StaleBanner } from '../../components/Banners';
import { ExplanationDrawer } from '../../components/ExplanationDrawer';
import { ApiErrorState } from '../../components/QueryState';
import { useFinanceContext, withContext } from '../../lib/context';
import { useToday } from '../../lib/endpoints';
import { formatDate, formatDecimal, ratioForGeometry, relativeDay, todayLong } from '../../lib/format';
import { internalHref, sourceHref } from '../../lib/links';
import { serverNow, useSession } from '../../lib/session';

type ExplainKey = 'safe' | 'runway' | 'wealth' | null;

const ACTION_ICONS: Record<NextAction['kind'], ReactNode> = {
  connect: <Plug size={18} />,
  import: <FileUp size={18} />,
  classify: <Tags size={18} />,
  reconcile: <Scale size={18} />,
  review: <ClipboardCheck size={18} />,
  fund_goal: <PiggyBank size={18} />,
  confirm_policy: <ShieldCheck size={18} />,
  verify: <CheckCircle2 size={18} />,
  plan: <CalendarClock size={18} />,
};

const IMPACT_TONE = { high: 'accent', medium: 'neutral', low: 'neutral' } as const;

function TodaySkeleton() {
  return (
    <LoadingRegion label="Loading today’s overview">
      <div className="fos-card fos-card--pad-lg">
        <div className="fos-card__body flex flex-col gap-3">
          <Skeleton width="8rem" />
          <Skeleton variant="figure" />
          <Skeleton width="14rem" />
          <Skeleton variant="block" height="11rem" className="mt-4" />
        </div>
      </div>
      <Skeleton lines={4} />
    </LoadingRegion>
  );
}

function horizonCaption(data: TodayResponse['safeToSpend']): string {
  const { horizon } = data;
  return `Until ${formatDate(horizon.to, 'short')} · ${horizon.days} day${horizon.days === 1 ? '' : 's'} · ${horizon.basis}`;
}

function SafeToSpendHero({ data, onExplain }: { data: TodayResponse['safeToSpend']; onExplain: () => void }) {
  const insufficient = data.status === 'insufficient_data';
  const missing = data.explanation.missing[0];
  return (
    <Card tone="accent" padding="lg" className="fos-hero" as="section" aria-labelledby="sts-label">
      <Stat
        size="hero"
        label={<span id="sts-label">Safe to spend</span>}
        status={<StatusBadge status={data.status} />}
        value={
          <Money
            value={data.amount}
            size="figure"
            weight="semibold"
            tabular={false}
            unknownLabel="Not enough data yet"
            unknownReason={missing ?? 'Safe-to-spend needs current balances for your everyday accounts.'}
          />
        }
        caption={horizonCaption(data)}
        onExplain={onExplain}
      />
      {data.shortfall && decimalSign(data.shortfall.amount) !== 0 && (
        <Callout tone="critical" className="mt-4" title="Commitments exceed available cash">
          Upcoming commitments and protected reserves are more than your eligible cash by <Money value={data.shortfall} weight="semibold" /> in this
          period.
        </Callout>
      )}
      {insufficient && (
        <Callout tone="info" className="mt-4" title="What’s needed">
          {data.explanation.missing.length ? data.explanation.missing.slice(0, 2).join(' ') : 'Connect or import your everyday accounts to calculate this.'}
        </Callout>
      )}
      <KeyValue
        layout="grid"
        className="mt-6 border-t border-border pt-5"
        items={[
          { key: 'eligible', label: 'Eligible cash', value: <Money value={data.eligibleCash} weight="medium" /> },
          {
            key: 'obligations',
            label: 'Commitments in period',
            value: <Money value={data.obligationsInHorizon} weight="medium" />,
            hint: data.unknownAmountObligations ? `+ ${data.unknownAmountObligations} with unknown amounts` : undefined,
          },
          { key: 'reserves', label: 'Protected reserves', value: <Money value={data.protectedReserves} weight="medium" /> },
          { key: 'inflows', label: 'Expected inflows', value: <Money value={data.expectedInflowsInHorizon} weight="medium" /> },
        ]}
      />
    </Card>
  );
}

function RunwayBlock({ runway, onExplain }: { runway: RunwayResult; onExplain: () => void }) {
  let value: ReactNode;
  let caption: ReactNode;
  switch (runway.status) {
    case 'finite': {
      const months = formatDecimal(runway.months, 1);
      value = months ? `About ${months} months` : 'Finite';
      caption = (
        <>
          {runway.depletionDate ? `Cash would run out around ${formatDate(runway.depletionDate)}` : 'Cash is being used faster than it comes in'}
          {runway.averageMonthlyNetOutflow && (
            <>
              {' '}
              at the recent average net outflow of <Money value={runway.averageMonthlyNetOutflow} /> a month.
            </>
          )}
        </>
      );
      break;
    }
    case 'not_depleting':
      value = 'Not depleting';
      caption = 'Recent cash flow is positive, so there is no run-out date to show.';
      break;
    case 'insufficient_history':
      value = 'Not enough history yet';
      caption = `Runway needs ${runway.minimumHistoryMonths} months of history; FinancialOS has ${runway.historyMonths}.`;
      break;
    default:
      value = 'Can’t calculate yet';
      caption = runway.explanation.missing[0] ?? 'Some balances or transactions are missing.';
  }
  return (
    <Stat
      label="Personal runway"
      value={value}
      caption={caption}
      status={runway.status === 'finite' ? null : <StatusBadge status={runway.status === 'not_depleting' ? 'ok' : 'insufficient_data'} label={runway.status === 'not_depleting' ? 'Positive flow' : 'Limited'} size="sm" />}
      onExplain={onExplain}
    >
      {runway.liquidBalance && (
        <p className="text-sm text-ink-3">
          Based on liquid balance of <Money value={runway.liquidBalance} />
        </p>
      )}
    </Stat>
  );
}

function WealthBlock({ wealth, onExplain }: { wealth: WealthSummary; onExplain: () => void }) {
  const assets = wealth.segments.filter((s) => s.total && decimalSign(s.total.amount) > 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Stat
          size="compact"
          label="Known net worth"
          value={<Money value={wealth.netWorthKnown} weight="semibold" unknownReason="Some holdings have no reliable value yet." />}
          status={<StatusBadge status={wealth.status} size="sm" />}
          onExplain={onExplain}
        />
      </div>
      <DataList
        label="Net worth by segment"
        items={wealth.segments.map((s) => ({
          id: s.liquidityClass,
          title: s.label,
          subtitle: [
            `${s.accountsCounted} counted`,
            s.accountsUnknown ? `${s.accountsUnknown} unknown` : null,
            s.unconvertedCount ? `${s.unconvertedCount} not converted` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          value: <Money value={s.total} unknownReason="No reliable value for this segment yet." />,
          href: s.links[0] ? sourceHref(s.links[0]) : undefined,
        }))}
      />
      {wealth.excludedThirdParty && decimalSign(wealth.excludedThirdParty.amount) !== 0 && (
        <Callout tone="neutral" title="Third-party money excluded">
          <Money value={wealth.excludedThirdParty} weight="medium" /> held for others is not counted as yours.
        </Callout>
      )}
      {assets.length > 1 && (
        <Donut
          title="Assets by liquidity"
          currency={wealth.currency}
          totalLabel="Known assets"
          segments={assets.map((s) => ({ key: s.liquidityClass, label: s.label, value: s.total! }))}
          footnote="Liabilities and unknown values are not part of this chart."
        />
      )}
    </div>
  );
}

function TodayContent({ data }: { data: TodayResponse }) {
  const [explain, setExplain] = useState<ExplainKey>(null);
  const { params } = useFinanceContext();
  const { timing } = useSession();
  const now = serverNow(timing);
  const sts = data.safeToSpend;
  const staleCount = data.freshness.filter((f) => f.state === 'stale').length;
  const link = (path: string) => withContext(path, params);

  return (
    <>
      {staleCount > 0 && (
        <div className="mb-6">
          <StaleBanner count={staleCount} href={link('/connections')} />
        </div>
      )}
      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(18rem,21rem)] lg:items-start lg:gap-10">
        <div className="contents lg:flex lg:flex-col lg:gap-10">
          <div className="order-1 lg:order-none">
            <SafeToSpendHero data={sts} onExplain={() => setExplain('safe')} />
          </div>
          <section className="order-3 lg:order-none" aria-label="Cash-flow timeline">
            <AreaTimeline
              title="Projected cash"
              description="Eligible personal cash after each dated commitment in the period."
              currency={sts.currency}
              lowest={sts.lowestProjectedBalance && sts.lowestProjectedOn ? { date: sts.lowestProjectedOn, balance: sts.lowestProjectedBalance } : null}
              events={sts.timeline.map((p) => ({
                date: p.date,
                label: p.label,
                change: p.kind === 'unknown_amount' ? null : p.change,
                balanceAfter: p.balanceAfter,
              }))}
              emptyDescription="The timeline appears once current balances for your everyday accounts are known."
              emptyAction={
                <Button asChild variant="secondary" size="sm">
                  <Link href={link('/connections')} variant="plain">
                    Connect an account
                  </Link>
                </Button>
              }
            />
          </section>
          <Section className="order-4 lg:order-none" id="upcoming" title="Coming up" description="Dated commitments in the safe-to-spend period.">
            {data.upcoming.length ? (
              <DataList
                label="Upcoming commitments"
                items={data.upcoming.map((u) => ({
                  id: u.id,
                  leading: <ArrowRightLeft size={18} />,
                  title: u.label,
                  subtitle: `${relativeDay(u.date)} · ${u.kind.replace(/_/g, ' ')}`,
                  value: <Money value={u.amount} unknownLabel="Amount unknown" unknownReason="No amount is recorded for this commitment yet." />,
                  valueCaption: formatDate(u.date, 'short'),
                  href: u.links[0] ? link(sourceHref(u.links[0])) : link('/plan/commitments'),
                }))}
              />
            ) : (
              <EmptyState
                size="sm"
                title="No commitments in this period"
                description="Add recurring bills and one-off obligations so safe-to-spend can reserve for them."
                actions={
                  <Button asChild variant="secondary" size="sm">
                    <Link href={link('/plan/commitments')} variant="plain">
                      Add commitments
                    </Link>
                  </Button>
                }
              />
            )}
          </Section>
          <Section
            className="order-8 lg:order-none"
            id="networth"
            title="Net worth"
            description="Secondary to cash flow. Shown by liquidity, never as a single headline, and unknown values are counted rather than guessed."
          >
            <WealthBlock wealth={data.wealth} onExplain={() => setExplain('wealth')} />
          </Section>
        </div>

        <div className="contents lg:flex lg:flex-col lg:gap-10">
          <Section className="order-2 lg:order-none" id="next" title="Next actions" description="The three things that matter most right now.">
            {data.nextActions.length ? (
              <DataList
                label="Next actions"
                items={data.nextActions.map((a) => ({
                  id: a.id,
                  leading: ACTION_ICONS[a.kind] ?? <Sparkles size={18} />,
                  title: a.title,
                  subtitle: a.why,
                  valueCaption: a.impact === 'high' ? <Badge tone={IMPACT_TONE[a.impact]}>High impact</Badge> : undefined,
                  href: link(internalHref(a.href)),
                }))}
              />
            ) : (
              <p className="flex items-center gap-2 text-sm text-ink-2">
                <CheckCircle2 size={16} className="text-positive" aria-hidden="true" /> Nothing needs your attention.
              </p>
            )}
          </Section>
          <Section className="order-5 lg:order-none" id="runway" title="Runway" level={2}>
            <RunwayBlock runway={data.personalRunway} onExplain={() => setExplain('runway')} />
          </Section>
          <Section className="order-6 lg:order-none" id="business" title="Business cash">
            {data.businessWarnings.length ? (
              <div className="flex flex-col gap-3">
                {data.businessWarnings.map((w) => (
                  <Callout
                    key={`${w.entityId}-${w.message}`}
                    tone={w.severity === 'critical' ? 'critical' : w.severity === 'warning' ? 'warning' : 'info'}
                    title={w.entityName}
                    actions={
                      <Link href={link(internalHref(w.href, '/business'))} variant="default">
                        Open {w.entityName}
                      </Link>
                    }
                  >
                    {w.message}
                  </Callout>
                ))}
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-ink-2">
                <CheckCircle2 size={16} className="text-positive" aria-hidden="true" /> No business cash warnings.
              </p>
            )}
          </Section>
          <Section className="order-7 lg:order-none" id="budget" title="Budget">
            {data.budgetProgress ? (
              <div className="flex flex-col gap-3">
                <ProgressBar
                  label={data.budgetProgress.period}
                  value={ratioForGeometry(data.budgetProgress.spent?.amount, data.budgetProgress.planned?.amount)}
                  tone={(ratioForGeometry(data.budgetProgress.spent?.amount, data.budgetProgress.planned?.amount) ?? 0) > 1 ? 'negative' : 'accent'}
                  valueText={
                    <>
                      <Money value={data.budgetProgress.spent} unknownLabel="Spending unknown" /> of <Money value={data.budgetProgress.planned} />
                    </>
                  }
                  ariaValueText="Spent compared with planned"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <StatusBadge status={data.budgetProgress.status} size="sm" />
                  <Link href={link('/plan/budget')}>Open budget</Link>
                </div>
              </div>
            ) : (
              <EmptyState
                size="sm"
                title="No budget for this period"
                actions={
                  <Button asChild variant="secondary" size="sm">
                    <Link href={link('/plan/budget')} variant="plain">
                      Set up a budget
                    </Link>
                  </Button>
                }
              />
            )}
          </Section>
          <Section className="order-9 lg:order-none" id="freshness" title="Data freshness">
            {data.freshness.length ? (
              <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                {data.freshness.map((f) => (
                  <li key={f.label}>
                    <Freshness label={f.label} state={f.state} lastUpdatedAt={f.lastUpdatedAt} now={now} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">No data sources yet.</p>
            )}
            <p className="mt-4">
              <Link href={link('/connections')} variant="default">
                <Link2 size={14} aria-hidden="true" className="mr-1" />
                Manage connections
              </Link>
            </p>
          </Section>
        </div>
      </div>

      <ExplanationDrawer
        open={explain === 'safe'}
        onOpenChange={(o) => setExplain(o ? 'safe' : null)}
        title="How safe-to-spend is calculated"
        explanation={sts.explanation}
        status={sts.status}
        computedAt={sts.computedAt}
      >
        <KeyValue
          items={[
            { key: 'lowest', label: 'Lowest projected balance', value: <Money value={sts.lowestProjectedBalance} /> },
            { key: 'on', label: 'On', value: sts.lowestProjectedOn ? formatDate(sts.lowestProjectedOn) : '—' },
            { key: 'confidence', label: 'Confidence', value: sts.confidence },
          ]}
        />
      </ExplanationDrawer>
      <ExplanationDrawer
        open={explain === 'runway'}
        onOpenChange={(o) => setExplain(o ? 'runway' : null)}
        title="How runway is calculated"
        explanation={data.personalRunway.explanation}
      />
      <ExplanationDrawer
        open={explain === 'wealth'}
        onOpenChange={(o) => setExplain(o ? 'wealth' : null)}
        title="How net worth is calculated"
        explanation={data.wealth.explanation}
        status={data.wealth.status}
      />
    </>
  );
}

export function Component() {
  const { apiParams } = useFinanceContext();
  const query = useToday(apiParams);
  const asOf = query.data?.asOf;
  return (
    <>
      <PageHeader
        eyebrow={todayLong()}
        title="Today"
        meta={
          asOf ? (
            <span className="text-sm text-ink-3">
              As of {new Date(asOf).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              {query.isFetching && ' · refreshing…'}
            </span>
          ) : null
        }
        actions={
          query.data && query.isRefetchError ? (
            <span className="text-sm text-caution" role="status">
              Showing figures from {formatDate(query.data.asOf.slice(0, 10))}; the latest refresh failed.
            </span>
          ) : null
        }
      />
      {query.isPending ? (
        <TodaySkeleton />
      ) : query.isError && !query.data ? (
        <ApiErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : query.data ? (
        <TodayContent data={query.data} />
      ) : null}
    </>
  );
}
