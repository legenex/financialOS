import type { GlanceResponse, LaunchTarget } from '@financialos/contracts';
import { el, link, svg, type Child } from '../lib/dom';
import {
  clampPercent,
  formatClock,
  formatLongDate,
  formatMoney,
  formatUserCode,
  greetingFor,
  plural,
  type MoneyLike,
} from '../lib/format';
import { ICONS, type IconName } from '../lib/icons';
import { launchUrl } from '../lib/launch';
import type { NewTabView, OfflineReason } from './view';

export interface RenderContext {
  now: number;
  locale?: string;
  onRetry: () => void;
  retrying: boolean;
}

const OPTIONS_PAGE = 'options.html';

const icon = (name: IconName, size = 18, cls?: string) => svg(ICONS[name], { size, class: cls });

function launchLink(
  origin: string,
  target: LaunchTarget,
  props: { class: string; label?: string },
  children: Child[],
): HTMLAnchorElement {
  return link(
    launchUrl(origin, target),
    { class: props.class, attrs: { 'aria-label': props.label, 'data-launch': target } },
    children,
  );
}

function header(view: NewTabView): HTMLElement {
  const actions: Child[] = [];
  if (view.kind === 'connected') {
    const { masked, revealedFields } = view.glance.privacy;
    const shown = !masked && revealedFields.length > 0;
    actions.push(
      el(
        'span',
        {
          class: `privacy-pill ${shown ? 'privacy-pill--shown' : ''}`,
          attrs: {
            'data-privacy': shown ? 'shown' : 'masked',
            title: shown
              ? 'This device may show the amounts you allowed in FinancialOS → Settings → Devices.'
              : 'Amounts are hidden. They appear only if you allow them for this device in FinancialOS.',
          },
        },
        [icon(shown ? 'eye' : 'eyeOff', 16), el('span', { text: shown ? 'Amounts shown' : 'Amounts hidden' })],
      ),
    );
  }
  actions.push(
    link(
      OPTIONS_PAGE,
      { class: 'icon-button', attrs: { 'aria-label': 'New tab settings', title: 'New tab settings' } },
      [icon('sliders', 18)],
    ),
  );
  return el('header', { class: 'topbar' }, [
    el('span', { class: 'brand' }, [
      el('img', { class: 'brand-mark', attrs: { src: 'icons/mark.svg', alt: '', width: '28', height: '28' } }),
      el('span', { class: 'brand-word' }, ['Financial', el('span', { class: 'brand-os', text: 'OS' })]),
    ]),
    el('div', { class: 'topbar-actions' }, actions),
  ]);
}

function hero(ctx: RenderContext, lede: string | null, tone: string | null = null): HTMLElement {
  const date = new Date(ctx.now);
  return el('section', { class: 'hero', attrs: { 'aria-labelledby': 'greeting' } }, [
    el('p', { class: 'overline', text: formatLongDate(date, ctx.locale) }),
    el('h1', { text: greetingFor(date), attrs: { id: 'greeting' } }),
    lede
      ? el('p', { class: `lede ${tone ? `lede--${tone}` : ''}`, text: lede, attrs: { 'data-testid': 'lede' } })
      : null,
  ]);
}

function hidden(note = true): HTMLElement {
  return el('span', { class: 'masked', attrs: { 'data-masked': 'true' } }, [
    icon('lock', 14),
    el('span', { text: 'Hidden' }),
    note ? el('span', { class: 'sr-only', text: ' (amount hidden on this device)' }) : null,
  ]);
}

function amount(value: MoneyLike, ctx: RenderContext, cls = 'amount'): HTMLElement {
  return el('span', {
    class: `${cls} figures`,
    text: formatMoney(value, ctx.locale),
    attrs: { 'data-amount': 'true' },
  });
}

function tileHead(iconName: IconName, label: string, badge?: HTMLElement | null): HTMLElement {
  return el('div', { class: 'tile-head' }, [
    el('span', { class: 'tile-icon' }, [icon(iconName, 18)]),
    el('h2', { class: 'tile-label', text: label }),
    badge ?? null,
    el('span', { class: 'tile-go' }, [icon('arrowRight', 16)]),
  ]);
}

function badge(text: string, tone: 'positive' | 'caution' | 'negative' | 'neutral' | 'info'): HTMLElement {
  return el('span', { class: `badge badge--${tone}`, text });
}

const SPENDING_COPY: Record<
  GlanceResponse['spending']['status'],
  { badge: string; tone: 'positive' | 'caution' | 'negative' | 'neutral'; lede: string }
