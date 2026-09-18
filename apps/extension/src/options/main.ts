import { browserEnv, type ExtEnv } from '../lib/env';
import { hostPermissionFor, normalizeOrigin } from '../lib/origin';
import { defaultDeviceLabel, pairingDeadline, PairingController, type PairingState } from '../lib/pairing';
import { forgetEverything, readSnapshot, setConfiguredOrigin, type Snapshot } from '../lib/storage';
import { confirmDialog } from './dialog';
import { renderOptions, type OptionsHandlers, type OptionsModel } from './render';

const EMPTY: Snapshot = { config: null, pairing: null, ended: null, pending: null, cache: null, meta: null };

function platformName(): string | undefined {
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return data?.platform || undefined;
}

/**
 * Asks Chrome for access to exactly one origin. Must run inside the click handler's user gesture,
 * so it is the first asynchronous call made after the click.
 */
export async function requestHostAccess(env: ExtEnv, origin: string): Promise<boolean> {
  try {
    return await env.permissions.request({ origins: [hostPermissionFor(origin)] });
  } catch {
    return false;
  }
}

/** Drops host access for an origin that is no longer configured. Never throws. */
export async function releaseHostAccess(env: ExtEnv, origin: string | null | undefined): Promise<void> {
  if (!origin) return;
  try {
    await env.permissions.remove({ origins: [hostPermissionFor(origin)] });
  } catch {
    // Nothing to release, or the origin was never granted.
  }
}

