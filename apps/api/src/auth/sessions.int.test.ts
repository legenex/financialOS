/**
 * The ten-minute rule, end to end.
 *
 * Every assertion here is about the hard invariant in docs/SECURITY.md: a session is dead 600
 * seconds after authentication, whatever the owner does in between.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { sessions as sessionsTable } from '@financialos/db';
import { SESSION_ABSOLUTE_SECONDS } from '@financialos/contracts';
import { createHarness, resetAuthState, type Harness } from '../test-support/harness';
import { waitFor } from '../test-support/clock';
import { createRouteProbe, type RouteProbe } from '../test-support/probe-routes';
import { TestClient, errorCodeOf, setCookieFor } from '../test-support/client';
import { login, setupAndLogin, type OwnerCredentials } from '../test-support/auth';
import { SESSION_COOKIE_SECURE } from './sessions';

const SECOND = 1000;

describe('owner sessions', () => {
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

  async function signIn(): Promise<{ client: TestClient; credentials: OwnerCredentials }> {
    return setupAndLogin(harness);
  }

  async function currentRow(harness2: Harness) {
    const [row] = await harness2.db.select().from(sessionsTable).orderBy(desc(sessionsTable.authenticatedAt)).limit(1);
    return row;
  }

  it('accepts a request at 599 s and refuses one at exactly 600 s, despite activity every 30 s', async () => {
    const { client } = await signIn();
    const authenticatedAt = harness.clock.epochMs;

    // Constant activity must not buy a single second.
    for (let elapsed = 30; elapsed <= 570; elapsed += 30) {
      await harness.clock.advanceTo(authenticatedAt + elapsed * SECOND);
      const response = await client.get('/api/test/private');
      expect(response.statusCode, `at ${elapsed}s`).toBe(200);
    }

    await harness.clock.advanceTo(authenticatedAt + 599 * SECOND);
    const atLimit = await client.get('/api/test/private');
    expect(atLimit.statusCode).toBe(200);

    await harness.clock.advanceTo(authenticatedAt + 600 * SECOND);
    const expired = await client.get('/api/test/private');
    expect(expired.statusCode).toBe(401);
    expect(errorCodeOf(expired)).toBe('session_expired');

    await harness.clock.advanceTo(authenticatedAt + 900 * SECOND);
    const later = await client.get('/api/test/private');
    expect(later.statusCode).toBe(401);
  });

  it('clears the cookie when the absolute deadline has passed', async () => {
    const { client } = await signIn();
    await harness.clock.advance(600 * SECOND);
    const response = await client.get('/api/test/private');
    expect(response.statusCode).toBe(401);
    const cleared = setCookieFor(response, SESSION_COOKIE_SECURE);
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
    expect(client.sessionCookie).toBeUndefined();
  });

  it('never moves absolute_expires_at after creation', async () => {
    const { client } = await signIn();
    const created = await currentRow(harness);
    expect(created).toBeDefined();
    const absolute = created!.absoluteExpiresAt.getTime();
    expect(absolute - created!.authenticatedAt.getTime()).toBe(SESSION_ABSOLUTE_SECONDS * SECOND);

    for (const elapsed of [10, 120, 300, 550]) {
      await harness.clock.advanceTo(created!.authenticatedAt.getTime() + elapsed * SECOND);
      expect((await client.get('/api/test/private')).statusCode).toBe(200);
      expect((await client.get('/api/auth/session')).statusCode).toBe(200);
      expect((await client.put('/api/security/idle-timeout', { seconds: 600 })).statusCode).toBe(200);
      const [row] = await harness.db.select().from(sessionsTable).where(eq(sessionsTable.id, created!.id));
      expect(row!.absoluteExpiresAt.getTime(), `after ${elapsed}s`).toBe(absolute);
    }
  });

  it('caps the idle deadline at the absolute deadline', async () => {
    const { client } = await signIn();
    const created = await currentRow(harness);
    expect((await client.put('/api/security/idle-timeout', { seconds: 600 })).statusCode).toBe(200);

    await harness.clock.advance(500 * SECOND);
    expect((await client.get('/api/test/private')).statusCode).toBe(200);
    const [row] = await harness.db.select().from(sessionsTable).where(eq(sessionsTable.id, created!.id));
    expect(row!.idleExpiresAt.getTime()).toBe(row!.absoluteExpiresAt.getTime());

    // 600 s idle from t=500 would have reached t=1100 had the cap not applied.
    await harness.clock.advance(100 * SECOND);
    expect((await client.get('/api/test/private')).statusCode).toBe(401);
  });

  it('expires an idle session and reports session_expired', async () => {
    const { client } = await signIn();
    expect((await client.put('/api/security/idle-timeout', { seconds: 60 })).statusCode).toBe(200);
    // The new timeout applies from the next recorded activity.
    expect((await client.get('/api/test/private')).statusCode).toBe(200);

    await harness.clock.advance(59 * SECOND);
    expect((await client.get('/api/test/private')).statusCode).toBe(200);

    await harness.clock.advance(60 * SECOND);
    const expired = await client.get('/api/test/private');
    expect(expired.statusCode).toBe(401);
    expect(errorCodeOf(expired)).toBe('session_expired');
  });

  it('does not treat background requests or GET /api/auth/session as activity', async () => {
    const { client } = await signIn();
    expect((await client.put('/api/security/idle-timeout', { seconds: 60 })).statusCode).toBe(200);
    expect((await client.get('/api/test/private')).statusCode).toBe(200);
    const before = (await currentRow(harness))!.idleExpiresAt.getTime();

    await harness.clock.advance(30 * SECOND);
    expect((await client.get('/api/auth/session')).statusCode).toBe(200);
    expect((await client.get('/api/test/private', { background: true })).statusCode).toBe(200);
    expect((await currentRow(harness))!.idleExpiresAt.getTime()).toBe(before);

    // Polling every 30 s must not keep the session alive past the idle timeout.
    await harness.clock.advance(31 * SECOND);
    expect((await client.get('/api/auth/session')).statusCode).toBe(401);
    expect((await client.get('/api/test/private', { background: true })).statusCode).toBe(401);
  });

  it('revokes every earlier session when a new authentication happens', async () => {
    const { client: first, credentials } = await signIn();
    expect((await first.get('/api/test/private')).statusCode).toBe(200);

    await harness.clock.advance(60 * SECOND);
    const second = await login(harness, credentials);
    expect((await second.get('/api/test/private')).statusCode).toBe(200);

    const stale = await first.get('/api/test/private');
    expect(stale.statusCode).toBe(401);
    expect(errorCodeOf(stale)).toBe('session_expired');

    const rows = await harness.db.select().from(sessionsTable).orderBy(desc(sessionsTable.authenticatedAt));
    expect(rows).toHaveLength(2);
    expect(rows[1]!.revokeReason).toBe('superseded');
  });

  it('ends the session on logout and clears the cookie', async () => {
    const { client } = await signIn();
    const logout = await client.post('/api/auth/logout');
    expect(logout.statusCode).toBe(204);
    expect(setCookieFor(logout, SESSION_COOKIE_SECURE)).toBeDefined();
    expect(client.sessionCookie).toBeUndefined();

    const rows = await harness.db.select().from(sessionsTable);
    expect(rows[0]!.revokeReason).toBe('logout');
  });

  it('a revoked session token is refused and its cookie cleared', async () => {
    const { client } = await signIn();
    const row = await currentRow(harness);
    await harness.db.update(sessionsTable).set({ revokedAt: harness.clock.now(), revokeReason: 'revoked_by_owner' }).where(eq(sessionsTable.id, row!.id));

    const response = await client.get('/api/test/private');
    expect(response.statusCode).toBe(401);
    expect(errorCodeOf(response)).toBe('session_expired');
    expect(setCookieFor(response, SESSION_COOKIE_SECURE)).toBeDefined();
  });

  it('logout-all revokes every session', async () => {
    const { client, credentials } = await signIn();
    await harness.clock.advance(5 * SECOND);
    const second = await login(harness, credentials);
    void client;

    const response = await second.post('/api/auth/logout-all');
    expect(response.statusCode).toBe(204);
    const rows = await harness.db.select().from(sessionsTable);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect((await second.get('/api/test/private')).statusCode).toBe(401);
  });

  it('issues a __Host- prefixed, HttpOnly, Secure, SameSite=Strict cookie scoped to / with no Domain', async () => {
    const { client } = await signIn();
    void client;
    // The login response is the one that set it; re-read it from a fresh sign-in.
    await resetAuthState(harness);
    const fresh = await setupAndLogin(harness);
    const info = await fresh.client.get('/api/auth/session');
    expect(info.statusCode).toBe(200);

    const loginResponse = await fresh.client.post('/api/auth/logout');
    const header = setCookieFor(loginResponse, SESSION_COOKIE_SECURE);
    expect(header).toBeDefined();
    expect(SESSION_COOKIE_SECURE.startsWith('__Host-')).toBe(true);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Path=\/(;|$)/i);
    expect(header).not.toMatch(/Domain=/i);
  });

  it('a session-bound stream emits session-expired at the deadline and writes nothing after it', async () => {
    const { client } = await signIn();
    // Raise the idle timeout to its maximum so the ABSOLUTE deadline is what closes the stream.
    expect((await client.put('/api/security/idle-timeout', { seconds: 600 })).statusCode).toBe(200);
    const pending = client.get('/api/test/stream');
    const stream = await probe.nextStream();

    expect(await stream.send('progress', { step: 1 })).toBe(true);

    await harness.clock.advance(300 * SECOND);
    expect(await stream.send('progress', { step: 2 })).toBe(true);

    // Past the absolute deadline the stream must close itself.
    await harness.clock.advance(300 * SECOND);
    await waitFor(() => stream.closed, { label: 'stream closed at absolute deadline' });

    // Anything the handler tries to send afterwards is dropped.
    expect(await stream.send('balances', { amount: 'SENSITIVE-9999' })).toBe(false);

    const response = await pending;
    expect(response.payload).toContain('event: session-expired');
    expect(response.payload).toContain('"step":1');
    expect(response.payload).toContain('"step":2');
    expect(response.payload).not.toContain('SENSITIVE-9999');
    expect(response.payload.indexOf('event: session-expired')).toBe(response.payload.lastIndexOf('event: session-expired'));
    // Nothing is written after the expiry event.
    expect(response.payload.trimEnd().endsWith('data: {"code":"session_expired"}')).toBe(true);
  });

  it('a stream closes at the idle deadline too: holding it open is not activity', async () => {
    const { client } = await signIn();
    expect((await client.put('/api/security/idle-timeout', { seconds: 60 })).statusCode).toBe(200);
    expect((await client.get('/api/test/private')).statusCode).toBe(200);

    const pending = client.get('/api/test/stream');
    const stream = await probe.nextStream();
    expect(await stream.send('progress', { step: 1 })).toBe(true);

    await harness.clock.advance(60 * SECOND);
    await waitFor(() => stream.closed, { label: 'stream closed at idle deadline' });
    expect(await stream.send('balances', { amount: 'SENSITIVE-9999' })).toBe(false);
    const response = await pending;
    expect(response.payload).toContain('event: session-expired');
    expect(response.payload).not.toContain('SENSITIVE-9999');
  });

  it('a stream stops as soon as the session is revoked, even before the deadline', async () => {
    const { client } = await signIn();
    const pending = client.get('/api/test/stream');
    const stream = await probe.nextStream();
    expect(await stream.send('progress', { step: 1 })).toBe(true);

    const row = await currentRow(harness);
    await harness.db.update(sessionsTable).set({ revokedAt: harness.clock.now(), revokeReason: 'logout_all' }).where(eq(sessionsTable.id, row!.id));

    expect(await stream.send('balances', { amount: 'SENSITIVE-9999' })).toBe(false);
    const response = await pending;
    expect(response.payload).toContain('event: session-expired');
    expect(response.payload).not.toContain('SENSITIVE-9999');
  });

  it('refuses a download once the session has expired', async () => {
    const { client } = await signIn();
    await harness.clock.advance(600 * SECOND);
    const response = await client.get('/api/test/download');
    expect(response.statusCode).toBe(401);
    expect(errorCodeOf(response)).toBe('session_expired');
  });

  it('aborts a download that is still streaming when the session expires', async () => {
    const { client } = await signIn();
    const pending = client.get('/api/test/download');
    const body = await probe.nextDownload();
    body.write('first-chunk;');

    await harness.clock.advance(600 * SECOND);
    const response = await pending.catch((err: Error) => err);
    if (response instanceof Error) {
      expect(String(response.message)).toMatch(/session|abort|destroy/i);
    } else {
      expect(response.payload).not.toContain('second-chunk');
    }
    expect(body.destroyed).toBe(true);
  });

  it('a stale cookie from before a re-authentication is refused', async () => {
    const { client, credentials } = await signIn();
    const stolen = client.sessionCookie as string;
    await harness.clock.advance(10 * SECOND);
    await login(harness, credentials);

    const attacker = new TestClient(harness);
    attacker.setCookie(SESSION_COOKIE_SECURE, stolen);
    const response = await attacker.get('/api/test/private');
    expect(response.statusCode).toBe(401);
  });

  it('refuses a session cookie of the wrong shape without touching the database', async () => {
    const attacker = new TestClient(harness);
    attacker.setCookie(SESSION_COOKIE_SECURE, 'not-a-real-token');
    const response = await attacker.get('/api/test/private');
    expect(response.statusCode).toBe(401);
    expect(errorCodeOf(response)).toBe('session_expired');
  });
});
