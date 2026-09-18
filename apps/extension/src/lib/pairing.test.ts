import { describe, expect, it } from 'vitest';
import { challengeFor } from './encoding';
import {
  PAIRING_MAX_DURATION_MS,
  PAIRING_POLL_INTERVAL_MS,
  PairingController,
  defaultDeviceLabel,
  pairingDeadline,
  pairingReducer,
  pollPairing,
  startPairing,
  type PairingState,
  type TimerLike,
} from './pairing';
import { readPending, readSnapshot, setConfiguredOrigin, type PendingPairing } from './storage';
import { jsonResponse, testEnv, UNREACHABLE, type Responder, type TestEnv } from './testing';

const ORIGIN = 'https://financialos.example.test';
const DEVICE_ID = '2f1c8a44-9e2b-4f7d-9d0a-5c6b7e8f9a01';
const NOW = Date.parse('2026-09-18T09:00:00.000Z');

function pendingFixture(overrides: Partial<PendingPairing> = {}): PendingPairing {
  return {
    origin: ORIGIN,
    deviceLabel: 'Chrome New Tab (Test)',
    installationId: 'AAAAAAAAAAAAAAAAAAAAAA',
    verifier: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    pairingId: '9c3b1f3a-2f7d-4a11-9b6e-0f2c3d4e5a6b',
    userCode: 'K7M2-9QX4',
    codeExpiresAt: new Date(NOW + 600_000).toISOString(),
    startedAt: NOW,
    ...overrides,
  };
}

const approvedBody = (expiresAt = '2026-10-18T09:00:00.000Z') => ({
  status: 'approved',
  deviceId: DEVICE_ID,
  credential: 'device_synthetic-test-credential',
  expiresAt,
  scopes: ['glance:read'],
});

/** An env with the address already saved, and optionally a pairing draft already in session. */
async function configured(session: Record<string, unknown> = {}): Promise<TestEnv> {
  const env = testEnv({ now: NOW });
  // Saving the address clears any pairing in progress, so seed the draft afterwards.
  await setConfiguredOrigin(env, ORIGIN);
  env.session.seed(session);
  return env;
}

// -------------------------------------------------------------------------------------------
// State machine

describe('pairingReducer', () => {
  const waiting = (over: Partial<Extract<PairingState, { phase: 'waiting' }>> = {}): PairingState => ({
    phase: 'waiting',
    pending: pendingFixture(),
    paused: false,
    checks: 0,
    notice: null,
    ...over,
  });

  it('runs idle → starting → waiting → approved', () => {
    let state: PairingState = { phase: 'idle' };
    state = pairingReducer(state, { type: 'start' });
    expect(state.phase).toBe('starting');
    state = pairingReducer(state, { type: 'started', pending: pendingFixture() });
    expect(state).toMatchObject({ phase: 'waiting', checks: 0, paused: false });
    state = pairingReducer(state, { type: 'still_pending' });
    state = pairingReducer(state, { type: 'still_pending', notice: 'slow down' });
    expect(state).toMatchObject({ phase: 'waiting', checks: 2, notice: 'slow down' });
    state = pairingReducer(state, {
      type: 'approved',
      pairing: {
        origin: ORIGIN,
        deviceId: DEVICE_ID,
        credential: 'device_x',
        expiresAt: 'later',
        scopes: [],
        pairedAt: 'now',
        deviceLabel: 'L',
      },
    });
    expect(state.phase).toBe('approved');
  });

  it('is terminal: an approved pairing is not moved on by a late poll result', () => {
    const approved = pairingReducer(waiting(), {
      type: 'approved',
      pairing: {
        origin: ORIGIN,
        deviceId: DEVICE_ID,
        credential: 'device_x',
        expiresAt: 'later',
        scopes: [],
        pairedAt: 'now',
        deviceLabel: 'L',
      },
    });
    expect(pairingReducer(approved, { type: 'still_pending' })).toBe(approved);
    expect(pairingReducer(approved, { type: 'expired' })).toBe(approved);
    expect(pairingReducer(approved, { type: 'denied' })).toBe(approved);
    expect(pairingReducer(approved, { type: 'failed', message: 'x' })).toBe(approved);
  });

  it('records expiry and denial as their own terminal phases', () => {
    expect(pairingReducer(waiting(), { type: 'expired' }).phase).toBe('expired');
    expect(pairingReducer(waiting(), { type: 'denied' }).phase).toBe('denied');
    expect(pairingReducer(waiting(), { type: 'failed', message: 'nope' })).toEqual({ phase: 'error', message: 'nope' });
  });

  it('does not start a second pairing while one is already in flight', () => {
    const starting: PairingState = { phase: 'starting' };
    expect(pairingReducer(starting, { type: 'start' })).toBe(starting);
    const inFlight = waiting();
    expect(pairingReducer(inFlight, { type: 'start' })).toBe(inFlight);
  });

  it('pauses and resumes only while waiting, and cancel always returns to idle', () => {
    expect(pairingReducer(waiting(), { type: 'paused' })).toMatchObject({ paused: true });
    expect(pairingReducer(waiting({ paused: true }), { type: 'resumed' })).toMatchObject({ paused: false });
    expect(pairingReducer({ phase: 'denied' }, { type: 'paused' })).toEqual({ phase: 'denied' });
    expect(pairingReducer(waiting(), { type: 'cancel' })).toEqual({ phase: 'idle' });
    expect(pairingReducer({ phase: 'error', message: 'x' }, { type: 'cancel' })).toEqual({ phase: 'idle' });
  });
});

