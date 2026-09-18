import { el, link, svg, type Child } from '../lib/dom';
import { formatClock, formatDateTime, formatDay, formatUserCode } from '../lib/format';
import { ICONS, type IconName } from '../lib/icons';
import { urlOnOrigin } from '../lib/origin';
import { DEVICE_LABEL_MAX, PAIR_APPROVE_PAGE_PATH, pairingDeadline, type PairingState } from '../lib/pairing';
import type { Snapshot } from '../lib/storage';

export interface OptionsModel {
  snapshot: Snapshot;
  hostAccess: boolean | null;
  pairing: PairingState;
  editingOrigin: boolean;
  originInput: string;
  labelInput: string;
  message: { tone: 'error' | 'info' | 'success'; text: string } | null;
  busy: boolean;
  extensionId: string;
  version: string;
  now: number;
}

export interface OptionsHandlers {
  onOriginInput(value: string): void;
  onLabelInput(value: string): void;
  onSaveOrigin(): void;
  onEditOrigin(): void;
  onCancelEditOrigin(): void;
  onStartPairing(): void;
  onCancelPairing(): void;
  onForget(): void;
  onDismissMessage(): void;
}

const icon = (name: IconName, size = 18) => svg(ICONS[name], { size });

type Status = { label: string; tone: 'positive' | 'caution' | 'neutral' | 'negative'; testId: string };

export function statusOf(model: OptionsModel): Status {
  const { config, pairing, ended } = model.snapshot;
  if (!config) return { label: 'Not set up', tone: 'neutral', testId: 'not-configured' };
  if (pairing && pairing.origin === config.origin) {
    if (!(Date.parse(pairing.expiresAt) > model.now))
      return { label: 'Pairing ended', tone: 'negative', testId: 'ended' };
    return { label: 'Connected', tone: 'positive', testId: 'connected' };
  }
  if (pairing) return { label: 'Pair again for the new address', tone: 'caution', testId: 'origin-mismatch' };
  if (model.pairing.phase === 'waiting') return { label: 'Waiting for approval', tone: 'caution', testId: 'waiting' };
  if (ended && ended.origin === config.origin)
    return { label: 'Pairing ended — pair again', tone: 'negative', testId: 'ended' };
  return { label: 'Not paired yet', tone: 'neutral', testId: 'not-paired' };
}

function row(label: string, value: Child, testId?: string): HTMLElement {
  return el('div', { class: 'kv-row', attrs: { 'data-row': testId } }, [
    el('dt', { text: label }),
    el('dd', {}, [value]),
  ]);
}

function statusCard(model: OptionsModel, h: OptionsHandlers): HTMLElement {
  const status = statusOf(model);
  const { config, pairing } = model.snapshot;
  const rows: Child[] = [];
  rows.push(
    row(
      'FinancialOS address',
      config ? el('span', { class: 'mono', text: config.origin }) : el('span', { class: 'muted', text: 'Not set' }),
      'origin',
    ),
  );
  if (pairing) {
    rows.push(row('Paired with', el('span', { class: 'mono', text: pairing.origin }), 'paired-origin'));
    if (pairing.deviceLabel) rows.push(row('Device name', pairing.deviceLabel, 'label'));
    rows.push(row('Paired', formatDateTime(pairing.pairedAt), 'paired-at'));
    rows.push(row('Access expires', formatDay(pairing.expiresAt), 'expires'));
    rows.push(
      row(
        'Access',
        pairing.scopes.includes('glance:read') && pairing.scopes.length === 1
          ? 'Glance only (view-only)'
          : pairing.scopes.join(', '),
        'scopes',
      ),
    );
  }
  if (config) {
    rows.push(
      row(
        'Site access',
        model.hostAccess === null
          ? 'Checking…'
          : model.hostAccess
            ? 'Allowed for this address only'
            : 'Not granted — Chrome will ask when you save the address',
        'host-access',
      ),
    );
  }
  rows.push(row('Extension ID', el('span', { class: 'mono', text: model.extensionId }), 'extension-id'));

  const actions: Child[] = [];
  if (pairing || config) {
    actions.push(
      el('button', { class: 'button button--secondary', attrs: { type: 'button', 'data-action': 'change-origin' } }, [
        icon('compass', 16),
        el('span', { text: 'Change address' }),
      ]),
    );
  }
  if (pairing || config) {
    actions.push(
      el('button', { class: 'button button--danger', attrs: { type: 'button', 'data-action': 'forget' } }, [
        el('span', { text: 'Forget this device locally' }),
      ]),
    );
  }
  const card = el(
    'section',
    { class: 'card', attrs: { 'aria-labelledby': 'status-title', 'data-status': status.testId } },
    [
      el('div', { class: 'card-head' }, [
        el('h2', { class: 'card-title', text: 'Status', attrs: { id: 'status-title' } }),
        el('span', {
          class: `badge badge--${status.tone}`,
          text: status.label,
          attrs: { 'data-testid': 'status-badge' },
        }),
      ]),
      el('dl', { class: 'kv' }, rows),
      actions.length ? el('div', { class: 'card-actions' }, actions) : null,
    ],
  );
  card.querySelector('[data-action="change-origin"]')?.addEventListener('click', h.onEditOrigin);
  card.querySelector('[data-action="forget"]')?.addEventListener('click', h.onForget);
  return card;
}