> = {
  on_track: { badge: 'On track', tone: 'positive', lede: 'Spending is on track.' },
  watch: { badge: 'Worth a look', tone: 'caution', lede: 'Spending is running a little ahead of plan.' },
  over: { badge: 'Over plan', tone: 'negative', lede: 'Spending is over plan for this period.' },
  unknown: { badge: 'Not enough data', tone: 'neutral', lede: 'There is not enough data yet to judge this period.' },
};

function spendingTile(glance: GlanceResponse, origin: string, ctx: RenderContext): HTMLElement {
  const s = glance.spending;
  const copy = SPENDING_COPY[s.status];
  const elapsed = clampPercent(s.percentOfPeriodElapsed);
  const used = s.percentOfPlanUsed === null ? null : clampPercent(s.percentOfPlanUsed, 999);
  const bar = el(
    'div',
    {
      class: `meter meter--${copy.tone}`,
      attrs: {
        role: 'img',
        'aria-label':
          used === null
            ? `Plan usage unknown. ${elapsed}% of the period has passed.`
            : `${used}% of plan used. ${elapsed}% of the period has passed.`,
      },
    },
    [el('span', { class: 'meter-fill' }), el('span', { class: 'meter-marker' })],
  );
  bar.style.setProperty('--fill', `${used === null ? 0 : Math.min(used, 100)}%`);
  bar.style.setProperty('--marker', `${elapsed}%`);
  if (used !== null && used > 100) bar.classList.add('meter--overflow');

  const remaining = s.budgetRemaining ? amount(s.budgetRemaining, ctx, 'side-amount') : hidden();
  return launchLink(origin, 'plan', { class: 'tile tile--spending', label: undefined }, [
    tileHead('trend', `Spending · ${s.periodLabel}`, badge(copy.badge, copy.tone)),
    el('div', { class: 'spend-row' }, [
      el(
        'p',
        { class: 'figure' },
        used === null
          ? [el('span', { class: 'figure-unknown', text: 'Unknown' })]
          : [el('span', { class: 'figures', text: String(used) }), el('span', { class: 'figure-unit', text: '%' })],
      ),
      el('p', { class: 'figure-caption', text: used === null ? 'plan usage not available yet' : 'of plan used' }),
      el('p', { class: 'side' }, [el('span', { class: 'side-label', text: 'Left in budget' }), remaining]),
    ]),
    bar,
    el('p', { class: 'meter-caption' }, [el('span', { class: 'marker-dot' }), `${elapsed}% of the period has passed`]),
  ]);
}

function safeToSpendTile(glance: GlanceResponse, origin: string, ctx: RenderContext): HTMLElement {
  const s = glance.spending;
  const statusBadge =
    s.safeToSpendStatus === 'provisional'
      ? badge('Provisional', 'caution')
      : s.safeToSpendStatus === 'insufficient_data'
        ? badge('Needs data', 'neutral')
        : null;
  let body: Child[];
  if (s.safeToSpend) {
    body = [
      amount(s.safeToSpend, ctx, 'figure-amount'),
      el('p', {
        class: 'tile-note',
        text:
          s.safeToSpendStatus === 'provisional'
            ? 'Some inputs are estimates.'
            : 'After upcoming commitments and reserves.',
      }),
    ];
  } else if (s.safeToSpendStatus === 'insufficient_data') {
    body = [
      el('p', { class: 'figure-quiet', text: 'Not enough data yet' }),
      el('p', { class: 'tile-note', text: 'Connect or import accounts to see this.' }),
    ];
  } else {
    body = [
      el('p', { class: 'figure-hidden' }, [hidden()]),
      el('p', {
        class: 'tile-note privacy-note',
        text: 'Amounts stay hidden on this device unless you allow them in FinancialOS → Settings → Devices.',
      }),
    ];
  }
  return launchLink(origin, 'today', { class: 'tile tile--safe' }, [
    tileHead('wallet', 'Safe to spend', statusBadge),
    el('div', { class: 'tile-body' }, body),
  ]);
}

