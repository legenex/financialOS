/**
 * Owner bootstrap: one secret, one owner, one seal.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ownerAccount, setupState } from '@financialos/db';
import { createHarness, resetAuthState, TEST_OWNER_NAME, TEST_PASSWORD, type Harness } from '../test-support/harness';
import { TestClient, errorCodeOf, setCookieFor } from '../test-support/client';
import { completeSetup, totpCodeAt, totpSecretFromUri } from '../test-support/auth';
import { SETUP_COOKIE, SETUP_MAX_FAILURES, SETUP_LOCK_SECONDS, SETUP_TOKEN_TTL_SECONDS } from './setup';
import { SESSION_COOKIE_SECURE } from './sessions';

const WRONG_SECRET = 'wrong-secret-that-is-long-enough-0123456789abcdef'; // gitleaks:allow (deliberately-invalid fixture for a negative test)

describe('setup and bootstrap', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  afterEach(async () => {
    await resetAuthState(harness);
  });

  async function state() {
    const [row] = await harness.db.select().from(setupState).where(eq(setupState.id, 1));
    return row;
  }

  it('exposes a public status that reveals no secrets', async () => {
    const client = new TestClient(harness);
    const response = await client.get('/api/setup/status');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'awaiting_bootstrap_secret', steps: { owner: false, totp: false } });
    expect(response.body).not.toContain(harness.bootstrapSecret);
  });

  it('throttles wrong bootstrap secrets and then locks setup', async () => {
    const client = new TestClient(harness);
    for (let attempt = 1; attempt < SETUP_MAX_FAILURES; attempt += 1) {
      const response = await client.post('/api/setup/begin', { bootstrapSecret: `${WRONG_SECRET}${attempt}` });
      expect(response.statusCode, `attempt ${attempt}`).toBe(401);
      expect(errorCodeOf(response)).toBe('bootstrap_secret_invalid');
    }
    const locked = await client.post('/api/setup/begin', { bootstrapSecret: `${WRONG_SECRET}5` });
    expect(locked.statusCode).toBe(429);
    expect(errorCodeOf(locked)).toBe('too_many_attempts');
    expect(locked.headers['retry-after']).toBeDefined();

    // Even the correct secret is refused while the lock holds.
    const duringLock = await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    expect(duringLock.statusCode).toBe(429);
    expect((await state())!.state).toBe('awaiting_bootstrap_secret');

    await harness.clock.advance((SETUP_LOCK_SECONDS + 1) * 1000);
    const after = await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    expect(after.statusCode).toBe(200);
  });

  it('consumes the bootstrap secret exactly once', async () => {
    const client = new TestClient(harness);
    const first = await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    expect(first.statusCode).toBe(200);
    expect((await state())!.bootstrapSecretHash).toBeNull();
    expect((await state())!.bootstrapConsumedAt).not.toBeNull();

    const second = await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    expect(second.statusCode).toBe(409);
    expect(errorCodeOf(second)).toBe('setup_already_started');

    // And from a completely different client, too.
    const other = new TestClient(harness);
    expect((await other.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret })).statusCode).toBe(409);
  });

  it('refuses setup steps without a valid setup cookie', async () => {
    const client = new TestClient(harness);
    expect((await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret })).statusCode).toBe(200);

    const attacker = new TestClient(harness);
    const noCookie = await attacker.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: TEST_PASSWORD });
    expect(noCookie.statusCode).toBe(401);
    expect(errorCodeOf(noCookie)).toBe('setup_token_invalid');

    attacker.setCookie(SETUP_COOKIE, 'A'.repeat(43));
    const wrongCookie = await attacker.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: TEST_PASSWORD });
    expect(wrongCookie.statusCode).toBe(401);
    expect(errorCodeOf(wrongCookie)).toBe('setup_token_invalid');
    expect(setCookieFor(wrongCookie, SETUP_COOKIE)).toBeDefined();

    // The real cookie still works.
    expect((await client.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: TEST_PASSWORD })).statusCode).toBe(200);
  });

  it('expires the setup cookie after its 30-minute lifetime', async () => {
    const client = new TestClient(harness);
    const begin = await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    const header = setCookieFor(begin, SETUP_COOKIE);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).not.toMatch(/Domain=/i);
    expect(SETUP_COOKIE.startsWith('__Host-')).toBe(true);

    await harness.clock.advance((SETUP_TOKEN_TTL_SECONDS + 1) * 1000);
    const late = await client.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: TEST_PASSWORD });
    expect(late.statusCode).toBe(401);
    expect(errorCodeOf(late)).toBe('setup_token_invalid');
  });

  it('creates exactly one owner', async () => {
    const client = new TestClient(harness);
    await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    expect((await client.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: TEST_PASSWORD })).statusCode).toBe(200);

    const second = await client.post('/api/setup/owner', { displayName: 'Second Owner', password: `${TEST_PASSWORD}-two` });
    expect(second.statusCode).toBe(409);
    expect(errorCodeOf(second)).toBe('owner_exists');
    expect(await harness.db.select().from(ownerAccount)).toHaveLength(1);
  });

  it('refuses a weak owner password', async () => {
    const client = new TestClient(harness);
    await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    const short = await client.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: 'short' });
    expect(short.statusCode).toBe(400);
    const common = await client.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: 'correcthorsebatterystaple' });
    expect(common.statusCode).toBe(400);
    expect(errorCodeOf(common)).toBe('password_too_common');
    expect(await harness.db.select().from(ownerAccount)).toHaveLength(0);
  });

  it('will not seal before the required factors exist', async () => {
    const client = new TestClient(harness);
    await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    expect(errorCodeOf(await client.post('/api/setup/seal'))).toBe('setup_incomplete');

    await client.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: TEST_PASSWORD });
    expect(errorCodeOf(await client.post('/api/setup/seal'))).toBe('setup_incomplete');

    const start = await client.post('/api/setup/totp/start');
    const secret = totpSecretFromUri((start.json() as { otpauthUri: string }).otpauthUri);
    await client.post('/api/setup/totp/verify', { code: await totpCodeAt(secret, harness.clock.now()) });
    expect(errorCodeOf(await client.post('/api/setup/seal'))).toBe('setup_incomplete');

    await client.post('/api/setup/recovery-codes');
    expect((await client.post('/api/setup/seal')).statusCode).toBe(200);
  });

  it('rejects a wrong TOTP code during enrollment', async () => {
    const client = new TestClient(harness);
    await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    await client.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: TEST_PASSWORD });
    await client.post('/api/setup/totp/start');
    const bad = await client.post('/api/setup/totp/verify', { code: '000000' });
    expect(bad.statusCode).toBe(400);
    expect(errorCodeOf(bad)).toBe('totp_invalid');
    expect((await state())!.totpVerifiedAt).toBeNull();
  });

  it('sealing does not sign anyone in', async () => {
    const client = new TestClient(harness);
    await completeSetup(harness, { client });
    expect(client.sessionCookie).toBeUndefined();
    const session = await client.get('/api/auth/session');
    expect(session.statusCode).toBe(401);
  });

  it('answers 410 on every setup endpoint once sealed, and clears the setup cookie', async () => {
    const client = new TestClient(harness);
    await completeSetup(harness, { client });
    expect((await state())!.state).toBe('sealed');

    const endpoints: Array<[string, unknown]> = [
      ['/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret }],
      ['/api/setup/owner', { displayName: 'Another Owner', password: `${TEST_PASSWORD}-two` }],
      ['/api/setup/totp/start', undefined],
      ['/api/setup/totp/verify', { code: '123456' }],
      ['/api/setup/recovery-codes', undefined],
      ['/api/setup/passkey/options', undefined],
      ['/api/setup/passkey/verify', {}],
      ['/api/setup/seal', undefined],
    ];
    for (const [path, payload] of endpoints) {
      const response = await client.post(path, payload);
      expect(response.statusCode, path).toBe(410);
      expect(errorCodeOf(response), path).toBe('setup_sealed');
    }
    // Status stays public and honest.
    const status = await client.get('/api/setup/status');
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ state: 'sealed' });
    // Nothing above created a second owner.
    expect(await harness.db.select().from(ownerAccount)).toHaveLength(1);
  });

  it('a setup cookie kept from before the seal cannot resume setup', async () => {
    const client = new TestClient(harness);
    await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    const stolen = client.cookies.get(SETUP_COOKIE) as string;
    expect(stolen).toBeTruthy();
    await completeSetup(harness, { client: new TestClient(harness) }).catch(() => undefined);

    // The above could not begin again, so finish setup with the original client and then retry.
    await client.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: TEST_PASSWORD });
    const start = await client.post('/api/setup/totp/start');
    const secret = totpSecretFromUri((start.json() as { otpauthUri: string }).otpauthUri);
    await client.post('/api/setup/totp/verify', { code: await totpCodeAt(secret, harness.clock.now()) });
    await client.post('/api/setup/recovery-codes');
    expect((await client.post('/api/setup/seal')).statusCode).toBe(200);

    const attacker = new TestClient(harness);
    attacker.setCookie(SETUP_COOKIE, stolen);
    const response = await attacker.post('/api/setup/owner', { displayName: 'Another Owner', password: `${TEST_PASSWORD}-two` });
    expect(response.statusCode).toBe(410);
    expect(await harness.db.select().from(ownerAccount)).toHaveLength(1);
  });

  it('refuses to sign in before setup is sealed', async () => {
    const client = new TestClient(harness);
    await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    await client.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password: TEST_PASSWORD });
    const response = await client.post('/api/auth/login/password', { password: TEST_PASSWORD, totpCode: '123456' });
    expect(response.statusCode).toBe(401);
    expect(errorCodeOf(response)).toBe('invalid_credentials');
    expect(client.cookies.get(SESSION_COOKIE_SECURE)).toBeUndefined();
  });

  it('reports setup as unavailable when the host has no bootstrap secret', async () => {
    await resetAuthState(harness, null);
    const client = new TestClient(harness);
    const response = await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
    expect(response.statusCode).toBe(503);
    expect(errorCodeOf(response)).toBe('setup_unavailable');
  });
});
