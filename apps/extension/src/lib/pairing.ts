import type { PairStartInput } from '@financialos/contracts';
import type { ExtEnv } from './env';
import { challengeFor, randomToken } from './encoding';
import { loadSchemas } from './glance-client';
import { requestJson, type HttpOutcome } from './http';
import { urlOnOrigin } from './origin';
import {
  clearPending,
  readConfig,
  savePairing,
  writePending,
  type PendingPairing,
  type StoredPairing,
} from './storage';

export const PAIR_START_PATH = '/api/ext/pair/start';
export const PAIR_COMPLETE_PATH = '/api/ext/pair/complete';
export const PAIR_APPROVE_PAGE_PATH = '/settings/devices/pair';
export const PAIRING_POLL_INTERVAL_MS = 3_000;
export const PAIRING_MAX_POLL_INTERVAL_MS = 30_000;
export const PAIRING_MAX_DURATION_MS = 10 * 60_000;
export const PAIRING_REQUEST_TIMEOUT_MS = 10_000;
export const DEVICE_LABEL_MAX = 60;

// ---------------------------------------------------------------------------------------------
// State machine (pure)

export type PairingState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; pending: PendingPairing; paused: boolean; checks: number; notice: string | null }
  | { phase: 'approved'; pairing: StoredPairing }
  | { phase: 'expired' }
  | { phase: 'denied' }
  | { phase: 'error'; message: string };

export type PairingEvent =
  | { type: 'start' }
  | { type: 'started'; pending: PendingPairing }
  | { type: 'still_pending'; notice?: string | null }
  | { type: 'approved'; pairing: StoredPairing }
  | { type: 'expired' }
  | { type: 'denied' }
  | { type: 'failed'; message: string }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'cancel' };