describe('pairingDeadline', () => {
  it('is the earlier of the code expiry and the ten-minute cap', () => {
    expect(pairingDeadline(pendingFixture({ codeExpiresAt: new Date(NOW + 120_000).toISOString() }))).toBe(
      NOW + 120_000,
    );
    expect(pairingDeadline(pendingFixture({ codeExpiresAt: new Date(NOW + 3_600_000).toISOString() }))).toBe(
      NOW + PAIRING_MAX_DURATION_MS,
    );
    expect(pairingDeadline(pendingFixture({ codeExpiresAt: 'not a date' }))).toBe(NOW + PAIRING_MAX_DURATION_MS);
  });
});

describe('defaultDeviceLabel', () => {
  it('produces a short, recognisable, sanitised name', () => {
    expect(defaultDeviceLabel('macOS')).toBe('Chrome New Tab (macOS)');
    expect(defaultDeviceLabel(undefined)).toBe('Chrome New Tab');
    expect(defaultDeviceLabel('<script>x</script>')).toBe('Chrome New Tab (scriptxscript)');
    expect(defaultDeviceLabel('   ')).toBe('Chrome New Tab');
  });
});

// -------------------------------------------------------------------------------------------
// startPairing

describe('startPairing', () => {
  it('sends the challenge, never the verifier, and keeps the verifier in session storage', async () => {
    const env = await configured();
    env.respond(() =>
      jsonResponse(200, {
        pairingId: '9c3b1f3a-2f7d-4a11-9b6e-0f2c3d4e5a6b',
        userCode: 'K7M2-9QX4',
        expiresAt: new Date(NOW + 600_000).toISOString(),
        approveUrlPath: '/settings/devices/pair',
      }),
    );
    const result = await startPairing(env, ORIGIN, 'Chrome New Tab (Test)');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const [request] = env.requests;
    expect(request?.url).toBe(`${ORIGIN}/api/ext/pair/start`);
    expect(request?.method).toBe('POST');
    const body = request?.body as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual([
      'deviceLabel',
      'extensionVersion',
      'installationId',
      'verifierChallenge',
    ]);
    expect(JSON.stringify(body)).not.toContain(result.pending.verifier);
    expect(body.verifierChallenge).toBe(await challengeFor(env, result.pending.verifier));
    expect(body.verifierChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.installationId).toMatch(/^[A-Za-z0-9_-]{22,64}$/);

    const pending = await readPending(env);
    expect(pending?.verifier).toBe(result.pending.verifier);
    expect(env.local.store.has('fos.pairingDraft')).toBe(false);
  });

  it('trims the label and refuses an empty one without making a request', async () => {
    const env = await configured();
    const result = await startPairing(env, ORIGIN, '   ');
    expect(result).toMatchObject({ ok: false });
    expect(env.requests).toHaveLength(0);
  });

  it('explains an unreachable server, a rate limit and a refused extension', async () => {
    const cases: Array<[Responder, RegExp]> = [
      [UNREACHABLE, /Could not reach FinancialOS/],
      [() => jsonResponse(429, { error: 'rate_limited' }), /Too many pairing attempts/],
      [() => jsonResponse(403, { error: 'origin_not_allowed' }), /extension ID is allowed/],
      [() => jsonResponse(200, { nope: true }), /unexpected pairing response/],
    ];
    for (const [responder, expected] of cases) {
      const env = await configured();
      env.respond(responder);
      const result = await startPairing(env, ORIGIN, 'Test');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.message).toMatch(expected);
    }
  });
});

// -------------------------------------------------------------------------------------------
// pollPairing

