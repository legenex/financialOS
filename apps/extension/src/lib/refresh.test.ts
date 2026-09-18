import { describe, expect, it } from 'vitest';
import { sampleGlance } from './fixtures';
import {
  FAILURE_BACKOFF_MS,
  MANUAL_RETRY_FLOOR_MS,
  MAX_DISPLAY_MS,
  MIN_REFRESH_INTERVAL_MS,
  backoffAfter,
  displayUntilFor,
  isCacheUsable,
  metaFor,
  refreshGlance,
} from './refresh';
import { readSnapshot, savePairing, setConfiguredOrigin, type StoredPairing } from './storage';
import { jsonResponse, testEnv, UNREACHABLE, type TestEnv } from './testing';

const ORIGIN = 'https://financialos.example.test';
const NOW = Date.parse('2026-09-18T09:00:00.000Z');

const pairing: StoredPairing = {
  origin: ORIGIN,
  deviceId: '2f1c8a44-9e2b-4f7d-9d0a-5c6b7e8f9a01',
  credential: 'device_synthetic-test-credential',
  expiresAt: '2026-10-18T09:00:00.000Z',
  scopes: ['glance:read'],
  pairedAt: '2026-09-18T09:00:00.000Z',
  deviceLabel: 'Chrome New Tab (Test)',
};

async function paired(options: { now?: number } = {}): Promise<TestEnv> {
  const env = testEnv({ now: options.now ?? NOW });
  await setConfiguredOrigin(env, ORIGIN);
  await savePairing(env, pairing);
  env.respond(() => jsonResponse(200, sampleGlance({ generatedAt: new Date(env.now()).toISOString() })));
  return env;
}

describe('backoffAfter', () => {
  it('never goes below the minimum interval and climbs with consecutive failures', () => {
    expect(backoffAfter(0)).toBe(MIN_REFRESH_INTERVAL_MS);
    expect(backoffAfter(1)).toBe(FAILURE_BACKOFF_MS[0]);
    expect(backoffAfter(2)).toBe(FAILURE_BACKOFF_MS[1]);
    expect(backoffAfter(3)).toBe(FAILURE_BACKOFF_MS[2]);
    expect(backoffAfter(50)).toBe(FAILURE_BACKOFF_MS[2]);
  });
});

describe('displayUntilFor', () => {
  it('honours the server validity window measured from local receipt', () => {
    const data = { generatedAt: '2026-09-18T09:00:00.000Z', validUntil: '2026-09-18T09:10:00.000Z' };
    // A device clock that is ten minutes behind must not stretch the window.
    expect(displayUntilFor(data, Date.parse('2026-09-18T08:50:00.000Z'))).toBe(Date.parse('2026-09-18T09:00:00.000Z'));
    expect(displayUntilFor(data, Date.parse('2026-09-18T09:00:00.000Z'))).toBe(Date.parse('2026-09-18T09:10:00.000Z'));
  });

  it('caps however long the server claims the glance stays valid', () => {
    const data = { generatedAt: '2026-09-18T09:00:00.000Z', validUntil: '2027-09-18T09:00:00.000Z' };
    expect(displayUntilFor(data, NOW)).toBe(NOW + MAX_DISPLAY_MS);
  });

  it('shows nothing at all when the timestamps are unreadable', () => {
    expect(displayUntilFor({ generatedAt: 'x', validUntil: 'y' }, NOW)).toBe(NOW);
  });
});

describe('isCacheUsable', () => {
  const cache = {
    origin: ORIGIN,
    deviceId: pairing.deviceId,
    fetchedAt: NOW,
    displayUntil: NOW + 60_000,
    data: sampleGlance(),
  };

  it('is false once the display deadline has passed', () => {
    expect(isCacheUsable(cache, pairing, NOW)).toBe(true);
    expect(isCacheUsable(cache, pairing, NOW + 59_999)).toBe(true);
    expect(isCacheUsable(cache, pairing, NOW + 60_000)).toBe(false);
    expect(isCacheUsable(cache, pairing, NOW + 3_600_000)).toBe(false);
  });

  it('is false for another device or another address', () => {
    expect(isCacheUsable({ ...cache, deviceId: 'other' }, pairing, NOW)).toBe(false);
    expect(isCacheUsable({ ...cache, origin: 'https://moved.example.test' }, pairing, NOW)).toBe(false);
    expect(isCacheUsable(cache, null, NOW)).toBe(false);
    expect(isCacheUsable(null, pairing, NOW)).toBe(false);
  });
});

