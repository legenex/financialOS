/**
 * Drives the real built extension in Chromium against a local mock FinancialOS.
 *
 * What this test is for: proving that the package Chrome actually loads behaves the way the unit
 * tests describe — the new tab override appears, pairing stores a credential in local storage
 * only, amounts stay hidden until the server sends them, a revoked device is locked out with no
 * figures on screen, a server that is not there produces a neutral offline state, and many tabs
 * opening at once still ask the server at most once.
 *
 * Run `npm run build -w apps/extension` first: this drives `apps/extension/dist`, not the sources.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { startMockServer, type MockServer } from './mock-server';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const DIST = path.join(repoRoot, 'apps', 'extension', 'dist');
const SHOTS = path.join(repoRoot, 'test-results', 'extension');

const EXTENSION_ID = readFileSync(path.join(repoRoot, 'apps', 'extension', 'EXTENSION_ID.txt'), 'utf8').trim();
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const OPTIONS_URL = `${EXTENSION_ORIGIN}/options.html`;

let server: MockServer;
let context: BrowserContext;
let profileDir: string;
/** Captured from the first real pairing, so later tests can restore it without pairing again. */
let credential: string | null = null;

test.describe.configure({ mode: 'serial' });

function launch(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
}

/**
 * Grants the extension access to exactly one address, the way the owner would by pressing Allow.
 *
 * `chrome.permissions.request()` opens a native confirmation bubble that cannot be clicked in a
 * headless browser, so the grant is written into the profile Chrome just created. The code path
 * that asks for it — including a denial — is covered in apps/extension/src/options/main.test.ts.
 */
function grantHostAccess(pattern: string): void {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
  const entry = prefs.extensions?.settings?.[EXTENSION_ID];
  if (!entry) throw new Error(`the extension is not installed in ${profileDir}`);
  for (const key of ['granted_permissions', 'active_permissions']) {
    entry[key] = { ...entry[key], explicit_host: [pattern] };
  }
  writeFileSync(prefsPath, JSON.stringify(prefs));
}

test.beforeAll(async () => {
  expect(
    existsSync(path.join(DIST, 'manifest.json')),
    'build the extension first: npm run build -w apps/extension',
  ).toBe(true);
  mkdirSync(SHOTS, { recursive: true });
  server = await startMockServer({ extensionOrigin: EXTENSION_ORIGIN });
  profileDir = mkdtempSync(path.join(tmpdir(), 'fos-extension-'));

  // First launch installs the extension and writes its settings; the second runs with host access.
  const warmUp = await launch();
  await warmUp.newPage().then((page) => page.goto(OPTIONS_URL));
  await warmUp.close();
  grantHostAccess(`${server.origin}/*`);
  context = await launch();
});

test.afterAll(async () => {
  await context?.close();
  await server?.close();
});

// ------------------------------------------------------------------------------------------
// Helpers

/** Opens the real new tab page, through Chrome's override rather than by URL. */
async function openNewTab(): Promise<Page> {
  const page = await context.newPage();
  await page.goto('chrome://newtab/');
  await page.waitForSelector('#main[data-view]');
  return page;
}

/** An extension page used only to read and write this extension's own storage. */
async function storagePage(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(OPTIONS_URL);
  return page;
}

async function readStorage(
  page: Page,
): Promise<{ local: Record<string, unknown>; session: Record<string, unknown>; sync: Record<string, unknown> }> {
  return page.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null),
    sync: await chrome.storage.sync.get(null),
  }));
}

/** Clears everything the extension stored, so each test starts from a known state. */
async function resetExtension(): Promise<void> {
  const page = await storagePage();
  await page.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await chrome.storage.sync.clear();
  });
  await page.close();
}

/** Drops the cached glance and the cross-tab throttle, as a browser restart would. */
async function clearGlanceCache(): Promise<void> {
  const page = await storagePage();
  await page.evaluate(() => chrome.storage.session.clear());
  await page.close();
}

async function control(route: string): Promise<unknown> {
  const response = await fetch(`${server.origin}/__test/${route}`);
  return response.json();
}

