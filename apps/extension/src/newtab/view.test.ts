import { describe, expect, it } from 'vitest';
import { sampleGlance } from '../lib/fixtures';
import { ATTEMPT_STALE_MS, MIN_REFRESH_INTERVAL_MS } from '../lib/refresh';
import type { CachedGlance, PendingPairing, RefreshMeta, Snapshot, StoredPairing } from '../lib/storage';
import { deriveView, nextViewChangeAt } from './view';

const ORIGIN = 'https://financialos.example.test';
const DEVICE_ID = '2f1c8a44-9e2b-4f7d-9d0a-5c6b7e8f9a01';
const NOW = Date.parse('2026-09-18T09:00:00.000Z');

const EMPTY: Snapshot = { config: null, pairing: null, ended: null, pending: null, cache: null, meta: null };

const pairing: StoredPairing = {
  origin: ORIGIN,
  deviceId: DEVICE_ID,
  credential: 'device_synthetic-test-credential',
  expiresAt: '2026-10-18T09:00:00.000Z',
  scopes: ['glance:read'],
  pairedAt: '2026-09-18T08:00:00.000Z',
  deviceLabel: 'Chrome New Tab (Test)',
};

const cache = (over: Partial<CachedGlance> = {}): CachedGlance => ({
  origin: ORIGIN,
  deviceId: DEVICE_ID,
  fetchedAt: NOW - 30_000,
  displayUntil: NOW + 570_000,
  data: sampleGlance(),
  ...over,
});

const meta = (over: Partial<RefreshMeta> = {}): RefreshMeta => ({
  origin: ORIGIN,
  deviceId: DEVICE_ID,
  lastAttemptAt: NOW - 30_000,
  nextAllowedAt: NOW + 30_000,
  failures: 0,
  lastOutcome: 'ok',
  lastOutcomeAt: NOW - 30_000,
  ...over,
});

const pending: PendingPairing = {
  origin: ORIGIN,
  deviceLabel: 'Chrome New Tab (Test)',
  installationId: 'AAAAAAAAAAAAAAAAAAAAAA',
  verifier: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  pairingId: '9c3b1f3a-2f7d-4a11-9b6e-0f2c3d4e5a6b',
  userCode: 'K7M2-9QX4',
  codeExpiresAt: new Date(NOW + 300_000).toISOString(),
  startedAt: NOW - 60_000,
};

const view = (snapshot: Partial<Snapshot>, now = NOW) => deriveView({ ...EMPTY, ...snapshot }, now);

describe('deriveView: setup states', () => {
  it('asks for the address when nothing is configured', () => {
    expect(view({})).toEqual({ kind: 'not_configured' });
    // Even a leftover credential cannot show anything without a configured address.
    expect(view({ pairing })).toEqual({ kind: 'not_configured' });
  });

  it('asks to pair once the address is known', () => {
    expect(view({ config: { origin: ORIGIN } })).toEqual({ kind: 'not_paired', origin: ORIGIN });
  });

  it('shows the pairing code while a pairing is in progress for this address', () => {
    expect(view({ config: { origin: ORIGIN }, pending })).toMatchObject({
      kind: 'awaiting_approval',
      userCode: 'K7M2-9QX4',
    });
    // …but not after the code has expired, and not for a different address.
    expect(view({ config: { origin: ORIGIN }, pending }, NOW + 400_000)).toMatchObject({ kind: 'not_paired' });
    expect(view({ config: { origin: 'https://other.example.test' }, pending })).toMatchObject({ kind: 'not_paired' });
  });

  it('explains a pairing that ended, and offers to pair again', () => {
    expect(view({ config: { origin: ORIGIN }, ended: { origin: ORIGIN, reason: 'revoked', at: NOW - 1000 } })).toEqual({
      kind: 'pairing_ended',
      origin: ORIGIN,
      reason: 'revoked',
    });
    expect(
      view({ config: { origin: ORIGIN }, pairing: { ...pairing, expiresAt: '2026-09-01T00:00:00.000Z' } }),
    ).toEqual({
      kind: 'pairing_ended',
      origin: ORIGIN,
      reason: 'expired',
    });
  });

  it('refuses to use a credential paired with a different address', () => {
    expect(view({ config: { origin: 'https://moved.example.test' }, pairing, cache: cache(), meta: meta() })).toEqual({
      kind: 'origin_mismatch',
      configuredOrigin: 'https://moved.example.test',
      pairedOrigin: ORIGIN,
    });
  });
});