export function startOptionsPage(root: HTMLElement, env: ExtEnv): void {
  const model: OptionsModel = {
    snapshot: EMPTY,
    hostAccess: null,
    pairing: { phase: 'idle' },
    editingOrigin: false,
    originInput: '',
    labelInput: defaultDeviceLabel(platformName()),
    message: null,
    busy: false,
    extensionId: chrome.runtime.id,
    version: env.extensionVersion,
    now: env.now(),
  };

  const controller = new PairingController(env, (state: PairingState) => {
    model.pairing = state;
    if (state.phase === 'approved') model.message = null;
    void refresh();
  });

  const render = () => {
    const active = document.activeElement;
    const focusId = active instanceof HTMLElement ? active.id || active.dataset.action || null : null;
    const selection: [number | null, number | null] | null =
      active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
    model.now = env.now();
    renderOptions(root, model, handlers);
    if (focusId) {
      const target =
        root.querySelector<HTMLElement>(`#${CSS.escape(focusId)}`) ??
        root.querySelector<HTMLElement>(`[data-action="${CSS.escape(focusId)}"]`);
      if (target && !target.hasAttribute('disabled')) {
        target.focus({ preventScroll: true });
        const [selectionStart, selectionEnd] = selection ?? [null, null];
        if (target instanceof HTMLInputElement && selectionStart !== null && selectionEnd !== null) {
          try {
            target.setSelectionRange(selectionStart, selectionEnd);
          } catch {
            // Some input types do not support selection ranges.
          }
        }
      }
    }
  };

  async function refresh(): Promise<void> {
    model.snapshot = await readSnapshot(env);
    const origin = model.snapshot.config?.origin;
    if (!model.originInput && origin) model.originInput = origin;
    model.hostAccess = origin
      ? await env.permissions.contains({ origins: [hostPermissionFor(origin)] }).catch(() => false)
      : null;
    render();
  }

  const focusSoon = (selector: string) =>
    requestAnimationFrame(() => root.querySelector<HTMLElement>(selector)?.focus());

  const handlers: OptionsHandlers = {
    onOriginInput(value) {
      model.originInput = value;
    },
    onLabelInput(value) {
      model.labelInput = value;
    },
    onEditOrigin() {
      model.editingOrigin = true;
      model.originInput = model.snapshot.config?.origin ?? '';
      model.message = null;
      render();
      focusSoon('#origin');
    },
    onCancelEditOrigin() {
      model.editingOrigin = false;
      model.originInput = model.snapshot.config?.origin ?? '';
      render();
    },
    onDismissMessage() {
      model.message = null;
      render();
    },
    onSaveOrigin() {
      const checked = normalizeOrigin(model.originInput);
      if (!checked.ok) {
        model.message = { tone: 'error', text: checked.reason };
        render();
        focusSoon('#origin');
        return;
      }
      const origin = checked.origin;
      const previous = model.snapshot.config?.origin ?? null;
      const pairedOrigin = model.snapshot.pairing?.origin ?? null;
      if (pairedOrigin === origin && previous === origin) {
        model.editingOrigin = false;
        model.message = { tone: 'info', text: 'This browser is already paired with that address.' };
        render();
        return;
      }
      model.busy = true;
      render();
      void (async () => {
        try {
          if (pairedOrigin) {
            // Confirm first; the confirm button click is the user gesture for the permission prompt.
            const ok = await confirmDialog({
              title: 'Change the FinancialOS address?',
              body: 'This removes the credential stored in this browser. You will need to pair again, and you should revoke this browser in FinancialOS → Settings → Devices. The credential is never sent to the new address.',
              confirm: 'Change address',
              danger: true,
            });
            if (!ok) return;
          }
          if (!(await requestHostAccess(env, origin))) {
            model.message = {
              tone: 'error',
              text: `Chrome did not allow access to ${origin}. The extension needs it to reach FinancialOS. Try again and choose Allow.`,
            };
            return;
          }
          await controller.cancel();
          await setConfiguredOrigin(env, origin);
          if (previous && previous !== origin) await releaseHostAccess(env, previous);
          model.originInput = origin;
          model.editingOrigin = false;
          model.message = { tone: 'success', text: `Saved. Next, pair this browser with ${origin}.` };
          focusSoon('#device-label');
        } finally {
          model.busy = false;
          await refresh();
        }
      })();
    },
    onStartPairing() {
      const origin = model.snapshot.config?.origin;
      if (!origin) return;
      if (!model.labelInput.trim()) {
        model.message = {
          tone: 'error',
          text: 'Give this browser a short name so you can recognise it in FinancialOS.',
        };
        render();
        focusSoon('#device-label');
        return;
      }
      const access = model.hostAccess ? Promise.resolve(true) : requestHostAccess(env, origin);
      model.message = null;
      void (async () => {
        if (!(await access)) {
          model.message = { tone: 'error', text: `Chrome did not allow access to ${origin}. Pairing needs it.` };
          await refresh();
          return;
        }
        await controller.start(origin, model.labelInput);
        focusSoon('[data-action="open-pair-page"]');
      })();
    },
    onCancelPairing() {
      void controller.cancel().then(refresh);
    },
    onForget() {
      void (async () => {
        const label = model.snapshot.pairing?.deviceLabel;
        const paired = !!model.snapshot.pairing;
        const ok = await confirmDialog({
          title: 'Forget this device locally?',
          body: paired
            ? 'This deletes the credential, address, and cached glance from this browser. To make sure the credential can never be used again, also revoke this browser in FinancialOS → Settings → Devices.'
            : 'This deletes the saved address and any pairing in progress from this browser.',
          confirm: 'Forget',
          danger: true,
        });
        if (!ok) return;
        const origin = model.snapshot.config?.origin ?? model.snapshot.pairing?.origin;
        await controller.cancel();
        await forgetEverything(env);
        await releaseHostAccess(env, origin);
        model.originInput = '';
        model.editingOrigin = false;
        model.pairing = { phase: 'idle' };
        model.message = {
          tone: 'success',
          text: paired
            ? `Removed from this browser. Also revoke “${label || 'this browser'}” in FinancialOS → Settings → Devices so the credential stops working.`
            : 'Removed from this browser.',
        };
        await refresh();
      })();
    },
  };

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local' || area === 'session') void refresh();
  });
  document.addEventListener('visibilitychange', () => controller.setHidden(document.visibilityState === 'hidden'));
  controller.setHidden(document.visibilityState === 'hidden');

  void (async () => {
    await refresh();
    const { config, pending, pairing } = model.snapshot;
    if (!pairing && pending && config && pending.origin === config.origin && env.now() < pairingDeadline(pending)) {
      model.labelInput = pending.deviceLabel;
      controller.resume(pending);
    }
  })();
}

const root = document.getElementById('app');
if (root && typeof chrome !== 'undefined' && chrome.storage) startOptionsPage(root, browserEnv());
