// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAUNCH_TARGETS } from '@financialos/contracts';
import { calmGlance, sampleGlance } from '../lib/fixtures';
import { renderView, type RenderContext } from './render';
import type { NewTabView } from './view';

const ORIGIN = 'https://financialos.example.test';
const NOW = Date.parse('2026-09-18T09:00:00.000Z');

let root: HTMLElement;

const context = (over: Partial<RenderContext> = {}): RenderContext => ({
  now: NOW,
  locale: 'en-US',
  onRetry: () => {},
  retrying: false,
  ...over,
});

const connected = (glance = sampleGlance()): NewTabView => ({
  kind: 'connected',
  origin: ORIGIN,
  glance,
  fetchedAt: NOW - 30_000,
  displayUntil: NOW + 570_000,
  refreshProblem: null,
});

function render(view: NewTabView, ctx: Partial<RenderContext> = {}): HTMLElement {
  renderView(root, view, context(ctx));
  return root;
}

const text = () => root.textContent ?? '';
const amounts = () => [...root.querySelectorAll('[data-amount]')].map((node) => node.textContent ?? '');

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

describe('masked rendering', () => {
  it('shows no amount anywhere when the device is masked', () => {
    render(connected());
    expect(amounts()).toEqual([]);
    expect(root.querySelectorAll('[data-masked]').length).toBeGreaterThan(0);
    for (const secret of ['1284.50', '1,284.50', '940', '7,200', '7200', '2,310', '2310', '€', 'EUR']) {
      expect(text(), `masked glance leaked ${secret}`).not.toContain(secret);
    }
  });

  it('labels the privacy state in the header', () => {
    render(connected());
    expect(root.querySelector('[data-privacy]')?.getAttribute('data-privacy')).toBe('masked');
    expect(text()).toContain('Amounts hidden');
  });

  it('still shows the non-sensitive shape of the glance', () => {
    render(connected());
    expect(text()).toContain('68'); // per cent of plan used
    expect(text()).toContain('57% of the period has passed');
    expect(text()).toContain('Emergency fund');
    expect(text()).toContain('Office rent');
    expect(text()).toContain('September');
    expect(text()).toContain('keeps September tidy');
    expect(text()).toContain('Financial data is up to date');
    expect(text()).toContain('2 items to review');
  });
});

describe('revealed rendering', () => {
  it('shows exactly the amounts the owner allowed, and hides the rest', () => {
    render(connected(sampleGlance({ revealedFields: ['safe_to_spend', 'goal_amounts'] })));
    expect(root.querySelector('[data-privacy]')?.getAttribute('data-privacy')).toBe('shown');
    expect(text()).toContain('Amounts shown');
    expect(amounts().join(' ')).toContain('€1,284.50');
    expect(amounts().join(' ')).toContain('€7,200.00');
    // budget_remaining and due_amounts were not allowed, so they stay hidden.
    expect(text()).not.toContain('940');
    expect(text()).not.toContain('2,310');
    expect(root.querySelectorAll('[data-masked]').length).toBeGreaterThan(0);
  });

  it('renders amounts with tabular figures so columns line up', () => {
    render(connected(sampleGlance({ revealedFields: ['safe_to_spend'] })));
    for (const node of root.querySelectorAll('[data-amount]')) expect(node.className).toContain('figures');
  });
});

describe('unknown values', () => {
  it('says unknown rather than showing a zero', () => {
    const glance = sampleGlance();
    render(connected({ ...glance, spending: { ...glance.spending, percentOfPlanUsed: null, status: 'unknown' } }));
    expect(text()).toContain('Unknown');
    expect(text()).toContain('plan usage not available yet');
    expect(text()).toContain('Not enough data');
  });

  it('renders the calm variant without inventing anything', () => {
    render(connected(calmGlance()));
    expect(text()).toContain('All clear');
    expect(text()).toContain('Nothing due in the next 14 days');
    expect(text()).toContain('No goals yet');
    expect(amounts()).toEqual([]);
  });
});

describe('launch links', () => {
  it('sends every tile to an allowlisted /launch/ route on the configured origin', () => {
    render(connected());
    const links = [...root.querySelectorAll<HTMLAnchorElement>('a[data-launch]')];
    expect(links.length).toBeGreaterThanOrEqual(7);
    for (const link of links) {
      const target = link.dataset.launch ?? '';
      expect(Object.keys(LAUNCH_TARGETS)).toContain(target);
      expect(link.getAttribute('href')).toBe(`${ORIGIN}/launch/${target}`);
      expect(link.getAttribute('href')).not.toContain('?');
    }
  });

  it('offers a single obvious way into FinancialOS', () => {
    render(connected());
    const open = [...root.querySelectorAll<HTMLAnchorElement>('a')].filter((a) =>
      a.textContent?.trim().startsWith('Open FinancialOS'),
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.getAttribute('href')).toBe(`${ORIGIN}/launch/today`);
  });

  it('carries no credential, device id or code in any URL', () => {
    render(connected(sampleGlance({ revealedFields: ['safe_to_spend'] })));
    for (const link of root.querySelectorAll<HTMLAnchorElement>('a')) {
      const href = link.getAttribute('href') ?? '';
      expect(href).not.toMatch(/token|credential|device|code=/i);
      expect(href === 'options.html' || href.startsWith(`${ORIGIN}/launch/`)).toBe(true);
    }
  });
});

