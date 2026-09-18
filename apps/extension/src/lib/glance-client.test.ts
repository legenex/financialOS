import { describe, expect, it } from 'vitest';
import { GLANCE_PATH, fetchGlance } from './glance-client';
import { sampleGlance } from './fixtures';
import { jsonResponse, testEnv, UNREACHABLE } from './testing';
import type { StoredPairing } from './storage';

const ORIGIN = 'https://financialos.example.test';
const CREDENTIAL = 'device_synthetic-test-credential';

const pairing: StoredPairing = {
  origin: ORIGIN,
  deviceId: '2f1c8a44-9e2b-4f7d-9d0a-5c6b7e8f9a01',
  credential: CREDENTIAL,
  expiresAt: '2026-10-18T09:00:00.000Z',
  scopes: ['glance:read'],
  pairedAt: '2026-09-18T09:00:00.000Z',
  deviceLabel: 'Chrome New Tab (Test)',
};

describe('fetchGlance', () => {
  it('sends the credential as a bearer token, with no cookies and no redirects', async () => {
    const env = testEnv();
    env.respond(() => jsonResponse(200, sampleGlance()));
    const result = await fetchGlance(env, ORIGIN, pairing);
    expect(result.kind).toBe('ok');

    const request = env.requests[0];
    expect(request?.url).toBe(`${ORIGIN}${GLANCE_PATH}`);
    expect(request?.method).toBe('GET');
    expect(request?.headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(request?.init.credentials).toBe('omit');
    expect(request?.init.redirect).toBe('error');
    expect(request?.init.cache).toBe('no-store');
    expect(request?.init.referrerPolicy).toBe('no-referrer');
  });

  it('never sends the credential when the configured address differs from the paired one', async () => {
    const env = testEnv();
    env.respond(() => jsonResponse(200, sampleGlance()));
    expect(await fetchGlance(env, 'https://moved.example.test', pairing)).toEqual({ kind: 'origin_mismatch' });
    expect(await fetchGlance(env, null, pairing)).toEqual({ kind: 'origin_mismatch' });
    // A near-miss is still a different origin.
    expect(await fetchGlance(env, `${ORIGIN}:8443`, pairing)).toEqual({ kind: 'origin_mismatch' });
    expect(await fetchGlance(env, `${ORIGIN}/`, pairing)).toEqual({ kind: 'origin_mismatch' });
    expect(await fetchGlance(env, ORIGIN.replace('https', 'http'), pairing)).toEqual({ kind: 'origin_mismatch' });
    expect(env.requests).toHaveLength(0);
  });

  it('refuses to build a request from a stored origin that is no longer well formed', async () => {
    const env = testEnv();
    const broken = { ...pairing, origin: 'https://financialos.example.test/app' };
    expect(await fetchGlance(env, broken.origin, broken)).toEqual({ kind: 'origin_mismatch' });
    expect(env.requests).toHaveLength(0);
  });

  it('classifies the answers the server can give', async () => {
    const cases: Array<[number, string]> = [
      [401, 'unauthorized'],
      [403, 'refused'],
      [404, 'unavailable'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ];
    for (const [status, kind] of cases) {
      const env = testEnv();
      env.respond(() => jsonResponse(status, { error: 'nope' }));
      expect((await fetchGlance(env, ORIGIN, pairing)).kind).toBe(kind);
    }
  });

  it('reports an unreachable server rather than inventing data', async () => {
    const env = testEnv();
    env.respond(UNREACHABLE);
    expect(await fetchGlance(env, ORIGIN, pairing)).toEqual({ kind: 'unreachable' });
  });

  it('refuses a response that does not match the contract', async () => {
    for (const body of [{ nope: true }, { ...sampleGlance(), spending: null }, '<html>hi</html>']) {
      const env = testEnv();
      env.respond(() => jsonResponse(200, body));
      expect((await fetchGlance(env, ORIGIN, pairing)).kind).toBe('invalid');
    }
  });

  it('refuses a 200 that is not JSON, whatever the body says', async () => {
    const env = testEnv();
    env.respond(
      () => new Response(JSON.stringify(sampleGlance()), { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect((await fetchGlance(env, ORIGIN, pairing)).kind).toBe('invalid');
  });

  it('keeps amounts null when the device is masked, and returns them when it is not', async () => {
    const masked = testEnv();
    masked.respond(() => jsonResponse(200, sampleGlance()));
    const first = await fetchGlance(masked, ORIGIN, pairing);
    expect(first.kind === 'ok' && first.data.spending.safeToSpend).toBeNull();
    expect(first.kind === 'ok' && first.data.privacy.masked).toBe(true);

    const revealed = testEnv();
    revealed.respond(() => jsonResponse(200, sampleGlance({ revealedFields: ['safe_to_spend', 'goal_amounts'] })));
    const second = await fetchGlance(revealed, ORIGIN, pairing);
    expect(second.kind === 'ok' && second.data.spending.safeToSpend).toEqual({ amount: '1284.50', currency: 'EUR' });
    expect(second.kind === 'ok' && second.data.spending.budgetRemaining).toBeNull();
  });
});