function dueTile(glance: GlanceResponse, origin: string, ctx: RenderContext): HTMLElement {
  const d = glance.dueSoon;
  const window = `in the next ${plural(d.windowDays, 'day', 'days')}`;
  const body: Child[] = [
    el('p', { class: 'figure' }, [el('span', { class: 'figures', text: String(d.count) })]),
    el('p', {
      class: 'figure-caption',
      text: d.count === 0 ? `Nothing due ${window}` : `${d.count === 1 ? 'item' : 'items'} due ${window}`,
    }),
  ];
  const details: Child[] = [];
  if (d.nextLabel)
    details.push(
      el('span', { class: 'detail' }, [
        el('span', { class: 'detail-label', text: 'Next' }),
        el('span', { class: 'detail-value', text: d.nextLabel }),
      ]),
    );
  if (d.count > 0)
    details.push(
      el('span', { class: 'detail' }, [
        el('span', { class: 'detail-label', text: 'Total' }),
        d.total ? amount(d.total, ctx, 'detail-value') : hidden(),
      ]),
    );
  if (details.length) body.push(el('div', { class: 'details' }, details));
  return launchLink(origin, 'commitments', { class: 'tile tile--due' }, [
    tileHead('calendar', 'Due soon'),
    el('div', { class: 'tile-body' }, body),
  ]);
}

function attentionTile(glance: GlanceResponse, origin: string): HTMLElement {
  const n = glance.attention.openExceptions;
  return launchLink(origin, 'inbox', { class: `tile tile--attention ${n > 0 ? 'tile--attention-open' : ''}` }, [
    tileHead('inbox', 'Needs attention', n > 0 ? badge(String(n), 'caution') : null),
    el('div', { class: 'tile-body' }, [
      n > 0
        ? el('p', { class: 'figure-quiet', text: `${plural(n, 'item', 'items')} to review` })
        : el('p', { class: 'figure-quiet figure-quiet--calm' }, [icon('check', 18), el('span', { text: 'All clear' })]),
      el('p', {
        class: 'tile-note',
        text: n > 0 ? 'Open the inbox to confirm or dismiss them.' : 'Nothing is waiting in your inbox.',
      }),
    ]),
  ]);
}

function goalsTile(glance: GlanceResponse, origin: string, ctx: RenderContext): HTMLElement {
  const goals = glance.goals.slice(0, 3);
  const content: Child =
    goals.length === 0
      ? el('p', { class: 'tile-note', text: 'No goals yet. Add one in FinancialOS to track it here.' })
      : el(
          'ul',
          { class: 'goal-list' },
          goals.map((goal) => {
            const percent = clampPercent(goal.percent);
            const bar = el(
              'span',
              { class: 'goal-bar', attrs: { role: 'img', 'aria-label': `${goal.label}: ${percent}%` } },
              [el('span', { class: 'goal-fill' })],
            );
            bar.style.setProperty('--fill', `${percent}%`);
            return el('li', { class: 'goal' }, [
              el('div', { class: 'goal-line' }, [
                el('span', { class: 'goal-label', text: goal.label }),
                el('span', { class: 'goal-meta' }, [
                  goal.amount ? amount(goal.amount, ctx, 'goal-amount') : null,
                  el('span', { class: 'goal-percent figures', text: `${percent}%` }),
                ]),
              ]),
              bar,
            ]);
          }),
        );
  return launchLink(origin, 'goals', { class: 'tile tile--goals' }, [tileHead('flag', 'Goals'), content]);
}

const NUDGE_LABEL: Record<GlanceResponse['nudge']['kind'], string> = {
  review: 'A gentle review',
  reconcile: 'Tidy up',
  connect: 'Keep data flowing',
  goal: 'Goal check-in',
  calm: 'Steady as you go',
};

function nudgeTile(glance: GlanceResponse, origin: string): HTMLElement {
  const n = glance.nudge;
  return launchLink(origin, n.kind === 'connect' ? 'connections' : 'coach', { class: 'tile tile--nudge' }, [
    tileHead('sparkle', 'Coach'),
    el('div', { class: 'tile-body' }, [
      el('p', { class: 'nudge-kicker', text: NUDGE_LABEL[n.kind] }),
      el('p', { class: 'nudge-text', text: n.text }),
    ]),
  ]);
}

const FRESHNESS_COPY: Record<GlanceResponse['freshness']['state'], string> = {
  fresh: 'Financial data is up to date',
  aging: 'Some financial data is a little behind',
  stale: 'Financial data needs a refresh',
  unknown: 'Data freshness unknown',
};

