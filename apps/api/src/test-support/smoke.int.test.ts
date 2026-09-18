import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness';
import { TestClient } from './client';
import { setupAndLogin } from './auth';

describe('test harness', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('serves health without a session', async () => {
    const client = new TestClient(harness);
    const response = await client.get('/healthz');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('completes setup and signs in', async () => {
    const { client } = await setupAndLogin(harness);
    const session = await client.get('/api/auth/session');
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, ownerName: 'Example Owner' });
    expect(client.csrfToken).toBeTruthy();
  });
});