/** Pairs this browser through the options page exactly as the owner would. */
async function pairThroughTheWizard(): Promise<Page> {
  const page = await storagePage();
  // Step 1 is already done when the address survived an earlier test (for example after a revoke).
  if ((await page.locator('#origin').count()) > 0) {
    await page.fill('#origin', server.origin);
    await page.click('[data-action="save-origin"]');
  }
  await expect(page.locator('[data-row="origin"]')).toContainText(server.origin);
  await expect(page.locator('[data-row="host-access"]')).toContainText('Allowed for this address only');

  await page.fill('#device-label', 'Chrome New Tab (runtime test)');
  await page.click('[data-action="start-pairing"]');
  await expect(page.locator('[data-testid="user-code"]')).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  // The owner types that code into FinancialOS and approves the device.
  const shown = await page.locator('[data-testid="user-code"]').textContent();
  const approved = (await control('approve')) as { approved: boolean; userCode: string };
  expect(approved.approved).toBe(true);
  expect(approved.userCode).toBe(shown);

  await expect(page.locator('[data-testid="paired-success"]')).toBeVisible({ timeout: 30_000 });
  credential = server.state.credential;
  return page;
}

/** Restores a paired state without repeating the wizard, for tests that are about something else. */
async function ensurePaired(): Promise<void> {
  if (!credential) {
    const page = await pairThroughTheWizard();
    await page.close();
    return;
  }
  const page = await storagePage();
  await page.evaluate(
    async ([origin, token]) => {
      await chrome.storage.session.clear();
      await chrome.storage.local.set({
        'fos.config': { origin },
        'fos.pairing': {
          origin,
          deviceId: '2f1c8a44-9e2b-4f7d-9d0a-5c6b7e8f9a01',
          credential: token,
          expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
          scopes: ['glance:read'],
          pairedAt: new Date().toISOString(),
          deviceLabel: 'Chrome New Tab (runtime test)',
        },
      });
      await chrome.storage.local.remove(['fos.pairingEnded']);
    },
    [server.origin, credential] as const,
  );
  await page.close();
}

async function expectNoFigures(page: Page): Promise<void> {
  await expect(page.locator('[data-amount]')).toHaveCount(0);
  const body = (await page.locator('body').textContent()) ?? '';
  expect(body).not.toContain('€');
  expect(body).not.toContain('1,284.50');
  expect(body).not.toContain('7,200');
}

