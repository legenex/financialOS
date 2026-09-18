/**
 * Cross-site request forgery and origin policy.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetAuthState, TEST_ORIGIN, type Harness } from '../test-support/harness';
import { createRouteProbe, type RouteProbe } from '../test-support/probe-routes';
import { TestClient, errorCodeOf } from '../test-support/client';
import { login, setupAndLogin } from '../test-support/auth';

describe('CSRF and origin policy', () => {
  let harness: Harness;
  let probe: RouteProbe;

  beforeAll(async () => {
    probe = createRouteProbe();
    harness = await createHarness({ routeModules: [probe.module] });
  });

  afterAll(async () => {
    await harness.close();
  });

  afterEach(async () => {
    await resetAuthState(harness);
  });

  it('refuses a mutation with no CSRF header', async () => {
    const { client } = await setupAndLogin(harness);
    const response = await client.post('/api/test/mutate', {}, { csrf: null });
    expect(response.statusCode).toBe(403);
    expect(errorCodeOf(response)).toBe('csrf_failed');
  });

  it('refuses a mutation with the wrong CSRF token', async () => {
    const { client } = await setupAndLogin(harness);
    const response = await client.post('/api/test/mutate', {}, { csrf: 'not-the-right-token' });
    expect(response.statusCode).toBe(403);
    expect(errorCodeOf(response)).toBe('csrf_failed');
  });

  it('refuses a CSRF token minted for a different session', async () => {
    const { client: first, credentials } = await setupAndLogin(harness);
    const otherToken = first.csrfToken as string;
    expect(otherToken).toBeTruthy();

    await harness.clock.advance(5000);
    const second = await login(harness, credentials);
    expect(second.csrfToken).not.toBe(otherToken);

    const response = await second.post('/api/test/mutate', {}, { csrf: otherToken });
    expect(response.statusCode).toBe(403);
    expect(errorCodeOf(response)).toBe('csrf_failed');

    // The session's own token still works, so the refusal was specific.
    expect((await second.post('/api/test/mutate', {})).statusCode).toBe(200);
  });

  it('refuses a mutation from a foreign Origin before the session is even looked at', async () => {
    const { client } = await setupAndLogin(harness);
    for (const origin of ['https://evil.test', 'http://localhost:31800', 'http://localhost:3180.evil.test', 'null', 'http://localhost:3180/']) {
      const response = await client.post('/api/test/mutate', {}, { origin });
      expect(response.statusCode, origin).toBe(403);
      expect(errorCodeOf(response), origin).toBe('origin_not_allowed');
    }
  });

  it('refuses a mutation with no Origin header at all', async () => {
    const { client } = await setupAndLogin(harness);
    const response = await client.post('/api/test/mutate', {}, { origin: null });
    expect(response.statusCode).toBe(403);
    expect(errorCodeOf(response)).toBe('origin_not_allowed');
  });

  it('refuses any request marked Sec-Fetch-Site: cross-site, including reads', async () => {
    const { client } = await setupAndLogin(harness);
    const read = await client.get('/api/test/private', { secFetchSite: 'cross-site' });
    expect(read.statusCode).toBe(403);
    expect(errorCodeOf(read)).toBe('origin_not_allowed');

    const write = await client.post('/api/test/mutate', {}, { secFetchSite: 'cross-site' });
    expect(write.statusCode).toBe(403);
    expect(errorCodeOf(write)).toBe('origin_not_allowed');
  });

  it('allows same-origin and same-site fetch metadata', async () => {
    const { client } = await setupAndLogin(harness);
    for (const site of ['same-origin', 'same-site', 'none']) {
      expect((await client.get('/api/test/private', { secFetchSite: site })).statusCode, site).toBe(200);
    }
  });

  it('allows a same-origin GET with no Origin header', async () => {
    const { client } = await setupAndLogin(harness);
    expect((await client.get('/api/test/private', { origin: null })).statusCode).toBe(200);
  });

  it('lets the OAuth callback through a cross-site navigation (it carries no session)', async () => {
    const client = new TestClient(harness);
    const response = await client.get('/api/oauth/callback', { secFetchSite: 'cross-site', origin: null });
    // The route is provided by the data layer; the origin guard must not be what rejects it.
    expect(response.statusCode).not.toBe(403);
  });

  it('refuses a text/plain body, which is what a simple cross-site POST would send', async () => {
    const { client } = await setupAndLogin(harness);
    const response = await client.post('/api/test/mutate', '{"mutated":true}', {
      headers: { 'content-type': 'text/plain' },
    });
    expect(response.statusCode).toBe(415);
    expect(errorCodeOf(response)).toBe('unsupported_media_type');
  });

  it('applies the origin check to the login endpoint as well', async () => {
    const client = new TestClient(harness);
    const response = await client.post('/api/auth/login/password', { password: 'x'.repeat(20), totpCode: '000000' }, { origin: 'https://evil.test' });
    expect(response.statusCode).toBe(403);
    expect(errorCodeOf(response)).toBe('origin_not_allowed');
  });

  it('accepts the configured canonical origin exactly', async () => {
    const { client } = await setupAndLogin(harness);
    expect((await client.post('/api/test/mutate', {}, { origin: TEST_ORIGIN })).statusCode).toBe(200);
  });
});
