/**
 * Sign-in: second factors, replay protection, recovery codes, throttling, generic errors.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { auditEvents, recoveryCodes as recoveryCodesTable, sessions as sessionsTable } from '@financialos/db';
import { createHarness, clearThrottles, resetAuthState, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { TestClient, errorCodeOf } from '../test-support/client';
import { completeSetup, totpCodeAt, type OwnerCredentials } from '../test-support/auth';
import { hashRecoveryCode } from './recovery';
import { POLICIES } from './throttle';
import { TOTP_PERIOD_SECONDS } from './totp';
import { SESSION_COOKIE_SECURE } from './sessions';

const SECOND = 1000;

describe('sign-in', () => {
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

  it('refuses a TOTP code that was already used, then accepts the next step', async () => {
    const creds = await sealed();
    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    const code = await totpCodeAt(creds.totpSecret, harness.clock.now());

    const first = new TestClient(harness);
    expect((await first.post('/api/auth/login/password', { password: creds.password, totpCode: code })).statusCode).toBe(200);
    expect((await first.post('/api/auth/logout')).statusCode).toBe(204);

    const replay = new TestClient(harness);
    const replayed = await replay.post('/api/auth/login/password', { password: creds.password, totpCode: code });
    expect(replayed.statusCode).toBe(401);
    expect(errorCodeOf(replayed)).toBe('invalid_credentials');
    expect(replay.cookies.get(SESSION_COOKIE_SECURE)).toBeUndefined();

    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    const next = await replay.post('/api/auth/login/password', {
      password: creds.password,
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
    });
    expect(next.statusCode).toBe(200);
  });

  it('accepts a code one step old but not two', async () => {
    const creds = await sealed();
    await harness.clock.advance(3 * TOTP_PERIOD_SECONDS * SECOND);
    const client = new TestClient(harness);

    const twoStepsOld = await totpCodeAt(creds.totpSecret, new Date(harness.clock.epochMs - 2 * TOTP_PERIOD_SECONDS * SECOND));
    const stale = await client.post('/api/auth/login/password', { password: creds.password, totpCode: twoStepsOld });
    expect(stale.statusCode).toBe(401);

    const oneStepOld = await totpCodeAt(creds.totpSecret, new Date(harness.clock.epochMs - TOTP_PERIOD_SECONDS * SECOND));
    const ok = await client.post('/api/auth/login/password', { password: creds.password, totpCode: oneStepOld });
    expect(ok.statusCode).toBe(200);
  });

  it('requires exactly one second factor', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);

    const none = await client.post('/api/auth/login/password', { password: creds.password });
    expect(none.statusCode).toBe(401);
    expect(errorCodeOf(none)).toBe('invalid_credentials');

    const both = await client.post('/api/auth/login/password', {
      password: creds.password,
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
      recoveryCode: creds.recoveryCodes[0],
    });
    expect(both.statusCode).toBe(401);
    expect(errorCodeOf(both)).toBe('invalid_credentials');
    expect(await harness.db.select().from(sessionsTable)).toHaveLength(0);
  });

  it('stores recovery codes hashed and burns each one exactly once', async () => {
    const creds = await sealed();
    const code = creds.recoveryCodes[0] as string;

    const rows = await harness.db.select().from(recoveryCodesTable);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.codeHash).not.toContain(code.replace(/-/g, ''));
      expect(creds.recoveryCodes).not.toContain(row.codeHash);
    }
    expect(rows.some((r) => r.codeHash === hashRecoveryCode(harness.pepper, code))).toBe(true);

    const client = new TestClient(harness);
    const first = await client.post('/api/auth/login/password', { password: creds.password, recoveryCode: code });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ recoveryCodesRemaining: 9 });
    expect((await client.post('/api/auth/logout')).statusCode).toBe(204);

    const reuse = await client.post('/api/auth/login/password', { password: creds.password, recoveryCode: code });
    expect(reuse.statusCode).toBe(401);
    expect(errorCodeOf(reuse)).toBe('invalid_credentials');

    // A lower-case, unspaced form of a *different* code still works: normalisation is not a bypass.
    const second = creds.recoveryCodes[1] as string;
    const normalisedDifferently = second.toLowerCase().replace(/-/g, ' ');
    expect((await client.post('/api/auth/login/password', { password: creds.password, recoveryCode: normalisedDifferently })).statusCode).toBe(200);
  });

  it('gives the same answer whether the password or the second factor was wrong', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);
    const wrongPassword = await client.post('/api/auth/login/password', {
      password: 'definitely-not-the-password-1',
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
    });
    await clearThrottles(harness);
    const wrongCode = await client.post('/api/auth/login/password', { password: creds.password, totpCode: '000000' });
    await clearThrottles(harness);
    const wrongRecovery = await client.post('/api/auth/login/password', { password: creds.password, recoveryCode: 'ABCD-EFGH-JKMN-PQRS' });

    for (const response of [wrongPassword, wrongCode, wrongRecovery]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: { code: 'invalid_credentials', message: 'Sign-in failed. Check your details and try again.' } });
    }
    // The failure reason is recorded for the owner, but never returned to the client.
    const events = await harness.db.select().from(auditEvents).where(eq(auditEvents.action, 'auth.login_failed')).orderBy(desc(auditEvents.occurredAt));
    expect(events.length).toBeGreaterThanOrEqual(3);
    const reasons = events.map((e) => (e.details as { reason?: string }).reason);
    expect(reasons).toContain('password');
    expect(reasons).toContain('totp');
    expect(reasons).toContain('recovery_code');
  });

  it('locks a client out after repeated failures and refuses even correct credentials until it lifts', async () => {
    const creds = await sealed();
    const client = new TestClient(harness, { ip: '203.0.113.9' });
    for (let attempt = 0; attempt < POLICIES.loginClient.threshold; attempt += 1) {
      const response = await client.post('/api/auth/login/password', { password: `wrong-password-${attempt}-aaaaaaaa`, totpCode: '000000' });
      expect(response.statusCode, `attempt ${attempt}`).toBe(401);
    }

    const locked = await client.post('/api/auth/login/password', {
      password: creds.password,
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
    });
    expect(locked.statusCode).toBe(429);
    expect(errorCodeOf(locked)).toBe('too_many_attempts');
    expect(locked.headers['retry-after']).toBeDefined();
    expect((locked.json() as { error: { details: { retryAfterSeconds: number } } }).error.details.retryAfterSeconds).toBeGreaterThan(0);

    // Another client is not locked out by the first one's mistakes.
    const other = new TestClient(harness, { ip: '203.0.113.10' });
    const otherAttempt = await other.post('/api/auth/login/password', { password: 'still-wrong-password-here', totpCode: '000000' });
    expect(otherAttempt.statusCode).toBe(401);

    await harness.clock.advance((POLICIES.loginClient.baseLockSeconds + 1) * SECOND);
    const after = await client.post('/api/auth/login/password', {
      password: creds.password,
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
    });
    expect(after.statusCode).toBe(200);
  });

  it('lengthens the lockout with every further failure', async () => {
    await sealed();
    const client = new TestClient(harness, { ip: '203.0.113.11' });
    for (let attempt = 0; attempt < POLICIES.loginClient.threshold; attempt += 1) {
      await client.post('/api/auth/login/password', { password: `wrong-password-${attempt}-aaaaaaaa`, totpCode: '000000' });
    }
    const first = await client.post('/api/auth/login/password', { password: 'wrong-password-x-aaaaaaaa', totpCode: '000000' });
    expect(first.statusCode).toBe(429);
    const firstWait = Number(first.headers['retry-after']);

    await harness.clock.advance((firstWait + 1) * SECOND);
    await client.post('/api/auth/login/password', { password: 'wrong-password-y-aaaaaaaa', totpCode: '000000' });
    const second = await client.post('/api/auth/login/password', { password: 'wrong-password-z-aaaaaaaa', totpCode: '000000' });
    expect(second.statusCode).toBe(429);
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(firstWait);
  });

  it('a successful sign-in clears the client throttle', async () => {
    const creds = await sealed();
    const client = new TestClient(harness, { ip: '203.0.113.12' });
    for (let attempt = 0; attempt < POLICIES.loginClient.threshold - 1; attempt += 1) {
      await client.post('/api/auth/login/password', { password: `wrong-password-${attempt}-aaaaaaaa`, totpCode: '000000' });
    }
    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    expect(
      (
        await client.post('/api/auth/login/password', {
          password: creds.password,
          totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
        })
      ).statusCode,
    ).toBe(200);
    await client.post('/api/auth/logout');

    // The counter is gone, so a single further mistake does not lock the owner out.
    const mistake = await client.post('/api/auth/login/password', { password: 'wrong-password-again-aaaa', totpCode: '000000' });
    expect(mistake.statusCode).toBe(401);
  });

  it('slows distributed guessing with a global lockout', async () => {
    await sealed();
    let ipSuffix = 20;
    let global429 = false;
    for (let batch = 0; batch < 8 && !global429; batch += 1) {
      const client = new TestClient(harness, { ip: `203.0.113.${ipSuffix}` });
      ipSuffix += 1;
      for (let attempt = 0; attempt < POLICIES.loginClient.threshold; attempt += 1) {
        const response = await client.post('/api/auth/login/password', { password: `wrong-password-${batch}-${attempt}-aa`, totpCode: '000000' });
        if (response.statusCode === 429) {
          global429 = true;
          break;
        }
      }
    }
    // A brand new client is refused too, because the global counter tripped.
    const fresh = new TestClient(harness, { ip: '203.0.113.99' });
    const response = await fresh.post('/api/auth/login/password', { password: 'another-wrong-password-aa', totpCode: '000000' });
    expect(response.statusCode).toBe(429);
    expect(errorCodeOf(response)).toBe('too_many_attempts');
  }, 60_000);

  it('records an audit event for a successful sign-in without the credentials', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);
    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    const code = await totpCodeAt(creds.totpSecret, harness.clock.now());
    expect((await client.post('/api/auth/login/password', { password: creds.password, totpCode: code })).statusCode).toBe(200);

    const [event] = await harness.db.select().from(auditEvents).where(eq(auditEvents.action, 'auth.login_succeeded'));
    expect(event).toBeDefined();
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain(creds.password);
    expect(serialised).not.toContain(code);
    expect(event!.ipHash).toBeTruthy();
    expect(event!.ipHash).not.toContain('203.0.113');
  });

  it('never returns a session cookie on a failed sign-in', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);
    const response = await client.post('/api/auth/login/password', { password: creds.password, totpCode: '000000' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('refuses an Authorization header on owner routes', async () => {
    const creds = await sealed();
    const client = new TestClient(harness);
    await harness.clock.advance(TOTP_PERIOD_SECONDS * SECOND);
    await client.post('/api/auth/login/password', {
      password: creds.password,
      totpCode: await totpCodeAt(creds.totpSecret, harness.clock.now()),
    });
    const response = await client.get('/api/security', { headers: { authorization: 'Bearer fos_agent_something' } });
    expect(response.statusCode).toBe(401);
    expect(errorCodeOf(response)).toBe('credential_not_accepted');
  });

  it('does not reveal whether an owner exists before setup is complete', async () => {
    const client = new TestClient(harness);
    const response = await client.post('/api/auth/login/password', { password: TEST_PASSWORD, totpCode: '123456' });
    expect(response.statusCode).toBe(401);
    expect(errorCodeOf(response)).toBe('invalid_credentials');
  });
});