describe('deriveView: connected and offline', () => {
  const base = { config: { origin: ORIGIN }, pairing };

  it('shows the cached glance while it is still valid', () => {
    expect(view({ ...base, cache: cache(), meta: meta() })).toMatchObject({ kind: 'connected', refreshProblem: null });
  });

  it('stops showing figures the moment the glance passes its validity', () => {
    const c = cache({ displayUntil: NOW });
    const result = view({ ...base, cache: c, meta: meta({ nextAllowedAt: NOW + MIN_REFRESH_INTERVAL_MS }) });
    expect(result.kind).toBe('offline');
    expect(result).toMatchObject({ reason: 'expired' });
    expect(JSON.stringify(result)).not.toContain('September');

    // One millisecond earlier it was still shown, so the boundary is exact.
    expect(view({ ...base, cache: c, meta: meta() }, NOW - 1).kind).toBe('connected');
  });

  it('says a refresh failed while the previous glance is still valid', () => {
    const result = view({
      ...base,
      cache: cache(),
      meta: meta({ lastOutcome: 'unreachable', lastOutcomeAt: NOW - 1_000, lastAttemptAt: NOW - 2_000 }),
    });
    expect(result).toMatchObject({ kind: 'connected', refreshProblem: 'unreachable' });
  });

  it('reports each failure reason once nothing valid is cached', () => {
    for (const reason of ['unreachable', 'unavailable', 'invalid', 'refused'] as const) {
      expect(
        view({ ...base, meta: meta({ lastOutcome: reason, lastOutcomeAt: NOW - 1_000, lastAttemptAt: NOW - 2_000 }) }),
      ).toMatchObject({
        kind: 'offline',
        reason,
      });
    }
  });

  it('shows the loading state while the first request is in flight', () => {
    expect(view({ ...base })).toMatchObject({ kind: 'loading' });
    expect(
      view({ ...base, meta: meta({ lastAttemptAt: NOW - 1_000, lastOutcomeAt: 0, lastOutcome: null }) }),
    ).toMatchObject({ kind: 'loading' });
  });

  it('treats a request that never reported back as an unreachable server', () => {
    const abandoned = meta({ lastAttemptAt: NOW - ATTEMPT_STALE_MS - 1, lastOutcomeAt: 0, lastOutcome: null });
    expect(view({ ...base, meta: abandoned })).toMatchObject({ kind: 'offline', reason: 'unreachable' });
  });

  it('goes back to loading once the next refresh is due', () => {
    expect(
      view({
        ...base,
        meta: meta({
          nextAllowedAt: NOW - 1,
          lastOutcome: 'ok',
          lastOutcomeAt: NOW - 2_000,
          lastAttemptAt: NOW - 3_000,
        }),
      }),
    ).toMatchObject({
      kind: 'loading',
    });
  });

  it('ignores a cache or throttle record left behind by another device', () => {
    expect(
      view({ ...base, cache: cache({ deviceId: 'someone-else' }), meta: meta({ deviceId: 'someone-else' }) }),
    ).toMatchObject({ kind: 'loading' });
  });
});

describe('nextViewChangeAt', () => {
  const base = { ...EMPTY, config: { origin: ORIGIN }, pairing };

  it('wakes the page when the glance expires', () => {
    const snapshot = { ...base, cache: cache(), meta: meta() };
    expect(nextViewChangeAt(snapshot, deriveView(snapshot, NOW), NOW)).toBe(NOW + 570_000);
  });

  it('wakes the page when the pairing code expires', () => {
    const snapshot = { ...EMPTY, config: { origin: ORIGIN }, pending };
    expect(nextViewChangeAt(snapshot, deriveView(snapshot, NOW), NOW)).toBe(NOW + 300_000);
  });

  it('wakes the page when an in-flight request should be considered abandoned', () => {
    const snapshot = { ...base, meta: meta({ lastAttemptAt: NOW - 1_000, lastOutcomeAt: 0, lastOutcome: null }) };
    expect(nextViewChangeAt(snapshot, deriveView(snapshot, NOW), NOW)).toBe(NOW - 1_000 + ATTEMPT_STALE_MS + 1);
  });

  it('asks for no timer when nothing can change on its own', () => {
    expect(nextViewChangeAt(EMPTY, deriveView(EMPTY, NOW), NOW)).toBeNull();
  });
});