function connected(view: Extract<NewTabView, { kind: 'connected' }>, ctx: RenderContext): Child[] {
  const { glance, origin } = view;
  const freshnessTarget: LaunchTarget = glance.freshness.state === 'fresh' ? 'today' : 'connections';
  const freshBits: Child[] = [
    el('span', { class: 'fresh-updated', text: `Last updated at ${formatClock(view.fetchedAt, ctx.locale)}` }),
  ];
  const out: Child[] = [
    hero(ctx, SPENDING_COPY[glance.spending.status].lede, SPENDING_COPY[glance.spending.status].tone),
    view.refreshProblem
      ? el('p', { class: 'notice', attrs: { role: 'status' } }, [
          icon('cloudOff', 16),
          `Could not refresh just now. Showing the glance from ${formatClock(view.fetchedAt, ctx.locale)} until ${formatClock(view.displayUntil, ctx.locale)}.`,
        ])
      : null,
    el('div', { class: 'grid', attrs: { 'data-testid': 'glance' } }, [
      spendingTile(glance, origin, ctx),
      safeToSpendTile(glance, origin, ctx),
      dueTile(glance, origin, ctx),
      attentionTile(glance, origin),
      goalsTile(glance, origin, ctx),
      nudgeTile(glance, origin),
    ]),
    el('div', { class: 'footer-row' }, [
      launchLink(origin, freshnessTarget, { class: `freshness freshness--${glance.freshness.state}` }, [
        el('span', { class: 'fresh-dot' }),
        el('span', { class: 'fresh-text' }, [
          el('span', { text: FRESHNESS_COPY[glance.freshness.state] }),
          ...freshBits,
        ]),
      ]),
      launchLink(origin, 'today', { class: 'button button--primary', label: 'Open FinancialOS' }, [
        el('span', { text: 'Open FinancialOS' }),
        icon('arrowRight', 18),
      ]),
    ]),
  ];
  return out;
}

function stateCard(options: {
  icon: IconName;
  title: string;
  body: Child[];
  actions: Child[];
  tone?: string;
  testId: string;
}): HTMLElement {
  return el(
    'section',
    {
      class: `state-card ${options.tone ? `state-card--${options.tone}` : ''}`,
      attrs: { 'data-state': options.testId, 'aria-labelledby': 'state-title' },
    },
    [
      el('span', { class: 'state-icon' }, [icon(options.icon, 22)]),
      el('h2', { class: 'state-title', text: options.title, attrs: { id: 'state-title' } }),
      ...options.body,
      el('div', { class: 'state-actions' }, options.actions),
    ],
  );
}

const para = (text: string, cls = 'state-text') => el('p', { class: cls, text });

function optionsButton(text: string, primary = true): HTMLElement {
  return link(OPTIONS_PAGE, { class: `button ${primary ? 'button--primary' : 'button--secondary'}` }, [
    el('span', { text }),
    icon('arrowRight', 18),
  ]);
}

function openButton(origin: string, primary = false): HTMLElement {
  return launchLink(
    origin,
    'today',
    { class: `button ${primary ? 'button--primary' : 'button--secondary'}`, label: 'Open FinancialOS' },
    [el('span', { text: 'Open FinancialOS' }), icon('external', 16)],
  );
}

const OFFLINE_COPY: Record<OfflineReason, { title: string; text: string }> = {
  unreachable: {
    title: 'FinancialOS is out of reach',
    text: 'Your glance is paused. Nothing is shown until FinancialOS confirms fresh data.',
  },
  unavailable: {
    title: 'FinancialOS is busy',
    text: 'FinancialOS could not answer just now. Nothing is shown until it confirms fresh data.',
  },
  invalid: {
    title: 'Glance unavailable',
    text: 'FinancialOS sent a glance this extension does not understand. Check that both are up to date.',
  },
  refused: {
    title: 'FinancialOS declined this device',
    text: 'Check Settings → Devices in FinancialOS, or pair this browser again.',
  },
  expired: {
    title: 'Your glance has expired',
    text: 'The last glance is too old to show. A fresh one will load shortly.',
  },
};

function offline(view: Extract<NewTabView, { kind: 'offline' }>, ctx: RenderContext): HTMLElement {
  const copy = OFFLINE_COPY[view.reason];
  const when =
    view.nextCheckAt && view.nextCheckAt > ctx.now
      ? `Next automatic check after ${formatClock(view.nextCheckAt, ctx.locale)}, when you open a new tab.`
      : 'A new tab will check again.';
  const retry = el('button', { class: 'button button--secondary', attrs: { type: 'button', 'data-action': 'retry' } }, [
    icon('refresh', 16),
    el('span', { text: ctx.retrying ? 'Checking…' : 'Try again' }),
  ]);
  if (ctx.retrying) retry.setAttribute('disabled', '');
  retry.addEventListener('click', ctx.onRetry);
  const actions: Child[] =
    view.reason === 'refused'
      ? [optionsButton('Pairing settings', false), openButton(view.origin)]
      : [retry, openButton(view.origin)];
  return stateCard({
    icon: view.reason === 'refused' ? 'shield' : 'cloudOff',
    title: copy.title,
    body: [para(copy.text), para(when, 'state-hint')],
    actions,
    tone: 'neutral',
    testId: `offline-${view.reason}`,
  });
}