describe('locked and offline states', () => {
  const states: Array<[NewTabView, string]> = [
    [{ kind: 'not_configured' }, 'not-configured'],
    [{ kind: 'not_paired', origin: ORIGIN }, 'not-paired'],
    [
      { kind: 'awaiting_approval', origin: ORIGIN, userCode: 'K7M2-9QX4', deadline: NOW + 300_000 },
      'awaiting-approval',
    ],
    [{ kind: 'pairing_ended', origin: ORIGIN, reason: 'revoked' }, 'pairing-ended'],
    [{ kind: 'pairing_ended', origin: ORIGIN, reason: 'expired' }, 'pairing-ended'],
    [
      { kind: 'origin_mismatch', configuredOrigin: 'https://moved.example.test', pairedOrigin: ORIGIN },
      'origin-mismatch',
    ],
    [{ kind: 'offline', origin: ORIGIN, reason: 'unreachable', nextCheckAt: NOW + 60_000 }, 'offline-unreachable'],
    [{ kind: 'offline', origin: ORIGIN, reason: 'unavailable', nextCheckAt: null }, 'offline-unavailable'],
    [{ kind: 'offline', origin: ORIGIN, reason: 'invalid', nextCheckAt: null }, 'offline-invalid'],
    [{ kind: 'offline', origin: ORIGIN, reason: 'refused', nextCheckAt: null }, 'offline-refused'],
    [{ kind: 'offline', origin: ORIGIN, reason: 'expired', nextCheckAt: NOW + 60_000 }, 'offline-expired'],
  ];

  it.each(states)('shows a neutral state card with no figures: %o', (view, testId) => {
    render(view);
    expect(root.querySelector(`[data-state="${testId}"]`)).not.toBeNull();
    expect(amounts()).toEqual([]);
    expect(root.querySelector('[data-testid="glance"]')).toBeNull();
    expect(text()).not.toContain('€');
    expect(root.querySelector('h1')).not.toBeNull();
    expect(root.querySelector('[data-state] h2')?.textContent?.length).toBeGreaterThan(3);
  });

  it('shows the pairing code as typed text, never as a link', () => {
    render({ kind: 'awaiting_approval', origin: ORIGIN, userCode: 'k7m2-9qx4', deadline: NOW + 300_000 });
    const code = root.querySelector('.user-code');
    expect(code?.textContent).toBe('K7M2-9QX4');
    expect(code?.closest('a')).toBeNull();
    expect([...root.querySelectorAll('a')].some((a) => (a.getAttribute('href') ?? '').includes('K7M2'))).toBe(false);
  });

  it('offers a retry that reports it is working', () => {
    const onRetry = vi.fn();
    render({ kind: 'offline', origin: ORIGIN, reason: 'unreachable', nextCheckAt: NOW + 60_000 }, { onRetry });
    const button = root.querySelector<HTMLButtonElement>('[data-action="retry"]');
    button?.click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    render({ kind: 'offline', origin: ORIGIN, reason: 'unreachable', nextCheckAt: NOW + 60_000 }, { retrying: true });
    expect(root.querySelector('[data-action="retry"]')?.hasAttribute('disabled')).toBe(true);
    expect(text()).toContain('Checking…');
  });
});

describe('document structure', () => {
  it('marks the current view and its busy state for assistive technology', () => {
    render({ kind: 'loading', origin: ORIGIN });
    expect(root.querySelector('#main')?.getAttribute('data-view')).toBe('loading');
    expect(root.querySelector('#main')?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('[data-testid="skeleton"]')).not.toBeNull();

    render(connected());
    expect(root.querySelector('#main')?.getAttribute('aria-busy')).toBe('false');
  });

  it('describes the spending meter and each goal bar in words', () => {
    render(connected());
    expect(root.querySelector('.meter')?.getAttribute('aria-label')).toBe(
      '68% of plan used. 57% of the period has passed.',
    );
    expect(root.querySelector('.goal-bar')?.getAttribute('aria-label')).toBe('Emergency fund: 72%');
  });

  it('fills the meter from the data, capping the bar when spending is over plan', () => {
    const glance = sampleGlance();
    render(connected({ ...glance, spending: { ...glance.spending, percentOfPlanUsed: 143, status: 'over' } }));
    const meter = root.querySelector<HTMLElement>('.meter');
    expect(meter?.style.getPropertyValue('--fill')).toBe('100%');
    expect(meter?.style.getPropertyValue('--marker')).toBe('57%');
    expect(meter?.classList.contains('meter--overflow')).toBe(true);
    expect(text()).toContain('Over plan');
  });

  it('shows at most three goals', () => {
    const glance = sampleGlance();
    render(connected({ ...glance, goals: [...glance.goals] }));
    expect(root.querySelectorAll('.goal')).toHaveLength(3);
  });

  it('replaces the previous render rather than appending to it', () => {
    render(connected());
    render({ kind: 'not_configured' });
    expect(root.querySelectorAll('main')).toHaveLength(1);
    expect(root.querySelectorAll('header')).toHaveLength(1);
  });

  it('builds the page without any inline event handler or style attribute markup', () => {
    render(connected(sampleGlance({ revealedFields: ['safe_to_spend'] })));
    for (const node of root.querySelectorAll('*')) {
      for (const attribute of node.attributes) expect(attribute.name).not.toMatch(/^on/i);
    }
  });
});