function step(n: number, title: string, state: 'done' | 'current' | 'upcoming', body: Child[]): HTMLElement {
  return el(
    'li',
    { class: `step step--${state}`, attrs: { 'aria-current': state === 'current' ? 'step' : undefined } },
    [
      el(
        'span',
        { class: 'step-index', attrs: { 'aria-hidden': 'true' } },
        state === 'done' ? [icon('check', 16)] : [String(n)],
      ),
      el('div', { class: 'step-body' }, [el('h3', { class: 'step-title', text: title }), ...body]),
    ],
  );
}

function originForm(model: OptionsModel, h: OptionsHandlers): HTMLElement {
  const input = el('input', {
    class: 'input mono',
    attrs: {
      id: 'origin',
      name: 'origin',
      type: 'url',
      inputmode: 'url',
      autocomplete: 'off',
      spellcheck: 'false',
      autocapitalize: 'off',
      placeholder: 'https://financialos.example.test',
      'aria-describedby': 'origin-help',
      required: '',
    },
  });
  input.value = model.originInput;
  input.addEventListener('input', () => h.onOriginInput(input.value));
  const save = el(
    'button',
    { class: 'button button--primary', attrs: { type: 'submit', 'data-action': 'save-origin' } },
    [el('span', { text: model.snapshot.config ? 'Use this address' : 'Save address' })],
  );
  if (model.busy) save.setAttribute('disabled', '');
  const form = el('form', { class: 'form', attrs: { novalidate: '', 'data-form': 'origin' } }, [
    el('label', { class: 'label', text: 'FinancialOS address', attrs: { for: 'origin' } }),
    el('div', { class: 'input-row' }, [
      input,
      save,
      model.editingOrigin && model.snapshot.config
        ? el('button', {
            class: 'button button--ghost',
            attrs: { type: 'button', 'data-action': 'cancel-edit' },
            text: 'Cancel',
          })
        : null,
    ]),
    el('p', {
      class: 'help',
      attrs: { id: 'origin-help' },
      text: 'The https:// address you use to open FinancialOS. For use on the same computer, http://localhost:<port> or http://127.0.0.1:<port> also works. Chrome will ask to allow access to this one address.',
    }),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    h.onSaveOrigin();
  });
  form.querySelector('[data-action="cancel-edit"]')?.addEventListener('click', h.onCancelEditOrigin);
  return form;
}