export function renderView(root: HTMLElement, view: NewTabView, ctx: RenderContext): void {
  const content: Child[] = [];
  switch (view.kind) {
    case 'not_configured':
      content.push(
        hero(ctx, null),
        stateCard({
          icon: 'compass',
          title: 'Connect FinancialOS',
          body: [
            para('See a calm, private glance at your plan each time you open a new tab. Pairing takes about a minute.'),
            el('ul', { class: 'assurances' }, [
              el('li', {}, [icon('check', 16), 'View-only: it cannot move money or change anything']),
              el('li', {}, [icon('check', 16), 'No browsing history, no access to other sites']),
              el('li', {}, [icon('check', 16), 'Amounts stay hidden unless you allow them']),
            ]),
          ],
          actions: [optionsButton('Connect FinancialOS')],
          testId: 'not-configured',
        }),
      );
      break;
    case 'not_paired':
      content.push(
        hero(ctx, null),
        stateCard({
          icon: 'key',
          title: 'Finish pairing',
          body: [para(`FinancialOS is set to ${view.origin}. Pair this browser to see your glance here.`)],
          actions: [optionsButton('Pair this browser')],
          testId: 'not-paired',
        }),
      );
      break;
    case 'awaiting_approval':
      content.push(
        hero(ctx, null),
        stateCard({
          icon: 'key',
          title: 'Waiting for approval',
          body: [
            para('In FinancialOS, open Settings → Devices → Pair a device and enter this code:'),
            el('p', {
              class: 'user-code figures',
              text: formatUserCode(view.userCode),
              attrs: { 'aria-label': `Pairing code ${view.userCode.split('').join(' ')}` },
            }),
            para(
              `The code expires at ${formatClock(view.deadline, ctx.locale)}. Keep the settings page open to finish pairing.`,
              'state-hint',
            ),
          ],
          actions: [optionsButton('Open pairing settings')],
          testId: 'awaiting-approval',
        }),
      );
      break;
    case 'pairing_ended':
      content.push(
        hero(ctx, null),
        stateCard({
          icon: 'unplug',
          title: 'Pairing ended — pair again',
          body: [
            para(
              view.reason === 'expired'
                ? 'This browser’s access to FinancialOS has expired. Nothing is shown until you pair again.'
                : 'FinancialOS no longer accepts this browser (it was revoked or has expired). The stored credential has been removed.',
            ),
          ],
          actions: [optionsButton('Pair again'), openButton(view.origin)],
          tone: 'neutral',
          testId: 'pairing-ended',
        }),
      );
      break;
    case 'origin_mismatch':
      content.push(
        hero(ctx, null),
        stateCard({
          icon: 'shield',
          title: 'Pair again for the new address',
          body: [
            para(
              `This browser was paired with ${view.pairedOrigin}, but FinancialOS is now set to ${view.configuredOrigin}.`,
            ),
            para('The credential is never sent to a different address. Pair again to continue.', 'state-hint'),
          ],
          actions: [optionsButton('Open settings')],
          tone: 'neutral',
          testId: 'origin-mismatch',
        }),
      );
      break;
    case 'loading':
      content.push(hero(ctx, null), skeleton());
      break;
    case 'offline':
      content.push(hero(ctx, null), offline(view, ctx));
      break;
    case 'connected':
      content.push(...connected(view, ctx));
      break;
  }
  const main = el(
    'main',
    {
      class: 'content',
      attrs: { id: 'main', 'data-view': view.kind, 'aria-busy': view.kind === 'loading' ? 'true' : 'false' },
    },
    content,
  );
  root.replaceChildren(header(view), main);
}

export function skeleton(): HTMLElement {
  const block = (cls: string) =>
    el('div', { class: `tile skeleton ${cls}`, attrs: { 'aria-hidden': 'true' } }, [
      el('span', { class: 'sk-line sk-short' }),
      el('span', { class: 'sk-line sk-big' }),
      el('span', { class: 'sk-line' }),
    ]);
  return el('div', { class: 'grid', attrs: { 'data-testid': 'skeleton' } }, [
    el('p', { class: 'sr-only', text: 'Loading your glance…', attrs: { role: 'status' } }),
    block('tile--spending'),
    block(''),
    block(''),
    block(''),
    block('tile--goals'),
    block(''),
  ]);
}