describe('metaFor', () => {
  it('ignores throttle state that belongs to another pairing', () => {
    const meta = {
      origin: ORIGIN,
      deviceId: pairing.deviceId,
      lastAttemptAt: 0,
      nextAllowedAt: 0,
      failures: 0,
      lastOutcome: null,
      lastOutcomeAt: 0,
    };
    expect(metaFor(meta, pairing)).toBe(meta);
    expect(metaFor({ ...meta, deviceId: 'other' }, pairing)).toBeNull();
    expect(metaFor({ ...meta, origin: 'https://moved.example.test' }, pairing)).toBeNull();
  });
});

describe('refreshGlance', () => {
  it('fetches once and caches the result in session storage', async () => {
    const env = await paired();
    expect(await refreshGlance(env)).toEqual({ decision: 'fetched', outcome: 'ok' });
    expect(env.requests).toHaveLength(1);
    const snapshot = await readSnapshot(env);
    expect(snapshot.cache?.data.spending.periodLabel).toBe('September');
    expect(snapshot.meta).toMatchObject({
      failures: 0,
      lastOutcome: 'ok',
      nextAllowedAt: NOW + MIN_REFRESH_INTERVAL_MS,
    });
    // Figures live only in session storage, which the browser drops on restart.
    expect(env.local.keys()).toEqual(['fos.config', 'fos.pairing']);
  });

  it('makes at most one request per interval, however many tabs open at once', async () => {
    const env = await paired();
    // Five new tabs racing, exactly as Chrome would open them.
    const results = await Promise.all([
      refreshGlance(env),
      refreshGlance(env),
      refreshGlance(env),
      refreshGlance(env),
      refreshGlance(env),
    ]);
    expect(env.requests).toHaveLength(1);
    expect(results.filter((r) => r.decision === 'fetched')).toHaveLength(1);
    expect(results.filter((r) => r.decision === 'busy')).toHaveLength(4);

    // Tabs opened one after another during the interval are throttled by the stored deadline.
    for (let i = 0; i < 5; i += 1) {
      env.advance(5_000);
      expect(await refreshGlance(env)).toEqual({ decision: 'throttled' });
    }
    expect(env.requests).toHaveLength(1);

    env.advance(MIN_REFRESH_INTERVAL_MS);
    expect(await refreshGlance(env)).toMatchObject({ decision: 'fetched' });
    expect(env.requests).toHaveLength(2);
  });

  it('still throttles when the browser has no Web Locks', async () => {
    const env = testEnv({ now: NOW, locks: false });
    await setConfiguredOrigin(env, ORIGIN);
    await savePairing(env, pairing);
    env.respond(() => jsonResponse(200, sampleGlance({ generatedAt: new Date(env.now()).toISOString() })));
    await refreshGlance(env);
    env.advance(1_000);
    expect(await refreshGlance(env)).toEqual({ decision: 'throttled' });
    expect(env.requests).toHaveLength(1);
  });

  it('backs off further after each consecutive failure', async () => {
    const env = await paired();
    env.respond(UNREACHABLE);
    for (const [index, expected] of FAILURE_BACKOFF_MS.entries()) {
      const at = env.now();
      expect(await refreshGlance(env)).toEqual({ decision: 'fetched', outcome: 'unreachable' });
      const meta = (await readSnapshot(env)).meta;
      expect(meta).toMatchObject({ failures: index + 1, nextAllowedAt: at + expected });
      env.advance(expected);
    }
    expect(env.requests).toHaveLength(FAILURE_BACKOFF_MS.length);

    // A success resets the backoff to the ordinary interval.
    env.respond(() => jsonResponse(200, sampleGlance({ generatedAt: new Date(env.now()).toISOString() })));
    const at = env.now();
    expect(await refreshGlance(env)).toEqual({ decision: 'fetched', outcome: 'ok' });
    expect((await readSnapshot(env)).meta).toMatchObject({ failures: 0, nextAllowedAt: at + MIN_REFRESH_INTERVAL_MS });
  });

  it('reserves the slot before the request, so a tab closing mid-flight cannot free the throttle', async () => {
    const env = await paired();
    let seen: number | undefined;
    env.respond(async () => {
      seen = (await readSnapshot(env)).meta?.nextAllowedAt;
      return jsonResponse(200, sampleGlance({ generatedAt: new Date(env.now()).toISOString() }));
    });
    await refreshGlance(env);
    expect(seen).toBe(NOW + MIN_REFRESH_INTERVAL_MS);
  });

  it('lets a manual retry through sooner, but not immediately', async () => {
    const env = await paired();
    env.respond(UNREACHABLE);
    await refreshGlance(env);
    expect(await refreshGlance(env, { manual: true })).toEqual({ decision: 'throttled' });
    env.advance(MANUAL_RETRY_FLOOR_MS);
    expect(await refreshGlance(env, { manual: true })).toMatchObject({ decision: 'fetched' });
    expect(env.requests).toHaveLength(2);
  });

  it('clears the credential on 401 and asks for re-pairing', async () => {
    const env = await paired();
    env.respond(() => jsonResponse(401, { error: 'device_unauthorized' }));
    expect(await refreshGlance(env)).toEqual({ decision: 'fetched', outcome: 'unauthorized' });
    const snapshot = await readSnapshot(env);
    expect(snapshot.pairing).toBeNull();
    expect(snapshot.cache).toBeNull();
    expect(snapshot.meta).toBeNull();
    expect(snapshot.ended).toEqual({ origin: ORIGIN, reason: 'revoked', at: env.now() });
    expect(JSON.stringify([...env.local.store.values()])).not.toContain(pairing.credential);

    // With no credential left, a further refresh makes no request at all.
    expect(await refreshGlance(env)).toEqual({ decision: 'skipped' });
    expect(env.requests).toHaveLength(1);
  });

  it('drops a locally expired credential without contacting the server', async () => {
    const env = await paired({ now: Date.parse('2026-11-01T09:00:00.000Z') });
    expect(await refreshGlance(env)).toEqual({ decision: 'skipped', outcome: 'unauthorized' });
    expect(env.requests).toHaveLength(0);
    const snapshot = await readSnapshot(env);
    expect(snapshot.pairing).toBeNull();
    expect(snapshot.ended).toMatchObject({ reason: 'expired' });
  });

  it('makes no request when the configured address no longer matches the pairing', async () => {
    const env = await paired();
    await env.local.set({ 'fos.config': { origin: 'https://moved.example.test' } });
    expect(await refreshGlance(env)).toEqual({ decision: 'skipped' });
    expect(env.requests).toHaveLength(0);
  });

  it('makes no request when nothing is configured or paired', async () => {
    const empty = testEnv({ now: NOW });
    expect(await refreshGlance(empty)).toEqual({ decision: 'skipped' });
    expect(empty.requests).toHaveLength(0);
  });

  it('discards a result that arrives after the owner forgot the device', async () => {
    const env = await paired();
    env.respond(async () => {
      await env.local.remove(['fos.pairing']);
      return jsonResponse(200, sampleGlance({ generatedAt: new Date(env.now()).toISOString() }));
    });
    expect(await refreshGlance(env)).toEqual({ decision: 'fetched' });
    expect((await readSnapshot(env)).cache).toBeNull();
  });

  it('caches nothing when the server returns a glance that does not match the contract', async () => {
    const env = await paired();
    env.respond(() => jsonResponse(200, { generatedAt: 'now', spending: 'lots' }));
    expect(await refreshGlance(env)).toEqual({ decision: 'fetched', outcome: 'invalid' });
    expect((await readSnapshot(env)).cache).toBeNull();
  });
});
