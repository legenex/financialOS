/**
 * Runtime test for the built Chrome extension.
 *
 * It drives the real `apps/extension/dist` in Chromium against a local mock FinancialOS, so it
 * needs a build first:
 *
 *   npm run build -w apps/extension
 *   PLAYWRIGHT_BROWSERS_PATH=$PWD/.tools/ms-playwright npx playwright test -c tests/extension/playwright.config.ts
 *
 * Extensions load only in a persistent context, and the pages under test are `chrome-extension://`
 * pages, so the spec launches its own context instead of using Playwright's `browser` fixture.
 * Everything runs in one worker, in order: the tests share one browser profile and one mock server.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// The browsers live in the repository's own tool directory on this host.
const bundled = path.join(repoRoot, '.tools', 'ms-playwright');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(bundled)) process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  // Screenshots and traces may show synthetic figures only; the directory is git-ignored.
  outputDir: path.join(repoRoot, 'test-results', 'extension', 'artifacts'),
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: path.join(repoRoot, 'test-results', 'extension', 'report') }]]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'off',
  },
});
