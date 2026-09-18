import { browserEnv, type ExtEnv } from '../lib/env';
import { refreshGlance } from '../lib/refresh';
import { readSnapshot } from '../lib/storage';
import { renderView } from './render';
import { deriveView, nextViewChangeAt, type NewTabView } from './view';

const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * New tab bootstrap: paint from stored state immediately, then make at most one bounded glance
 * request (throttled across tabs). Nothing else runs from a new tab: no sync, no AI, no polling.
 */
export function startNewTab(root: HTMLElement, env: ExtEnv): { render: () => Promise<void> } {
  let retrying = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let lastKey = '';

  async function render(): Promise<void> {
    const current = ++sequence;
    const snapshot = await readSnapshot(env);
    if (current !== sequence) return;
    const now = env.now();
    const view: NewTabView = deriveView(snapshot, now);
    // Skip identical re-renders so keyboard focus is not lost on unrelated storage writes.
    const key = `${JSON.stringify(view)}|${new Date(now).toDateString()}|${new Date(now).getHours()}|${retrying}`;
    if (key !== lastKey) {
      lastKey = key;
      renderView(root, view, { now, onRetry: retry, retrying });
    }
    clearTimeout(timer);
    const next = nextViewChangeAt(snapshot, view, now);
    if (next !== null) timer = setTimeout(() => void render(), Math.min(MAX_TIMER_MS, Math.max(0, next - now) + 50));
  }

  // refreshGlance re-reads storage and does nothing (no request) unless a matching pairing exists.
  async function refresh(manual: boolean): Promise<void> {
    const result = await refreshGlance(env, { manual });
    if (result.decision !== 'skipped' || result.outcome) await render();
  }

  function retry(): void {
    if (retrying) return;
    retrying = true;
    void render()
      .then(() => refresh(true))
      .finally(() => {
        retrying = false;
        void render();
      });
  }

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local' || area === 'session') void render();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void render().then(() => refresh(false));
  });

  void render().then(() => (document.visibilityState === 'visible' ? refresh(false) : undefined));
  return { render };
}

const root = document.getElementById('app');
if (root && typeof chrome !== 'undefined' && chrome.storage) startNewTab(root, browserEnv());