function pairingPanel(model: OptionsModel, h: OptionsHandlers, origin: string): Child[] {
  const p = model.pairing;
  if (p.phase === 'waiting') {
    const deadline = pairingDeadline(p.pending);
    const cancel = el('button', {
      class: 'button button--ghost',
      attrs: { type: 'button', 'data-action': 'cancel-pairing' },
      text: 'Cancel',
    });
    cancel.addEventListener('click', h.onCancelPairing);
    return [
      el('div', { class: 'code-panel', attrs: { 'data-testid': 'pairing-code-panel' } }, [
        el('p', {
          class: 'code-intro',
          text: 'In FinancialOS, open Settings → Devices → Pair a device and enter this code:',
        }),
        el('p', {
          class: 'user-code figures',
          text: formatUserCode(p.pending.userCode),
          attrs: { 'data-testid': 'user-code' },
        }),
        el('div', { class: 'code-actions' }, [
          link(
            urlOnOrigin(origin, PAIR_APPROVE_PAGE_PATH),
            {
              class: 'button button--primary',
              attrs: { target: '_blank', rel: 'noopener noreferrer', 'data-action': 'open-pair-page' },
            },
            [el('span', { text: 'Open FinancialOS pairing page' }), icon('external', 16)],
          ),
          cancel,
        ]),
        el('p', { class: 'wait-line', attrs: { role: 'status', 'data-testid': 'pairing-status' } }, [
          el('span', { class: p.paused ? 'pulse pulse--paused' : 'pulse' }),
          p.paused
            ? 'Paused while this page is in the background. Checking resumes when you come back.'
            : (p.notice ?? 'Waiting for approval. This page checks every few seconds.'),
        ]),
        el('p', {
          class: 'help',
          text: `The code expires at ${formatClock(deadline)}. The code is never put in a link; type it into FinancialOS yourself.`,
        }),
      ]),
    ];
  }
  const label = el('input', {
    class: 'input',
    attrs: {
      id: 'device-label',
      name: 'device-label',
      type: 'text',
      maxlength: String(DEVICE_LABEL_MAX),
      autocomplete: 'off',
      'aria-describedby': 'label-help',
    },
  });
  label.value = model.labelInput;
  label.addEventListener('input', () => h.onLabelInput(label.value));
  const start = el(
    'button',
    { class: 'button button--primary', attrs: { type: 'submit', 'data-action': 'start-pairing' } },
    [el('span', { text: p.phase === 'starting' ? 'Starting…' : p.phase === 'idle' ? 'Start pairing' : 'Start again' })],
  );
  if (p.phase === 'starting' || model.busy) start.setAttribute('disabled', '');
  const form = el('form', { class: 'form', attrs: { novalidate: '', 'data-form': 'pair' } }, [
    el('label', { class: 'label', text: 'Name for this browser', attrs: { for: 'device-label' } }),
    el('div', { class: 'input-row' }, [label, start]),
    el('p', {
      class: 'help',
      attrs: { id: 'label-help' },
      text: 'Shown in FinancialOS → Settings → Devices so you can recognise and revoke it later.',
    }),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    h.onStartPairing();
  });
  const outcome: Child[] = [];
  if (p.phase === 'expired')
    outcome.push(
      inlineNote(
        'caution',
        'The pairing code expired before it was approved. Start again to get a new code.',
        'pairing-expired',
      ),
    );
  if (p.phase === 'denied')
    outcome.push(
      inlineNote(
        'negative',
        'Pairing was declined in FinancialOS. Start again if that was a mistake.',
        'pairing-denied',
      ),
    );
  if (p.phase === 'error') outcome.push(inlineNote('negative', p.message, 'pairing-error'));
  return [...outcome, form];
}

function inlineNote(tone: 'caution' | 'negative' | 'positive' | 'info', text: string, testId: string): HTMLElement {
  return el('p', {
    class: `inline-note inline-note--${tone}`,
    attrs: { role: tone === 'negative' ? 'alert' : 'status', 'data-testid': testId },
    text,
  });
}

function setupCard(model: OptionsModel, h: OptionsHandlers): HTMLElement | null {
  const { config, pairing } = model.snapshot;
  const pairedHere = !!pairing && !!config && pairing.origin === config.origin;
  if (pairedHere && !model.editingOrigin) {
    if (model.pairing.phase !== 'approved') return null;
    return el('section', { class: 'card card--success', attrs: { 'data-testid': 'paired-success' } }, [
      el('div', { class: 'card-head' }, [
        el('span', { class: 'success-icon' }, [icon('check', 18)]),
        el('h2', { class: 'card-title', text: 'This browser is paired' }),
      ]),
      el('p', { class: 'card-text', text: 'Open a new tab to see your glance. You can close this page.' }),
    ]);
  }
  const addressDone = !!config && !model.editingOrigin;
  const steps: Child[] = [
    step(
      1,
      'Enter your FinancialOS address',
      addressDone ? 'done' : 'current',
      addressDone
        ? [el('p', { class: 'step-summary' }, [el('span', { class: 'mono', text: config.origin })])]
        : [originForm(model, h)],
    ),
    step(
      2,
      'Pair this browser',
      addressDone ? 'current' : 'upcoming',
      addressDone && config
        ? pairingPanel(model, h, config.origin)
        : [el('p', { class: 'help', text: 'You approve the pairing inside FinancialOS with a short code.' })],
    ),
    step(3, 'Open a new tab', 'upcoming', [
      el('p', {
        class: 'help',
        text: 'Your glance appears on every new tab. Tiles open FinancialOS, which asks you to sign in again.',
      }),
    ]),
  ];
  return el('section', { class: 'card', attrs: { 'aria-labelledby': 'setup-title' } }, [
    el('div', { class: 'card-head' }, [
      el('h2', {
        class: 'card-title',
        text: model.editingOrigin ? 'Change address' : 'Set up',
        attrs: { id: 'setup-title' },
      }),
    ]),
    model.editingOrigin && pairing
      ? inlineNote(
          'caution',
          'Changing the address removes this browser’s credential. You will pair again, and should revoke this browser in FinancialOS → Settings → Devices.',
          'change-warning',
        )
      : null,
    el('ol', { class: 'steps' }, steps),
  ]);
}

