/**
 * The launch flow: an extension tile must never reveal a destination without a fresh sign-in.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { auditEvents, launchRequests } from '@financialos/db';
import { createHarness, resetAuthState, type Harness } from '../test-support/harness';
import { TestClient, errorCodeOf, setCookieFor } from '../test-support/client';
import { completeSetup, login, totpCodeAt, type OwnerCredentials } from '../test-support/auth';
import { LAUNCH_COOKIE, LAUNCH_TTL_SECONDS, LOGIN_PATH_FOR_LAUNCH } from './launch';
import { TOTP_PERIOD_SECONDS } from './totp';

const SECOND = 1000;

describe('launch flow', () => {
  let harness: Harness;
  let credentials: OwnerCredentials;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  afterEach(async () => {
    await resetAuthState(harness);
  });

  async function sealed(): Promise<OwnerCredentials> {
    credentials = await completeSetup(harness);
    return credentials;
  }

  async function startLaunch(client: TestClient, target = 'today') {
    const response = await client.get(`/launch/${target}`);
    return response;
  }

  it('redirects to the login screen and never to the destination', async () => {
    await sealed();
    const client = new TestClient(harness);
    const response = await startLaunch(client);
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(LOGIN_PATH_FOR_LAUNCH);
    expect(response.payload).toBe('');

    const cookie = setCookieFor(response, LAUNCH_COOKIE);
    expect(LAUNCH_COOKIE.startsWith('__Host-')).toBe(true);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/(;|$)/i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it('answers 404 for an unknown destination and records nothing', async () => {
    await sealed();
    const client = new TestClient(harness);
    for (const target of ['unknown', 'constructor', '__proto__', 'admin']) {
      const response = await client.get(`/launch/${target}`);
      expect(response.statusCode, target).toBe(404);
      expect(errorCodeOf(response), target).toBe('launch_target_unknown');
      expect(setCookieFor(response, LAUNCH_COOKIE), target).toBeUndefined();
    }
    expect(await harness.db.select().from(launchRequests)).toHaveLength(0);
  });

  it('describes the pending launch without revealing its path', async () => {
    await sealed();
    const client = new TestClient(harness);
    await startLaunch(client, 'goals');
    const info = await client.get('/api/auth/launch');
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ targetLabel: 'Goals', requiresFreshAuthentication: true });
    expect(info.body).not.toContain('/plan/goals');
  });

  it('completes only on an authentication that is newer than the launch', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);
    await startLaunch(client, 'goals');
    const { launchId } = (await client.get('/api/auth/launch')).json() as { launchId: string };

    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    const result = await client.post('/api/auth/login/password', {
      password: creds.password,
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
      launchId,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ redirectTo: '/plan/goals' });
    expect(client.cookies.get(LAUNCH_COOKIE)).toBeUndefined();

    const [row] = await harness.db.select().from(launchRequests).where(eq(launchRequests.id, launchId));
    expect(row!.consumedAt).not.toBeNull();
  });

  it('will not complete a launch created at or after the authentication instant', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);
    // Move past the TOTP step consumed during setup first, so the code below is the only variable.
    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    await startLaunch(client, 'today');
    const { launchId } = (await client.get('/api/auth/launch')).json() as { launchId: string };

    // No time passes between the launch and the sign-in: the sign-in is not strictly newer.
    const result = await client.post('/api/auth/login/password', {
      password: creds.password,
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
      launchId,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ redirectTo: null });

    const [row] = await harness.db.select().from(launchRequests).where(eq(launchRequests.id, launchId));
    expect(row!.consumedAt).toBeNull();
    const [rejected] = await harness.db.select().from(auditEvents).where(eq(auditEvents.action, 'launch.rejected'));
    expect(rejected).toBeDefined();
  });

  it('an existing valid session does not complete a launch', async () => {
    const creds = await sealed();
    const client = await login(harness, creds);
    await harness.clock.advance(5 * SECOND);

    const redirect = await startLaunch(client, 'today');
    expect(redirect.statusCode).toBe(303);
    expect(redirect.headers.location).toBe(LOGIN_PATH_FOR_LAUNCH);

    const info = await client.get('/api/auth/launch');
    expect(info.statusCode).toBe(200);
    // Nothing the signed-in session can do turns the launch into a destination.
    const session = await client.get('/api/auth/session');
    expect(session.statusCode).toBe(200);
    expect(session.body).not.toContain('redirectTo');

    const rows = await harness.db.select().from(launchRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consumedAt).toBeNull();
  });

  it('cannot be replayed once consumed', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);
    await startLaunch(client, 'today');
    const { launchId } = (await client.get('/api/auth/launch')).json() as { launchId: string };
    const cookie = client.cookies.get(LAUNCH_COOKIE) as string;

    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    const first = await login(harness, creds, { client, launchId });
    expect(first).toBeDefined();
    await client.post('/api/auth/logout');

    // Put the launch cookie back and try the same launch id again.
    client.setCookie(LAUNCH_COOKIE, cookie);
    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    const second = await client.post('/api/auth/login/password', {
      password: creds.password,
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
      launchId,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ redirectTo: null });
  });

  it('expires after five minutes', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);
    await startLaunch(client, 'today');
    const { launchId } = (await client.get('/api/auth/launch')).json() as { launchId: string };

    await harness.clock.advance((LAUNCH_TTL_SECONDS + 1) * SECOND);
    const info = await client.get('/api/auth/launch');
    expect(info.statusCode).toBe(404);
    expect(errorCodeOf(info)).toBe('launch_not_found');

    const result = await client.post('/api/auth/login/password', {
      password: creds.password,
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
      launchId,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ redirectTo: null });
  });

  it('refuses a launch id that does not match the cookie', async () => {
    const creds = await sealed();
    const victim = new TestClient(harness);
    await startLaunch(victim, 'today');
    const { launchId } = (await victim.get('/api/auth/launch')).json() as { launchId: string };

    // A different browser holds a launch cookie of its own for another destination.
    const attacker = new TestClient(harness);
    await startLaunch(attacker, 'connections');

    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    const result = await attacker.post('/api/auth/login/password', {
      password: creds.password,
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
      launchId,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ redirectTo: null });
  });

  it('refuses a malformed launch id without touching the launch table', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);
    await startLaunch(client, 'today');
    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    for (const launchId of ['../../etc/passwd', 'not-a-uuid', randomUUID()]) {
      const result = await client.post('/api/auth/login/password', {
        password: creds.password,
        totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
        launchId,
      });
      expect(result.statusCode, launchId).toBe(200);
      expect(result.json(), launchId).toMatchObject({ redirectTo: null });
      await client.post('/api/auth/logout');
      await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    }
  });

  it('never returns an external redirect, even if the stored target is tampered with', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);
    await startLaunch(client, 'today');
    const { launchId } = (await client.get('/api/auth/launch')).json() as { launchId: string };

    for (const evil of ['//evil.test', 'https://evil.test', '/../', 'javascript:alert(1)']) {
      await harness.db.update(launchRequests).set({ target: evil, consumedAt: null, consumedSessionId: null }).where(eq(launchRequests.id, launchId));
      await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
      const result = await client.post('/api/auth/login/password', {
        password: creds.password,
        totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
        launchId,
      });
      expect(result.statusCode, evil).toBe(200);
      expect((result.json() as { redirectTo: string | null }).redirectTo, evil).toBeNull();
      await client.post('/api/auth/logout');
    }
  });

  it('requires a launch cookie to describe a launch', async () => {
    await sealed();
    const client = new TestClient(harness);
    const response = await client.get('/api/auth/launch');
    expect(response.statusCode).toBe(404);
    expect(errorCodeOf(response)).toBe('launch_not_found');
  });
});
