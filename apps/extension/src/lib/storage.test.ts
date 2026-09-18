import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserEnv } from './env';
import { memoryArea, testEnv, type MemoryArea } from './testing';
import {
  LOCAL_KEYS,
  SESSION_KEYS,
  asCache,
  asPairing,
  endPairing,
  forgetEverything,
  readSnapshot,
  samePairing,
  savePairing,
  setConfiguredOrigin,
  type StoredPairing,
} from './storage';

const ORIGIN = 'https://financialos.example.test';

const pairing: StoredPairing = {
  origin: ORIGIN,
  deviceId: '2f1c8a44-9e2b-4f7d-9d0a-5c6b7e8f9a01',
  credential: 'device_synthetic-test-credential',
  expiresAt: '2026-10-18T09:00:00.000Z',
  scopes: ['glance:read'],
  pairedAt: '2026-09-18T09:00:00.000Z',
  deviceLabel: 'Chrome New Tab (Test)',
};

describe('storage areas', () => {
  it('keeps the credential in local storage and the cache in session storage', async () => {
    const env = testEnv();
    await setConfiguredOrigin(env, ORIGIN);
    await savePairing(env, pairing);
    expect(env.local.keys()).toEqual([LOCAL_KEYS.config, LOCAL_KEYS.pairing].sort());
    expect(env.local.store.get(LOCAL_KEYS.pairing)).toMatchObject({ credential: pairing.credential });
    expect(env.session.keys()).toEqual([]);
  });

  it('reads back a full snapshot', async () => {
    const env = testEnv();
    await setConfiguredOrigin(env, ORIGIN);
    await savePairing(env, pairing);
    const snapshot = await readSnapshot(env);
    expect(snapshot.config).toEqual({ origin: ORIGIN });
    expect(snapshot.pairing).toEqual(pairing);
    expect(snapshot.cache).toBeNull();
    expect(snapshot.meta).toBeNull();
  });
});

describe('chrome.storage.sync is never touched', () => {
  let sync: MemoryArea;

  beforeEach(() => {
    sync = memoryArea();
    const chromeStub = {
      storage: { local: memoryArea(), session: memoryArea(), sync },
      permissions: { request: vi.fn(), contains: vi.fn(), remove: vi.fn() },
      runtime: { id: 'pafnoebiamkedmcabfalnpbkjilpoajo', getManifest: () => ({ version: '0.1.0' }) },
    };
    vi.stubGlobal('chrome', chromeStub);
  });

  it('writes the credential through the real browserEnv without reaching sync', async () => {
    const env = browserEnv();
    await setConfiguredOrigin(env, ORIGIN);
    await savePairing(env, pairing);
    await endPairing(env, ORIGIN, 'revoked');
    await forgetEverything(env);
    expect(sync.keys()).toEqual([]);
    expect(sync.store.size).toBe(0);
  });

  it('exposes no synced area at all on the environment interface', () => {
    const env = browserEnv();
    expect(Object.keys(env)).not.toContain('sync');
    expect((env as unknown as Record<string, unknown>).sync).toBeUndefined();
  });
});

describe('endPairing', () => {
  it('removes the credential and every cached figure, and records why', async () => {
    const env = testEnv();
    await setConfiguredOrigin(env, ORIGIN);
    await savePairing(env, pairing);
    await env.session.set({ [SESSION_KEYS.glance]: { anything: true } });
    await endPairing(env, ORIGIN, 'revoked');
    const snapshot = await readSnapshot(env);
    expect(snapshot.pairing).toBeNull();
    expect(snapshot.cache).toBeNull();
    expect(snapshot.meta).toBeNull();
    expect(snapshot.ended).toEqual({ origin: ORIGIN, reason: 'revoked', at: env.now() });
    expect(snapshot.config).toEqual({ origin: ORIGIN });
  });
});

describe('setConfiguredOrigin', () => {
  it('discards the credential, cache and pairing in progress when the address changes', async () => {
    const env = testEnv();
    await setConfiguredOrigin(env, ORIGIN);
    await savePairing(env, pairing);
    await env.session.set({ [SESSION_KEYS.pending]: { origin: ORIGIN } });
    await setConfiguredOrigin(env, 'https://new.example.test');
    const snapshot = await readSnapshot(env);
    expect(snapshot.config).toEqual({ origin: 'https://new.example.test' });
    expect(snapshot.pairing).toBeNull();
    expect(snapshot.pending).toBeNull();
    expect(snapshot.ended).toBeNull();
    expect(env.local.store.has(LOCAL_KEYS.pairing)).toBe(false);
  });
});

describe('forgetEverything', () => {
  it('leaves nothing behind in either area', async () => {
    const env = testEnv();
    await setConfiguredOrigin(env, ORIGIN);
    await savePairing(env, pairing);
    await env.session.set({ [SESSION_KEYS.glance]: { x: 1 }, [SESSION_KEYS.refresh]: { y: 2 } });
    await forgetEverything(env);
    expect(env.local.keys()).toEqual([]);
    expect(env.session.keys()).toEqual([]);
  });
});

describe('stored value validation', () => {
  it('rejects anything that is not the shape it expects', () => {
    expect(asPairing(null)).toBeNull();
    expect(asPairing({ ...pairing, credential: 42 })).toBeNull();
    expect(asPairing({ ...pairing, scopes: 'glance:read' })).toBeNull();
    expect(asPairing({ ...pairing, deviceLabel: undefined })).toMatchObject({ deviceLabel: '' });
    expect(asCache({ origin: ORIGIN, deviceId: 'd', fetchedAt: 1, displayUntil: 2, data: { nope: true } })).toBeNull();
  });
});

describe('samePairing', () => {
  it('is true only for the same origin, device and credential', () => {
    expect(samePairing(pairing, { ...pairing })).toBe(true);
    expect(samePairing(pairing, { ...pairing, credential: 'device_other' })).toBe(false);
    expect(samePairing(pairing, { ...pairing, origin: 'https://other.example.test' })).toBe(false);
    expect(samePairing(null, pairing)).toBe(false);
  });
});