export function pairingReducer(state: PairingState, event: PairingEvent): PairingState {
  switch (event.type) {
    case 'cancel':
      return { phase: 'idle' };
    case 'start':
      return state.phase === 'starting' || state.phase === 'waiting' ? state : { phase: 'starting' };
    case 'started':
      return state.phase === 'starting' || state.phase === 'idle'
        ? { phase: 'waiting', pending: event.pending, paused: false, checks: 0, notice: null }
        : state;
    case 'failed':
      return state.phase === 'starting' || state.phase === 'waiting'
        ? { phase: 'error', message: event.message }
        : state;
    default:
      break;
  }
  if (state.phase !== 'waiting') return state;
  switch (event.type) {
    case 'still_pending':
      return { ...state, checks: state.checks + 1, notice: event.notice ?? null };
    case 'approved':
      return { phase: 'approved', pairing: event.pairing };
    case 'expired':
      return { phase: 'expired' };
    case 'denied':
      return { phase: 'denied' };
    case 'paused':
      return { ...state, paused: true };
    case 'resumed':
      return { ...state, paused: false };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// Network steps

export type StartResult = { ok: true; pending: PendingPairing } | { ok: false; message: string };

function describeFailure(origin: string, outcome: HttpOutcome, action: string): string {
  if (outcome.kind === 'network')
    return `Could not reach FinancialOS at ${origin}. Check the address and that FinancialOS is running.`;
  if (outcome.kind === 'timeout') return `FinancialOS at ${origin} did not answer in time. Try again in a moment.`;
  if (outcome.status === 429) return 'Too many pairing attempts. Wait a minute, then try again.';
  if (outcome.status === 403)
    return 'FinancialOS refused this extension. Check that its extension ID is allowed on your FinancialOS server.';
  return `FinancialOS could not ${action} (HTTP ${outcome.status}).`;
}

export function defaultDeviceLabel(platform: string | undefined): string {
  const clean = (platform ?? '')
    .replace(/[^\w .-]/g, '')
    .trim()
    .slice(0, 24);
  return clean ? `Chrome New Tab (${clean})` : 'Chrome New Tab';
}

export async function startPairing(env: ExtEnv, origin: string, deviceLabel: string): Promise<StartResult> {
  const label = deviceLabel.trim().slice(0, DEVICE_LABEL_MAX);
  if (!label) return { ok: false, message: 'Give this browser a short name so you can recognise it in FinancialOS.' };
  const installationId = randomToken(env);
  const verifier = randomToken(env);
  const body: PairStartInput = {
    installationId,
    verifierChallenge: await challengeFor(env, verifier),
    deviceLabel: label,
    extensionVersion: env.extensionVersion.slice(0, 20),
  };
  const outcome = await requestJson(env, urlOnOrigin(origin, PAIR_START_PATH), {
    method: 'POST',
    body,
    timeoutMs: PAIRING_REQUEST_TIMEOUT_MS,
  });
  if (outcome.kind !== 'response' || outcome.status !== 200)
    return { ok: false, message: describeFailure(origin, outcome, 'start pairing') };
  const { PairStartResult } = await loadSchemas();
  const parsed = PairStartResult.safeParse(outcome.body);
  if (!parsed.success)
    return {
      ok: false,
      message:
        'FinancialOS sent an unexpected pairing response. Check that the extension and FinancialOS versions match.',
    };
  const pending: PendingPairing = {
    origin,
    deviceLabel: label,
    installationId,
    verifier,
    pairingId: parsed.data.pairingId,
    userCode: parsed.data.userCode,
    codeExpiresAt: parsed.data.expiresAt,
    startedAt: env.now(),
  };
  await writePending(env, pending);
  return { ok: true, pending };
}

export type PollResult =
  | { kind: 'pending'; retryAfterMs: number; notice?: string }
  | { kind: 'approved'; pairing: StoredPairing }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'failed'; message: string };

export function pairingDeadline(pending: PendingPairing): number {
  const codeExpiry = Date.parse(pending.codeExpiresAt);
  const cap = pending.startedAt + PAIRING_MAX_DURATION_MS;
  return Number.isFinite(codeExpiry) ? Math.min(codeExpiry, cap) : cap;
}

const clampInterval = (ms: number) => Math.min(PAIRING_MAX_POLL_INTERVAL_MS, Math.max(PAIRING_POLL_INTERVAL_MS, ms));

/** One pair/complete check. The verifier is only ever sent to the origin pairing started with. */
export async function pollPairing(env: ExtEnv, pending: PendingPairing): Promise<PollResult> {
  if (env.now() >= pairingDeadline(pending)) {
    await clearPending(env);
    return { kind: 'expired' };
  }
  const config = await readConfig(env);
  if (!config || config.origin !== pending.origin) {
    await clearPending(env);
    return { kind: 'failed', message: 'The FinancialOS address changed while pairing. Start pairing again.' };
  }
  const outcome = await requestJson(env, urlOnOrigin(pending.origin, PAIR_COMPLETE_PATH), {
    method: 'POST',
    body: { pairingId: pending.pairingId, installationId: pending.installationId, verifier: pending.verifier },
    timeoutMs: PAIRING_REQUEST_TIMEOUT_MS,
  });
  if (outcome.kind !== 'response') {
    return {
      kind: 'pending',
      retryAfterMs: 2 * PAIRING_POLL_INTERVAL_MS,
      notice: 'FinancialOS is not answering right now. Still trying…',
    };
  }
  const { status } = outcome;
  if (status === 404 || status === 410) {
    await clearPending(env);
    return { kind: 'expired' };
  }
  if (status === 429 || status >= 500) {
    return { kind: 'pending', retryAfterMs: 10_000, notice: 'FinancialOS asked us to slow down. Still waiting…' };
  }
  if (status !== 200) {
    await clearPending(env);
    return { kind: 'failed', message: describeFailure(pending.origin, outcome, 'complete pairing') };
  }
  const { PairCompleteResult } = await loadSchemas();
  const parsed = PairCompleteResult.safeParse(outcome.body);
  if (!parsed.success) {
    await clearPending(env);
    return { kind: 'failed', message: 'FinancialOS sent an unexpected pairing response. Start pairing again.' };
  }
  const result = parsed.data;
  switch (result.status) {
    case 'pending':
      return { kind: 'pending', retryAfterMs: clampInterval(result.retryAfterSeconds * 1000) };
    case 'expired':
      await clearPending(env);
      return { kind: 'expired' };
    case 'denied':
      await clearPending(env);
      return { kind: 'denied' };
    case 'approved': {
      const latest = await readConfig(env);
      if (!latest || latest.origin !== pending.origin) {
        await clearPending(env);
        return { kind: 'failed', message: 'The FinancialOS address changed while pairing. Start pairing again.' };
      }
      const pairing: StoredPairing = {
        origin: pending.origin,
        deviceId: result.deviceId,
        credential: result.credential,
        expiresAt: result.expiresAt,
        scopes: result.scopes,
        pairedAt: new Date(env.now()).toISOString(),
        deviceLabel: pending.deviceLabel,
      };
      await savePairing(env, pairing);
      return { kind: 'approved', pairing };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Driver: polls every few seconds while the page is visible, for at most ten minutes.

export interface TimerLike {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const browserTimers: TimerLike = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PairingController {
  private current: PairingState = { phase: 'idle' };
  private timer: unknown = null;
  private hidden = false;
  private inFlight = false;
  private generation = 0;

  constructor(
    private readonly env: ExtEnv,
    private readonly onChange: (state: PairingState) => void,
    private readonly timers: TimerLike = browserTimers,
  ) {}

  get state(): PairingState {
    return this.current;
  }

  private dispatch(event: PairingEvent): void {
    const next = pairingReducer(this.current, event);
    if (next !== this.current) {
      this.current = next;
      this.onChange(next);
    }
  }

  async start(origin: string, deviceLabel: string): Promise<void> {
    if (this.current.phase === 'starting' || this.current.phase === 'waiting') return;
    this.dispatch({ type: 'start' });
    const generation = ++this.generation;
    const started = await startPairing(this.env, origin, deviceLabel);
    if (generation !== this.generation) return;
    if (!started.ok) {
      this.dispatch({ type: 'failed', message: started.message });
      return;
    }
    this.dispatch({ type: 'started', pending: started.pending });
    this.schedule(PAIRING_POLL_INTERVAL_MS);
  }

  /** Continues a pairing that was started before this page was reloaded. */
  resume(pending: PendingPairing): void {
    if (this.current.phase !== 'idle') return;
    this.generation += 1;
    this.dispatch({ type: 'started', pending });
    if (this.hidden) this.dispatch({ type: 'paused' });
    else this.schedule(0);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (this.current.phase !== 'waiting') return;
    if (hidden) {
      this.clearTimer();
      this.dispatch({ type: 'paused' });
    } else {
      this.dispatch({ type: 'resumed' });
      this.schedule(0);
    }
  }

  async cancel(): Promise<void> {
    this.generation += 1;
    this.clearTimer();
    await clearPending(this.env);
    this.dispatch({ type: 'cancel' });
  }

  dispose(): void {
    this.generation += 1;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    if (this.hidden || this.current.phase !== 'waiting') return;
    const generation = this.generation;
    this.timer = this.timers.set(() => {
      this.timer = null;
      if (generation === this.generation) void this.tick(generation);
    }, ms);
  }

  private async tick(generation: number): Promise<void> {
    const state = this.current;
    if (state.phase !== 'waiting' || this.hidden || this.inFlight) return;
    this.inFlight = true;
    let result: PollResult;
    try {
      result = await pollPairing(this.env, state.pending);
    } finally {
      this.inFlight = false;
    }
    if (generation !== this.generation) return;
    switch (result.kind) {
      case 'pending':
        this.dispatch({ type: 'still_pending', notice: result.notice ?? null });
        this.schedule(result.retryAfterMs);
        return;
      case 'approved':
        this.dispatch({ type: 'approved', pairing: result.pairing });
        return;
      case 'expired':
        this.dispatch({ type: 'expired' });
        return;
      case 'denied':
        this.dispatch({ type: 'denied' });
        return;
      case 'failed':
        this.dispatch({ type: 'failed', message: result.message });
        return;
    }
  }
}
