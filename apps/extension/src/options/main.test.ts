// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSnapshot } from '../lib/storage';
import { jsonResponse, testEnv, type TestEnv } from '../lib/testing';
import { releaseHostAccess, requestHostAccess, startOptionsPage } from './main';
// The page loads the contract validator lazily. Importing it here means the dynamic import
// resolves from cache, so the wizard settles within the ticks these tests wait for.
import '../lib/schemas';

const ORIGIN = 'https://financialos.example.test';
const PERMISSION = `${ORIGIN}/*`;
const NOW = Date.parse('2026-09-18T09:00:00.000Z');
const EXTENSION_ID = 'pafnoebiamkedmcabfalnpbkjilpoajo';

const startBody = {
  pairingId: '9c3b1f3a-2f7d-4a11-9b6e-0f2c3d4e5a6b',
  userCode: 'K7M2-9QX4',
  expiresAt: new Date(NOW + 600_000).toISOString(),
  approveUrlPath: '/settings/devices/pair',
};

/** Lets the page's own promise chains and the mocked fetch settle. */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let root: HTMLElement;
let env: TestEnv;

function type(selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no input matching ${selector}`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(selector: string): void {
  const form = root.querySelector<HTMLFormElement>(selector);
  if (!form) throw new Error(`no form matching ${selector}`);
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function click(selector: string): void {
  const node = root.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`no element matching ${selector}`);
  node.click();
}

const text = () => root.textContent ?? '';

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  env = testEnv({ now: NOW });
  vi.stubGlobal('chrome', {
    runtime: { id: EXTENSION_ID, getManifest: () => ({ version: '0.1.0' }) },
    storage: { onChanged: { addListener: vi.fn() } },
  });
  // jsdom does not implement the modal dialog; the page only needs it to open and close.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
});

describe('requestHostAccess', () => {
  it('asks Chrome for exactly one origin', async () => {
    expect(await requestHostAccess(env, ORIGIN)).toBe(true);
    expect(env.permissions.requested).toEqual([[PERMISSION]]);
    expect(env.permissions.granted.has(PERMISSION)).toBe(true);
  });

  it('reports a denial instead of continuing', async () => {
    env.permissions.allow = false;
    expect(await requestHostAccess(env, ORIGIN)).toBe(false);
    expect(env.permissions.granted.size).toBe(0);
  });

  it('reports a rejection (for example outside a user gesture) as a denial', async () => {
    env.permissions.failRequest = new Error('This function must be called during a user gesture');
    expect(await requestHostAccess(env, ORIGIN)).toBe(false);
  });

  it('never turns an unnormalised address into a permission pattern', async () => {
    for (const bad of ['https://*.example.test', 'https://financialos.example.test/', 'not an address']) {
      expect(await requestHostAccess(env, bad)).toBe(false);
    }
    expect(env.permissions.requested).toEqual([]);
  });
});

describe('releaseHostAccess', () => {
  it('gives back access to an address that is no longer configured', async () => {
    env.permissions.granted.add(PERMISSION);
    await releaseHostAccess(env, ORIGIN);
    expect(env.permissions.granted.has(PERMISSION)).toBe(false);
  });

  it('never throws when there is nothing to release', async () => {
    await expect(releaseHostAccess(env, null)).resolves.toBeUndefined();
    await expect(releaseHostAccess(env, 'not an origin')).resolves.toBeUndefined();
  });
});

describe('setup wizard', () => {
  it('starts with no address, no credential and the extension ID on show', async () => {
    startOptionsPage(root, env);
    await settle();
    expect(root.querySelector('[data-testid="status-badge"]')?.textContent).toBe('Not set up');
    expect(root.querySelector('[data-row="extension-id"]')?.textContent).toContain(EXTENSION_ID);
    expect(root.querySelector('#origin')).not.toBeNull();
    expect(env.permissions.requested).toEqual([]);
  });

  it('saves a valid address after Chrome grants access to that one origin', async () => {
    startOptionsPage(root, env);
    await settle();
    type('#origin', 'financialos.example.test');
    submit('[data-form="origin"]');
    await settle();

    expect(env.permissions.requested).toEqual([[PERMISSION]]);
    expect((await readSnapshot(env)).config).toEqual({ origin: ORIGIN });
    expect(text()).toContain('Saved. Next, pair this browser');
    expect(root.querySelector('[data-row="host-access"]')?.textContent).toContain('Allowed for this address only');
  });

  it('keeps nothing when the address is not usable, and never asks Chrome', async () => {
    startOptionsPage(root, env);
    await settle();
    type('#origin', 'http://financialos.example.test/app?x=1');
    submit('[data-form="origin"]');
    await settle();
    expect(env.permissions.requested).toEqual([]);
    expect((await readSnapshot(env)).config).toBeNull();
    expect(root.querySelector('[data-testid="message"]')?.textContent).toMatch(/address/i);
  });

  it('keeps nothing when the owner denies the permission prompt', async () => {
    env.permissions.allow = false;
    startOptionsPage(root, env);
    await settle();
    type('#origin', ORIGIN);
    submit('[data-form="origin"]');
    await settle();
    expect(env.permissions.requested).toEqual([[PERMISSION]]);
    expect((await readSnapshot(env)).config).toBeNull();
    expect(text()).toContain('Chrome did not allow access');
  });

  it('starts pairing and shows the code, without putting it in a link', async () => {
    startOptionsPage(root, env);
    await settle();
    type('#origin', ORIGIN);
    submit('[data-form="origin"]');
    await settle();

    env.respond(() => jsonResponse(200, startBody));
    type('#device-label', 'Work laptop');
    submit('[data-form="pair"]');
    await settle();

    expect(root.querySelector('[data-testid="user-code"]')?.textContent).toBe('K7M2-9QX4');
    expect(root.querySelector('[data-testid="status-badge"]')?.textContent).toBe('Waiting for approval');
    const pairPage = root.querySelector<HTMLAnchorElement>('[data-action="open-pair-page"]');
    expect(pairPage?.getAttribute('href')).toBe(`${ORIGIN}/settings/devices/pair`);
    expect(pairPage?.getAttribute('href')).not.toContain('K7M2');
    expect(env.requests[0]?.body).toMatchObject({ deviceLabel: 'Work laptop' });
    // The permission was granted a moment ago, so pairing does not prompt again.
    expect(env.permissions.requested).toEqual([[PERMISSION]]);
  });

  it('asks for the permission again if it was revoked before pairing', async () => {
    env.local.seed({ 'fos.config': { origin: ORIGIN } });
    startOptionsPage(root, env);
    await settle();
    expect(root.querySelector('[data-row="host-access"]')?.textContent).toContain('Not granted');

    env.respond(() => jsonResponse(200, startBody));
    type('#device-label', 'Work laptop');
    submit('[data-form="pair"]');
    await settle();
    expect(env.permissions.requested).toEqual([[PERMISSION]]);
    expect(root.querySelector('[data-testid="user-code"]')?.textContent).toBe('K7M2-9QX4');
  });

  it('explains a pairing that could not be started', async () => {
    env.local.seed({ 'fos.config': { origin: ORIGIN } });
    env.permissions.granted.add(PERMISSION);
    startOptionsPage(root, env);
    await settle();
    env.respond(() => jsonResponse(403, { error: 'origin_not_allowed' }));
    type('#device-label', 'Work laptop');
    submit('[data-form="pair"]');
    await settle();
    expect(root.querySelector('[data-testid="pairing-error"]')?.textContent).toMatch(/extension ID is allowed/);
  });
});

describe('a paired browser', () => {
  const pairing = {
    origin: ORIGIN,
    deviceId: '2f1c8a44-9e2b-4f7d-9d0a-5c6b7e8f9a01',
    credential: 'device_synthetic-test-credential',
    expiresAt: '2026-10-18T09:00:00.000Z',
    scopes: ['glance:read'],
    pairedAt: '2026-09-18T08:00:00.000Z',
    deviceLabel: 'Work laptop',
  };

  beforeEach(() => {
    env.local.seed({ 'fos.config': { origin: ORIGIN }, 'fos.pairing': pairing });
    env.permissions.granted.add(PERMISSION);
  });

  it('shows what this browser is connected to and what it may read', async () => {
    startOptionsPage(root, env);
    await settle();
    expect(root.querySelector('[data-testid="status-badge"]')?.textContent).toBe('Connected');
    expect(root.querySelector('[data-row="paired-origin"]')?.textContent).toContain(ORIGIN);
    expect(root.querySelector('[data-row="scopes"]')?.textContent).toContain('Glance only (view-only)');
    expect(text()).not.toContain(pairing.credential);
  });

  it('describes what the extension can and cannot do, in plain language', async () => {
    startOptionsPage(root, env);
    await settle();
    const privacy = root.querySelector('[data-testid="privacy"]')?.textContent ?? '';
    expect(privacy).toMatch(/Amounts are hidden by default/);
    expect(privacy).toMatch(/No browsing history/);
    expect(privacy).toMatch(/never synced/);
    expect(privacy).toMatch(/cannot move money/);
  });

  it('changing the address clears the credential and requires pairing again', async () => {
    startOptionsPage(root, env);
    await settle();
    click('[data-action="change-origin"]');
    await settle();
    expect(root.querySelector('[data-testid="change-warning"]')).not.toBeNull();

    type('#origin', 'https://moved.example.test');
    submit('[data-form="origin"]');
    await settle();
    // The owner has to confirm before Chrome is asked for the new origin.
    click('[data-action="dialog-confirm"]');
    await settle();

    const snapshot = await readSnapshot(env);
    expect(snapshot.config).toEqual({ origin: 'https://moved.example.test' });
    expect(snapshot.pairing).toBeNull();
    expect(env.permissions.requested).toEqual([['https://moved.example.test/*']]);
    expect(env.permissions.granted.has(PERMISSION)).toBe(false);
    expect(env.requests).toHaveLength(0);
    expect(root.querySelector('[data-testid="status-badge"]')?.textContent).toBe('Not paired yet');
  });

  it('cancelling the change keeps the credential exactly as it was', async () => {
    startOptionsPage(root, env);
    await settle();
    click('[data-action="change-origin"]');
    await settle();
    type('#origin', 'https://moved.example.test');
    submit('[data-form="origin"]');
    await settle();
    click('[data-action="dialog-cancel"]');
    await settle();

    const snapshot = await readSnapshot(env);
    expect(snapshot.config).toEqual({ origin: ORIGIN });
    expect(snapshot.pairing).toMatchObject({ credential: pairing.credential });
    expect(env.permissions.requested).toEqual([]);
  });

  it('forgetting the device removes everything local and gives back site access', async () => {
    startOptionsPage(root, env);
    await settle();
    click('[data-action="forget"]');
    await settle();
    click('[data-action="dialog-confirm"]');
    await settle();

    expect(env.local.keys()).toEqual([]);
    expect(env.session.keys()).toEqual([]);
    expect(env.permissions.granted.size).toBe(0);
    expect(text()).toMatch(/Also revoke .Work laptop./);
    expect(root.querySelector('[data-testid="status-badge"]')?.textContent).toBe('Not set up');
  });

  it('warns that a credential paired elsewhere is never used', async () => {
    await env.local.set({ 'fos.config': { origin: 'https://moved.example.test' } });
    startOptionsPage(root, env);
    await settle();
    expect(root.querySelector('[data-testid="status-badge"]')?.textContent).toBe('Pair again for the new address');
  });
});