function privacyCard(): HTMLElement {
  const item = (iconName: IconName, text: string) => el('li', {}, [icon(iconName, 16), el('span', { text })]);
  return el('section', { class: 'card', attrs: { 'aria-labelledby': 'privacy-title', 'data-testid': 'privacy' } }, [
    el('div', { class: 'card-head' }, [
      el('h2', { class: 'card-title', text: 'Privacy', attrs: { id: 'privacy-title' } }),
    ]),
    el('div', { class: 'privacy-grid' }, [
      el('div', {}, [
        el('h3', { class: 'sub-title', text: 'What it can see' }),
        el('ul', { class: 'bullets' }, [
          item(
            'check',
            'A small summary: spending pace, goal progress, how many items are due, a coaching nudge, and data freshness.',
          ),
          item(
            'eyeOff',
            'Amounts are hidden by default. FinancialOS only sends the amounts you allow for this device in Settings → Devices.',
          ),
          item(
            'lock',
            'Only the one FinancialOS address you enter. Chrome asks you to allow that address and nothing else.',
          ),
        ]),
      ]),
      el('div', {}, [
        el('h3', { class: 'sub-title', text: 'What it cannot do' }),
        el('ul', { class: 'bullets bullets--no' }, [
          item('shield', 'No transactions, documents, account details, bank credentials, or other entities.'),
          item(
            'shield',
            'No changes: it cannot move money, approve anything, or sign you in. Every tile asks FinancialOS for a fresh sign-in.',
          ),
          item(
            'shield',
            'No browsing history, cookies, other websites, or search. It does not sync and sends no analytics.',
          ),
        ]),
      ]),
    ]),
    el('p', {
      class: 'card-text storage-note',
      text: 'The device credential is kept in this browser’s local extension storage on this computer (never synced). That storage is not a hardware-secure vault: anyone with access to this browser profile could read it, so revoke the device in FinancialOS if this computer is lost or shared. The last glance is kept in memory only and disappears when the browser closes.',
    }),
  ]);
}

export function renderOptions(root: HTMLElement, model: OptionsModel, h: OptionsHandlers): void {
  const message = model.message
    ? el(
        'div',
        {
          class: `banner banner--${model.message.tone}`,
          attrs: { role: model.message.tone === 'error' ? 'alert' : 'status', 'data-testid': 'message' },
        },
        [
          el('p', { text: model.message.text }),
          el(
            'button',
            {
              class: 'icon-button',
              attrs: { type: 'button', 'aria-label': 'Dismiss message', 'data-action': 'dismiss' },
            },
            [svg(['M6 6l12 12', 'M18 6L6 18'], { size: 16 })],
          ),
        ],
      )
    : null;
  message?.querySelector('[data-action="dismiss"]')?.addEventListener('click', h.onDismissMessage);
  const header = el('header', { class: 'topbar' }, [
    el('span', { class: 'brand' }, [
      el('img', { class: 'brand-mark', attrs: { src: 'icons/mark.svg', alt: '', width: '28', height: '28' } }),
      el('span', { class: 'brand-word' }, ['Financial', el('span', { class: 'brand-os', text: 'OS' })]),
      el('span', { class: 'brand-sub', text: 'New Tab' }),
    ]),
  ]);
  const main = el('main', { class: 'content', attrs: { id: 'main' } }, [
    el('div', { class: 'page-head' }, [
      el('h1', { text: 'Settings' }),
      el('p', {
        class: 'lede',
        text: 'Connect this browser to your FinancialOS for a calm, view-only glance on each new tab.',
      }),
    ]),
    message,
    statusCard(model, h),
    setupCard(model, h),
    privacyCard(),
    el('p', {
      class: 'footnote',
      text: `FinancialOS New Tab ${model.version}. Not available on mobile Chrome, and not shown in incognito windows.`,
    }),
  ]);
  root.replaceChildren(header, main);
}
