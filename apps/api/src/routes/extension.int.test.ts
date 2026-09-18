/**
 * Extension pairing and the glance endpoint.
 *
 * The device credential is the weakest credential in the system: it must reach exactly one
 * sanitized endpoint, from exactly one origin, and must never behave like a browser session.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { devicePairings, devices } from '@financialos/db';
import { sha256Base64Url } from '@financialos/security/tokens';
import { createHarness, resetAuthState, TEST_EXTENSION_ORIGIN, TEST_ORIGIN, type Harness } from '../test-support/harness';
import { TestClient, errorCodeOf } from '../test-support/client';
import { createAgentClient, newInstallation, pairDevice, setupAndLogin } from '../test-support/auth';
import { oversharingGlanceProvider } from '../test-support/fake-providers';
import { SESSION_COOKIE_SECURE } from '../auth/sessions';
import { PAIRING_MAX_ATTEMPTS, PAIRING_TTL_SECONDS } from './extension';

const SECOND = 1000;
const DAY = 24 * 3600 * SECOND;

function amountKeysIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => amountKeysIn(item, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const here = typeof record.amount === 'string' && typeof record.currency === 'string' ? [path] : [];
    return [...here, ...Object.entries(record).flatMap(([key, item]) => amountKeysIn(item, `${path}.${key}`))];
  }
  return [];
}

describe('extension endpoints', () => {
  let harness: Harness;
  let owner: TestClient;

  beforeAll(async () => {
    harness = await createHarness({ providers: { glance: oversharingGlanceProvider } });
  });

  afterAll(async () => {
    await harness.close();
  });

  afterEach(async () => {
    await resetAuthState(harness);
  });

  async function signedInOwner(): Promise<TestClient> {
    owner = (await setupAndLogin(harness)).client;
    return owner;
  }

  function extensionClient(): TestClient {
    return new TestClient(harness);
  }

  async function startPairing(client: TestClient, origin = TEST_EXTENSION_ORIGIN) {
    const install = newInstallation();
    const response = await client.post(
      '/api/ext/pair/start',
      { installationId: install.installationId, verifierChallenge: install.verifierChallenge, deviceLabel: 'Test extension', extensionVersion: '1.0.0' },
      { origin },
    );
    return { install, response };
  }

  it('pairs an extension end to end and returns a prefixed credential once', async () => {
    const ownerClient = await signedInOwner();
    const paired = await pairDevice(harness, ownerClient);
    expect(paired.credential.startsWith('fos_dev_')).toBe(true);

    const [row] = await harness.db.select().from(devices).where(eq(devices.id, paired.deviceId));
    expect(row!.credentialHash).not.toContain(paired.credential);
    expect(row!.revealedFields).toEqual([]);
    expect(row!.scopes).toEqual(['glance:read']);
  });

  it('refuses a completion with the wrong verifier or the wrong installation id', async () => {
    const ownerClient = await signedInOwner();
    const ext = extensionClient();
    const { install, response } = await startPairing(ext);
    const { pairingId, userCode } = response.json() as { pairingId: string; userCode: string };
    await ownerClient.post('/api/devices/pair/approve', { userCode, deviceLabel: 'Test extension', expiresInDays: 30 });

    const wrongVerifier = await ext.post(
      '/api/ext/pair/complete',
      { pairingId, installationId: install.installationId, verifier: sha256Base64Url('a different verifier') },
      { origin: TEST_EXTENSION_ORIGIN },
    );
    expect(wrongVerifier.statusCode).toBe(403);
    expect(errorCodeOf(wrongVerifier)).toBe('pairing_proof_invalid');

    const wrongInstallation = await ext.post(
      '/api/ext/pair/complete',
      { pairingId, installationId: `other-${install.installationId}`.slice(0, 60), verifier: install.verifier },
      { origin: TEST_EXTENSION_ORIGIN },
    );
    expect(wrongInstallation.statusCode).toBe(403);
    expect(errorCodeOf(wrongInstallation)).toBe('pairing_proof_invalid');
    expect(await harness.db.select().from(devices)).toHaveLength(0);
  });

  it('denies a pairing after too many wrong proofs', async () => {
    const ownerClient = await signedInOwner();
    const ext = extensionClient();
    const { install, response } = await startPairing(ext);
    const { pairingId, userCode } = response.json() as { pairingId: string; userCode: string };
    await ownerClient.post('/api/devices/pair/approve', { userCode, deviceLabel: 'Test extension', expiresInDays: 30 });

    for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS; attempt += 1) {
      await ext.post(
        '/api/ext/pair/complete',
        { pairingId, installationId: install.installationId, verifier: sha256Base64Url(`guess-${attempt}`) },
        { origin: TEST_EXTENSION_ORIGIN },
      );
    }
    const [row] = await harness.db.select().from(devicePairings).where(eq(devicePairings.id, pairingId));
    expect(row!.deniedAt).not.toBeNull();

    const honest = await ext.post(
      '/api/ext/pair/complete',
      { pairingId, installationId: install.installationId, verifier: install.verifier },
      { origin: TEST_EXTENSION_ORIGIN },
    );
    expect(honest.json()).toMatchObject({ status: 'denied' });
    expect(await harness.db.select().from(devices)).toHaveLength(0);
  });

  it('reports pending until the owner approves', async () => {
    await signedInOwner();
    const ext = extensionClient();
    const { install, response } = await startPairing(ext);
    const { pairingId } = response.json() as { pairingId: string };
    const pending = await ext.post(
      '/api/ext/pair/complete',
      { pairingId, installationId: install.installationId, verifier: install.verifier },
      { origin: TEST_EXTENSION_ORIGIN },
    );
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ status: 'pending' });
    expect(await harness.db.select().from(devices)).toHaveLength(0);
  });

  it('reports expired after the pairing window closes', async () => {
    const ownerClient = await signedInOwner();
    const ext = extensionClient();
    const { install, response } = await startPairing(ext);
    const { pairingId, userCode } = response.json() as { pairingId: string; userCode: string };
    await ownerClient.post('/api/devices/pair/approve', { userCode, deviceLabel: 'Test extension', expiresInDays: 30 });

    await harness.clock.advance((PAIRING_TTL_SECONDS + 1) * SECOND);
    const expired = await ext.post(
      '/api/ext/pair/complete',
      { pairingId, installationId: install.installationId, verifier: install.verifier },
      { origin: TEST_EXTENSION_ORIGIN },
    );
    expect(expired.json()).toMatchObject({ status: 'expired' });
    expect(await harness.db.select().from(devices)).toHaveLength(0);
  });

  it('completes a pairing exactly once', async () => {
    const ownerClient = await signedInOwner();
    const paired = await pairDevice(harness, ownerClient);
    const again = await paired.extensionClient.post(
      '/api/ext/pair/complete',
      { pairingId: paired.pairingId, installationId: paired.installationId, verifier: paired.verifier },
      { origin: TEST_EXTENSION_ORIGIN },
    );
    expect(again.statusCode).toBe(409);
    expect(errorCodeOf(again)).toBe('pairing_already_completed');
    expect(await harness.db.select().from(devices)).toHaveLength(1);
  });

  it('refuses every extension endpoint from an origin that is not the paired extension', async () => {
    const ownerClient = await signedInOwner();
    const paired = await pairDevice(harness, ownerClient);
    const foreign = ['https://evil.test', TEST_ORIGIN, 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba', null];

    for (const origin of foreign) {
      const start = await extensionClient().post(
        '/api/ext/pair/start',
        { ...newInstallation(), deviceLabel: 'x', extensionVersion: '1.0.0', verifierChallenge: newInstallation().verifierChallenge },
        { origin },
      );
      expect(start.statusCode, `start ${origin}`).toBe(403);

      const glance = await extensionClient().get('/api/ext/v1/glance', {
        origin,
        headers: { authorization: `Bearer ${paired.credential}` },
      });
      expect(glance.statusCode, `glance ${origin}`).toBe(403);
      expect(errorCodeOf(glance), `glance ${origin}`).toBe('origin_not_allowed');
    }
  });

  it('returns CORS headers only for an allowed extension origin', async () => {
    await signedInOwner();
    const allowed = await extensionClient().request('OPTIONS', '/api/ext/v1/glance', { origin: TEST_EXTENSION_ORIGIN });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(TEST_EXTENSION_ORIGIN);
    expect(allowed.headers.vary).toContain('Origin');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();

    const refused = await extensionClient().request('OPTIONS', '/api/ext/v1/glance', { origin: 'https://evil.test' });
    expect(refused.statusCode).toBe(403);
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();

    const appOrigin = await extensionClient().request('OPTIONS', '/api/ext/v1/glance', { origin: TEST_ORIGIN });
    expect(appOrigin.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a browser session cookie on every extension endpoint', async () => {
    const ownerClient = await signedInOwner();
    const sessionCookie = ownerClient.sessionCookie as string;
    expect(sessionCookie).toBeTruthy();
    const paired = await pairDevice(harness, ownerClient);

    const ext = extensionClient();
    ext.setCookie(SESSION_COOKIE_SECURE, sessionCookie);

    const glance = await ext.get('/api/ext/v1/glance', {
      origin: TEST_EXTENSION_ORIGIN,
      headers: { authorization: `Bearer ${paired.credential}` },
    });
    expect(glance.statusCode).toBe(401);
    expect(errorCodeOf(glance)).toBe('session_cookie_not_accepted');

    const start = await ext.post(
      '/api/ext/pair/start',
      { ...newInstallation(), deviceLabel: 'x', extensionVersion: '1.0.0' },
      { origin: TEST_EXTENSION_ORIGIN },
    );
    expect(start.statusCode).toBe(401);
    expect(errorCodeOf(start)).toBe('session_cookie_not_accepted');

    const complete = await ext.post(
      '/api/ext/pair/complete',
      { pairingId: paired.pairingId, installationId: paired.installationId, verifier: paired.verifier },
      { origin: TEST_EXTENSION_ORIGIN },
    );
    expect(complete.statusCode).toBe(401);
    expect(errorCodeOf(complete)).toBe('session_cookie_not_accepted');
  });

  it('refuses a device credential on owner and agent routes', async () => {
    const ownerClient = await signedInOwner();
    const paired = await pairDevice(harness, ownerClient);
    const attacker = new TestClient(harness);
    const auth = { authorization: `Bearer ${paired.credential}` };

    const ownerRoute = await attacker.get('/api/security', { headers: auth });
    expect(ownerRoute.statusCode).toBe(401);
    expect(errorCodeOf(ownerRoute)).toBe('credential_not_accepted');

    const agentRoute = await attacker.get('/api/agent/v1/summary', { headers: auth });
    expect(agentRoute.statusCode).toBe(401);
    expect(errorCodeOf(agentRoute)).toBe('agent_unauthorized');

    const mcp = await attacker.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { headers: auth });
    expect(mcp.statusCode).toBe(401);
    expect(errorCodeOf(mcp)).toBe('agent_unauthorized');

    const devicesList = await attacker.get('/api/devices', { headers: auth });
    expect(devicesList.statusCode).toBe(401);
  });

  it('refuses an agent credential on the extension endpoint', async () => {
    const ownerClient = await signedInOwner();
    const agent = await createAgentClient(ownerClient, { scopes: ['read:summary'] });
    const response = await extensionClient().get('/api/ext/v1/glance', {
      origin: TEST_EXTENSION_ORIGIN,
      headers: { authorization: `Bearer ${agent.credential}` },
    });
    expect(response.statusCode).toBe(401);
    expect(errorCodeOf(response)).toBe('device_unauthorized');
  });

  it('masks every amount by default, whatever the provider returns', async () => {
    const ownerClient = await signedInOwner();
    const paired = await pairDevice(harness, ownerClient);
    const response = await paired.extensionClient.get('/api/ext/v1/glance', {
      origin: TEST_EXTENSION_ORIGIN,
      headers: { authorization: `Bearer ${paired.credential}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;

    expect(amountKeysIn(body)).toEqual([]);
    expect(body.privacy).toEqual({ masked: true, revealedFields: [] });
    expect(response.body).not.toContain('1234.56');
    expect(response.body).not.toContain('789.01');
    expect(response.body).not.toContain('1800.00');
    expect(response.body).not.toContain('2500.00');
    // Non-amount context still comes through, so the tile stays useful.
    expect(body.spending).toMatchObject({ status: 'on_track', percentOfPlanUsed: 42 });
    expect((body.goals as unknown[]).length).toBe(3);
  });

  it('reveals only the amounts the owner explicitly enabled', async () => {
    const ownerClient = await signedInOwner();
    const paired = await pairDevice(harness, ownerClient);
    const privacy = await ownerClient.put(`/api/devices/${paired.deviceId}/privacy`, {
      revealedFields: ['safe_to_spend'],
      acknowledgeRisk: true,
    });
    expect(privacy.statusCode).toBe(200);

    const response = await paired.extensionClient.get('/api/ext/v1/glance', {
      origin: TEST_EXTENSION_ORIGIN,
      headers: { authorization: `Bearer ${paired.credential}` },
    });
    const body = response.json() as Record<string, unknown>;
    expect(body.privacy).toEqual({ masked: false, revealedFields: ['safe_to_spend'] });
    expect(amountKeysIn(body)).toEqual(['$.spending.safeToSpend']);
    expect(response.body).toContain('1234.56');
    expect(response.body).not.toContain('789.01');
    expect(response.body).not.toContain('1800.00');
  });

  it('refuses a revoked device and a device whose access expired', async () => {
    const ownerClient = await signedInOwner();
    const revoked = await pairDevice(harness, ownerClient, { deviceLabel: 'To revoke' });
    const expiring = await pairDevice(harness, ownerClient, { deviceLabel: 'To expire', expiresInDays: 1 });

    expect((await ownerClient.post(`/api/devices/${revoked.deviceId}/revoke`)).statusCode).toBe(200);
    const afterRevoke = await revoked.extensionClient.get('/api/ext/v1/glance', {
      origin: TEST_EXTENSION_ORIGIN,
      headers: { authorization: `Bearer ${revoked.credential}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
    expect(errorCodeOf(afterRevoke)).toBe('device_unauthorized');

    await harness.clock.advance(DAY + SECOND);
    const afterExpiry = await expiring.extensionClient.get('/api/ext/v1/glance', {
      origin: TEST_EXTENSION_ORIGIN,
      headers: { authorization: `Bearer ${expiring.credential}` },
    });
    expect(afterExpiry.statusCode).toBe(401);
    expect(errorCodeOf(afterExpiry)).toBe('device_unauthorized');
  });

  it('revoke-all cuts off every device', async () => {
    const ownerClient = await signedInOwner();
    const first = await pairDevice(harness, ownerClient, { deviceLabel: 'One' });
    const second = await pairDevice(harness, ownerClient, { deviceLabel: 'Two' });
    const response = await ownerClient.post('/api/devices/revoke-all');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ revoked: 2 });

    for (const device of [first, second]) {
      const glance = await device.extensionClient.get('/api/ext/v1/glance', {
        origin: TEST_EXTENSION_ORIGIN,
        headers: { authorization: `Bearer ${device.credential}` },
      });
      expect(glance.statusCode).toBe(401);
    }
  });

  it('refuses a credential of the wrong shape and an unknown credential', async () => {
    await signedInOwner();
    const ext = extensionClient();
    for (const credential of ['fos_dev_short', 'not-a-credential', `fos_dev_${'A'.repeat(43)}`, '']) {
      const response = await ext.get('/api/ext/v1/glance', {
        origin: TEST_EXTENSION_ORIGIN,
        ...(credential ? { headers: { authorization: `Bearer ${credential}` } } : {}),
      });
      expect(response.statusCode, credential).toBe(401);
      expect(errorCodeOf(response), credential).toBe('device_unauthorized');
    }
  });

  it('a device credential cannot mint or extend a browser session', async () => {
    const ownerClient = await signedInOwner();
    const paired = await pairDevice(harness, ownerClient);
    const ext = extensionClient();
    const glance = await ext.get('/api/ext/v1/glance', {
      origin: TEST_EXTENSION_ORIGIN,
      headers: { authorization: `Bearer ${paired.credential}` },
    });
    expect(glance.statusCode).toBe(200);
    expect(glance.headers['set-cookie']).toBeUndefined();
    expect(ext.sessionCookie).toBeUndefined();

    // Reading the glance does not keep the owner's web session alive either.
    await harness.clock.advance(600 * SECOND);
    const again = await ext.get('/api/ext/v1/glance', {
      origin: TEST_EXTENSION_ORIGIN,
      headers: { authorization: `Bearer ${paired.credential}` },
    });
    expect(again.statusCode).toBe(200);
    expect((await ownerClient.get('/api/security')).statusCode).toBe(401);
  });

  it('refuses an approval code that does not match an open pairing', async () => {
    const ownerClient = await signedInOwner();
    const ext = extensionClient();
    await startPairing(ext);
    const response = await ownerClient.post('/api/devices/pair/approve', { userCode: 'ZZZZ-ZZZZ', deviceLabel: 'Nope', expiresInDays: 30 });
    expect(response.statusCode).toBe(404);
    expect(errorCodeOf(response)).toBe('pairing_code_invalid');
  });

  it('requires an owner session to approve a pairing', async () => {
    await signedInOwner();
    const ext = extensionClient();
    const { response } = await startPairing(ext);
    const { userCode } = response.json() as { userCode: string };
    const anonymous = new TestClient(harness);
    const attempt = await anonymous.post('/api/devices/pair/approve', { userCode, deviceLabel: 'Nope', expiresInDays: 30 });
    expect(attempt.statusCode).toBe(401);
  });

  it('refuses a privacy change for an unknown device id', async () => {
    const ownerClient = await signedInOwner();
    const response = await ownerClient.put(`/api/devices/${randomUUID()}/privacy`, { revealedFields: ['due_amounts'], acknowledgeRisk: true });
    expect(response.statusCode).toBe(404);
  });

  it('will not change privacy without an explicit risk acknowledgement', async () => {
    const ownerClient = await signedInOwner();
    const paired = await pairDevice(harness, ownerClient);
    const response = await ownerClient.put(`/api/devices/${paired.deviceId}/privacy`, { revealedFields: ['safe_to_spend'] });
    expect(response.statusCode).toBe(400);
    expect(errorCodeOf(response)).toBe('invalid_request');
  });
});