/** Saves the same view at desktop and phone width, in both colour schemes. */
async function shoot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [label, size] of [
      ['1280x800', { width: 1280, height: 800 }],
      ['480x800', { width: 480, height: 800 }],
    ] as const) {
      await page.setViewportSize(size);
      await page.waitForTimeout(120);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}-${label}.png`) });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 800 });
}

// ------------------------------------------------------------------------------------------
// Tests

test('a new tab shows the override page in the not-configured state', async () => {
  await resetExtension();
  const page = await openNewTab();

  expect(page.url()).toBe(`${EXTENSION_ORIGIN}/newtab.html`);
  await expect(page.locator('#main')).toHaveAttribute('data-view', 'not_configured');
  await expect(page.locator('[data-state="not-configured"]')).toBeVisible();
  await expect(page.locator('h1')).toHaveText(/Good (morning|afternoon|evening)|Hello/);
  await expectNoFigures(page);
  // Nothing is asked of any server before the owner has configured one.
  expect(server.state.glanceRequests).toBe(0);

  await shoot(page, 'newtab-not-configured');
  await page.close();
});

test('the manifest Chrome loaded is the restricted one', async () => {
  const page = await storagePage();
  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toEqual(['storage']);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.background).toBeUndefined();
  expect(manifest.chrome_url_overrides).toEqual({ newtab: 'newtab.html' });
  expect(await page.evaluate(() => chrome.runtime.id)).toBe(EXTENSION_ID);
  await page.close();
});

test('pairing completes through the wizard and stores the credential in local storage only', async () => {
  await resetExtension();
  const page = await pairThroughTheWizard();

  const stored = await readStorage(page);
  const pairing = stored.local['fos.pairing'] as { credential: string; origin: string; scopes: string[] };
  expect(pairing.credential).toBe(server.state.credential);
  expect(pairing.origin).toBe(server.origin);
  expect(pairing.scopes).toEqual(['glance:read']);
  expect(stored.local['fos.config']).toEqual({ origin: server.origin });

  // Nothing about this browser is synced to the owner's other devices.
  expect(stored.sync).toEqual({});
  expect(JSON.stringify(stored.sync)).not.toContain('device_');
  // The verifier used to prove the installation is gone once the credential exists.
  expect(Object.keys(stored.session)).not.toContain('fos.pairingDraft');

  // Every pairing call carried the extension's own origin, and never a browser session cookie.
  const pairCalls = server.requests.filter((r) => r.path.startsWith('/api/ext/pair/'));
  expect(pairCalls.length).toBeGreaterThanOrEqual(2);
  for (const call of pairCalls) {
    expect(call.origin).toBe(EXTENSION_ORIGIN);
    expect(call.cookie).toBeUndefined();
  }

  await shoot(page, 'options-paired');
  await page.close();
});

test('the new tab renders the masked glance, then the revealed one', async () => {
  await ensurePaired();
  await clearGlanceCache();

  const masked = await openNewTab();
  await expect(masked.locator('[data-testid="glance"]')).toBeVisible();
  await expect(masked.locator('#main')).toHaveAttribute('data-view', 'connected');
  await expect(masked.locator('[data-privacy]')).toHaveAttribute('data-privacy', 'masked');
  await expectNoFigures(masked);
  await expect(masked.locator('[data-masked]').first()).toBeVisible();
  // The shape of the glance is still there.
  await expect(masked.locator('body')).toContainText('of plan used');
  await expect(masked.locator('body')).toContainText('Emergency fund');
  await expect(masked.locator('body')).toContainText('Office rent');
  await shoot(masked, 'newtab-masked');
  await masked.close();

  // The owner allows two amounts for this device in FinancialOS.
  await control('reveal?fields=safe_to_spend,goal_amounts');
  await clearGlanceCache();

  const revealed = await openNewTab();
  await expect(revealed.locator('[data-testid="glance"]')).toBeVisible();
  await expect(revealed.locator('[data-privacy]')).toHaveAttribute('data-privacy', 'shown');
  await expect(revealed.locator('[data-amount]').first()).toBeVisible();
  await expect(revealed.locator('body')).toContainText('1,284.50');
  // Amounts that were not allowed are still hidden.
  await expect(revealed.locator('body')).not.toContainText('2,310');
  await shoot(revealed, 'newtab-revealed');
  await revealed.close();

  await control('reveal?fields=');
});

test('the glance request carries the device credential and never a session cookie', async () => {
  await ensurePaired();
  await clearGlanceCache();
  const page = await openNewTab();
  await expect(page.locator('[data-testid="glance"]')).toBeVisible();

  const calls = server.requests.filter((r) => r.path === '/api/ext/v1/glance');
  const last = calls.at(-1);
  expect(last?.authorization).toBe(`Bearer ${credential}`);
  expect(last?.cookie).toBeUndefined();
  await page.close();
});

test('opening five new tabs at once asks the server at most once', async () => {
  await ensurePaired();
  await clearGlanceCache();
  await control('reset-counters');

  const pages = await Promise.all([
    context.newPage(),
    context.newPage(),
    context.newPage(),
    context.newPage(),
    context.newPage(),
  ]);
  await Promise.all(pages.map((page) => page.goto('chrome://newtab/')));
  await Promise.all(pages.map((page) => page.waitForSelector('[data-testid="glance"]')));
  // Give any straggling request time to arrive before counting.
  await pages[0]!.waitForTimeout(1_000);

  expect(server.state.glanceRequests).toBeLessThanOrEqual(1);
  expect(server.state.glanceRequests).toBe(1);
  for (const page of pages) {
    await expect(page.locator('#main')).toHaveAttribute('data-view', 'connected');
    await page.close();
  }
});

test('Open FinancialOS goes to /launch/today, which asks for a fresh sign-in', async () => {
  await ensurePaired();
  await clearGlanceCache();
  await control('reset-counters');
  const page = await openNewTab();
  await expect(page.locator('[data-testid="glance"]')).toBeVisible();

  const open = page.locator('a[data-launch="today"]', { hasText: 'Open FinancialOS' });
  await expect(open).toHaveAttribute('href', `${server.origin}/launch/today`);
  // The way into FinancialOS must be reachable without scrolling on an ordinary window.
  await expect(open).toBeInViewport();
  await open.click();
  await page.waitForURL(`${server.origin}/login?launch=1`);

  await expect(page.locator('#login')).toBeVisible();
  expect(server.state.launchRequests).toEqual(['today']);
  // No credential and no code ever travels in a launch URL.
  const launchCall = server.requests.find((r) => r.path === '/launch/today');
  expect(launchCall?.authorization).toBeUndefined();
  await page.close();
});

test('every tile links only to an allowlisted launch target', async () => {
  await ensurePaired();
  await clearGlanceCache();
  const page = await openNewTab();
  await expect(page.locator('[data-testid="glance"]')).toBeVisible();

  const hrefs = await page.locator('a').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('href') ?? ''));
  const allowed = ['today', 'plan', 'goals', 'commitments', 'money', 'coach', 'inbox', 'connections'];
  for (const href of hrefs) {
    if (href === 'options.html') continue;
    expect(href.startsWith(`${server.origin}/launch/`), href).toBe(true);
    expect(allowed).toContain(href.slice(`${server.origin}/launch/`.length));
  }
  await page.close();
});

test('a server that is not there shows a neutral offline state with no figures', async () => {
  await ensurePaired();
  await clearGlanceCache();
  await server.suspend();
  try {
    const page = await openNewTab();
    await expect(page.locator('[data-state^="offline-"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#main')).toHaveAttribute('data-view', 'offline');
    await expectNoFigures(page);
    await expect(page.locator('[data-testid="glance"]')).toHaveCount(0);
    await expect(page.locator('body')).toContainText('Nothing is shown until');
    await shoot(page, 'newtab-offline');
    await page.close();
  } finally {
    await server.resume();
  }
});

test('a revoked device is locked out: the credential is dropped and nothing is shown', async () => {
  await ensurePaired();
  await clearGlanceCache();
  await control('revoke');

  const page = await openNewTab();
  await expect(page.locator('[data-state="pairing-ended"]')).toBeVisible({ timeout: 30_000 });
  await expectNoFigures(page);
  await expect(page.locator('body')).toContainText('pair again');

  const stored = await readStorage(page);
  expect(stored.local['fos.pairing']).toBeUndefined();
  expect(stored.session['fos.glance']).toBeUndefined();
  expect(JSON.stringify(stored)).not.toContain(credential ?? 'no-credential');
  expect(stored.local['fos.pairingEnded']).toMatchObject({ origin: server.origin, reason: 'revoked' });
  await shoot(page, 'newtab-locked');
  await page.close();

  // A revoked device is not retried until the owner pairs again.
  await control('reset-counters');
  const again = await openNewTab();
  await expect(again.locator('[data-state="pairing-ended"]')).toBeVisible();
  expect(server.state.glanceRequests).toBe(0);
  await again.close();

  credential = null;
  server.state.revoked = false;
  server.state.credential = null;
});

test('storage keys live in local and session, never in sync', async () => {
  await ensurePaired();
  await clearGlanceCache();
  const tab = await openNewTab();
  await expect(tab.locator('[data-testid="glance"]')).toBeVisible();
  await tab.close();

  const page = await storagePage();
  const stored = await readStorage(page);
  expect(Object.keys(stored.local).sort()).toEqual(['fos.config', 'fos.pairing']);
  expect(Object.keys(stored.session).sort()).toEqual(['fos.glance', 'fos.refresh']);
  expect(stored.sync).toEqual({});
  await page.close();
});

test('the options page explains the connection and can forget it again', async () => {
  await resetExtension();
  const page = await storagePage();

  // Step 1 of the wizard, before anything is configured.
  await expect(page.locator('[data-testid="status-badge"]')).toHaveText('Not set up');
  await expect(page.locator('[data-row="extension-id"]')).toContainText(EXTENSION_ID);
  await expect(page.locator('[data-testid="privacy"]')).toContainText('Amounts are hidden by default');
  await shoot(page, 'options-not-configured');

  // Addresses that are not usable are refused, each with a reason the owner can act on.
  await page.fill('#origin', 'https://financialos.example.test/app');
  await page.click('[data-action="save-origin"]');
  await expect(page.locator('[data-testid="message"]')).toContainText('without a path');

  await page.fill('#origin', 'http://financialos.example.test');
  await page.click('[data-action="save-origin"]');
  await expect(page.locator('[data-testid="message"]')).toContainText('Use https://');
  await expect(page.locator('[data-row="origin"]')).toContainText('Not set');

  await page.fill('#origin', server.origin);
  await page.click('[data-action="save-origin"]');
  await expect(page.locator('[data-row="origin"]')).toContainText(server.origin);

  await page.fill('#device-label', 'Chrome New Tab (runtime test)');
  await page.click('[data-action="start-pairing"]');
  await expect(page.locator('[data-testid="user-code"]')).toBeVisible();
  await shoot(page, 'options-pairing-code');

  // Forgetting asks for confirmation, then leaves nothing behind.
  await page.click('[data-action="forget"]');
  await page.click('[data-action="dialog-confirm"]');
  await expect(page.locator('[data-testid="status-badge"]')).toHaveText('Not set up');
  const stored = await readStorage(page);
  expect(stored.local).toEqual({});
  expect(stored.session).toEqual({});
  expect(stored.sync).toEqual({});

  // Forgetting also gives Chrome back the site access that was granted for this address, which is
  // why this test runs last: no later test could pair again without a prompt no headless browser
  // can answer.
  const stillGranted = await page.evaluate(
    (pattern) => chrome.permissions.contains({ origins: [pattern] }),
    `${server.origin}/*`,
  );
  expect(stillGranted).toBe(false);
  await page.close();
});