describe('pollPairing', () => {
  it('reports pending with the retry delay the server asked for', async () => {
    const env = await configured();
    env.respond(() => jsonResponse(200, { status: 'pending', retryAfterSeconds: 3 }));
    const result = await pollPairing(env, pendingFixture());
    expect(result).toEqual({ kind: 'pending', retryAfterMs: 3000 });
    expect(await readPending(env)).toBeNull(); // nothing was written; the draft was never seeded
  });

  it('clamps an absurd retry delay into the allowed band', async () => {
    const env = await configured();
    env.respond(() => jsonResponse(200, { status: 'pending', retryAfterSeconds: 86_400 }));
    expect(await pollPairing(env, pendingFixture())).toEqual({ kind: 'pending', retryAfterMs: 30_000 });
    env.respond(() => jsonResponse(200, { status: 'pending', retryAfterSeconds: 0 }));
    expect(await pollPairing(env, pendingFixture())).toEqual({
      kind: 'pending',
      retryAfterMs: PAIRING_POLL_INTERVAL_MS,
    });
  });

  it('stores the credential in local storage when the owner approves', async () => {
    const pending = pendingFixture();
    const env = await configured({ 'fos.pairingDraft': pending });
    env.respond(() => jsonResponse(200, approvedBody()));
    const result = await pollPairing(env, pending);
    expect(result.kind).toBe('approved');

    const snapshot = await readSnapshot(env);
    expect(snapshot.pairing).toMatchObject({
      origin: ORIGIN,
      deviceId: DEVICE_ID,
      credential: 'device_synthetic-test-credential',
      scopes: ['glance:read'],
    });
    expect(env.local.store.has('fos.pairing')).toBe(true);
    // The verifier and the draft are gone once the credential exists.
    expect(snapshot.pending).toBeNull();
    expect(JSON.stringify([...env.local.store.values()])).not.toContain(pending.verifier);
  });

  it('sends the verifier only to the origin pairing started with', async () => {
    const pending = pendingFixture();
    const env = await configured({ 'fos.pairingDraft': pending });
    env.respond(() => jsonResponse(200, { status: 'pending', retryAfterSeconds: 3 }));
    await pollPairing(env, pending);
    expect(env.requests[0]?.url).toBe(`${ORIGIN}/api/ext/pair/complete`);
    expect(env.requests[0]?.body).toEqual({
      pairingId: pending.pairingId,
      installationId: pending.installationId,
      verifier: pending.verifier,
    });
  });

  it('refuses to send the verifier after the configured address changed', async () => {
    const pending = pendingFixture();
    const env = await configured({ 'fos.pairingDraft': pending });
    await setConfiguredOrigin(env, 'https://moved.example.test');
    const result = await pollPairing(env, pending);
    expect(result).toMatchObject({ kind: 'failed' });
    expect(env.requests).toHaveLength(0);
    expect(await readPending(env)).toBeNull();
  });

  it('treats expiry, denial and a missing pairing as terminal and clears the draft', async () => {
    for (const [responder, kind] of [
      [() => jsonResponse(200, { status: 'expired' }), 'expired'],
      [() => jsonResponse(200, { status: 'denied' }), 'denied'],
      [() => jsonResponse(404, { error: 'pairing_not_found' }), 'expired'],
      [() => jsonResponse(410, { error: 'gone' }), 'expired'],
    ] as const) {
      const pending = pendingFixture();
      const env = await configured({ 'fos.pairingDraft': pending });
      env.respond(responder);
      expect((await pollPairing(env, pending)).kind).toBe(kind);
      expect(await readPending(env)).toBeNull();
    }
  });

  it('gives up on a wrong installation proof instead of retrying it blindly', async () => {
    const pending = pendingFixture();
    const env = await configured({ 'fos.pairingDraft': pending });
    env.respond(() =>
      jsonResponse(403, {
        error: 'pairing_proof_invalid',
        message: 'This pairing request belongs to another installation.',
      }),
    );
    const result = await pollPairing(env, pending);
    expect(result.kind).toBe('failed');
    // The draft holding the rejected verifier is discarded, so nothing can resend it.
    expect(await readPending(env)).toBeNull();
    expect(env.requests).toHaveLength(1);
  });

  it('keeps waiting through a rate limit or a server error, without clearing the draft', async () => {
    for (const status of [429, 500, 503]) {
      const pending = pendingFixture();
      const env = await configured({ 'fos.pairingDraft': pending });
      env.respond(() => jsonResponse(status, { error: 'busy' }));
      const result = await pollPairing(env, pending);
      expect(result).toMatchObject({ kind: 'pending', retryAfterMs: 10_000 });
      expect(await readPending(env)).not.toBeNull();
    }
  });

  it('keeps waiting when the server cannot be reached at all', async () => {
    const pending = pendingFixture();
    const env = await configured({ 'fos.pairingDraft': pending });
    env.respond(UNREACHABLE);
    expect(await pollPairing(env, pending)).toMatchObject({ kind: 'pending' });
    expect(await readPending(env)).not.toBeNull();
  });

  it('expires locally once the deadline passes, without contacting the server', async () => {
    const pending = pendingFixture();
    const env = await configured({ 'fos.pairingDraft': pending });
    env.advance(PAIRING_MAX_DURATION_MS + 1000);
    expect(await pollPairing(env, pending)).toEqual({ kind: 'expired' });
    expect(env.requests).toHaveLength(0);
  });

  it('refuses a response that does not match the contract', async () => {
    const pending = pendingFixture();
    const env = await configured({ 'fos.pairingDraft': pending });
    env.respond(() => jsonResponse(200, { status: 'approved', credential: 'device_x' }));
    expect((await pollPairing(env, pending)).kind).toBe('failed');
    expect((await readSnapshot(env)).pairing).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------
// Controller

/** Lets every pending promise, including the mocked fetch round trip, run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function manualTimers() {
  let seq = 0;
  const queue = new Map<number, () => void>();
  const timers: TimerLike = {
    set(callback) {
      const handle = ++seq;
      queue.set(handle, callback);
      return handle;
    },
    clear(handle) {
      queue.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => queue.size,
    async fire(): Promise<boolean> {
      const entry = [...queue.entries()][0];
      if (!entry) return false;
      queue.delete(entry[0]);
      entry[1]();
      await settle();
      return true;
    },
  };
}

describe('PairingController', () => {
  it('polls until approval, then stops', async () => {
    const env = await configured();
    const clock = manualTimers();
    const states: PairingState[] = [];
    const controller = new PairingController(env, (state) => states.push(state), clock.timers);

    let polls = 0;
    env.respond((request) => {
      if (request.url.endsWith('/pair/start')) {
        return jsonResponse(200, {
          pairingId: '9c3b1f3a-2f7d-4a11-9b6e-0f2c3d4e5a6b',
          userCode: 'K7M2-9QX4',
          expiresAt: new Date(NOW + 600_000).toISOString(),
          approveUrlPath: '/settings/devices/pair',
        });
      }
      polls += 1;
      return polls < 3
        ? jsonResponse(200, { status: 'pending', retryAfterSeconds: 3 })
        : jsonResponse(200, approvedBody());
    });

    await controller.start(ORIGIN, 'Chrome New Tab (Test)');
    expect(controller.state.phase).toBe('waiting');
    for (let i = 0; i < 10 && controller.state.phase === 'waiting'; i += 1) await clock.fire();
    expect(controller.state.phase).toBe('approved');
    expect(polls).toBe(3);
    expect(clock.pending()).toBe(0);
    expect((await readSnapshot(env)).pairing?.credential).toBe('device_synthetic-test-credential');
    expect(states.map((s) => s.phase)).toEqual(['starting', 'waiting', 'waiting', 'waiting', 'approved']);
  });

  it('stops polling while the page is hidden and resumes when it comes back', async () => {
    const env = await configured();
    const clock = manualTimers();
    const controller = new PairingController(env, () => {}, clock.timers);
    env.respond((request) =>
      request.url.endsWith('/pair/start')
        ? jsonResponse(200, {
            pairingId: '9c3b1f3a-2f7d-4a11-9b6e-0f2c3d4e5a6b',
            userCode: 'K7M2-9QX4',
            expiresAt: new Date(NOW + 600_000).toISOString(),
            approveUrlPath: '/settings/devices/pair',
          })
        : jsonResponse(200, { status: 'pending', retryAfterSeconds: 3 }),
    );
    await controller.start(ORIGIN, 'Test');
    const afterStart = env.requests.length;
    controller.setHidden(true);
    expect(clock.pending()).toBe(0);
    expect(controller.state).toMatchObject({ phase: 'waiting', paused: true });
    expect(env.requests.length).toBe(afterStart);
    controller.setHidden(false);
    expect(controller.state).toMatchObject({ paused: false });
    await clock.fire();
    await settle();
    expect(env.requests.length).toBeGreaterThan(afterStart);
    controller.dispose();
  });

  it('cancelling clears the draft and schedules nothing more', async () => {
    const env = await configured();
    const clock = manualTimers();
    const controller = new PairingController(env, () => {}, clock.timers);
    env.respond((request) =>
      request.url.endsWith('/pair/start')
        ? jsonResponse(200, {
            pairingId: '9c3b1f3a-2f7d-4a11-9b6e-0f2c3d4e5a6b',
            userCode: 'K7M2-9QX4',
            expiresAt: new Date(NOW + 600_000).toISOString(),
            approveUrlPath: '/settings/devices/pair',
          })
        : jsonResponse(200, { status: 'pending', retryAfterSeconds: 3 }),
    );
    await controller.start(ORIGIN, 'Test');
    await controller.cancel();
    expect(controller.state).toEqual({ phase: 'idle' });
    expect(await readPending(env)).toBeNull();
    expect(clock.pending()).toBe(0);
  });
});
