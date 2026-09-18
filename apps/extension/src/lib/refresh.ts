import type { GlanceResponse } from '@financialos/contracts';
import type { ExtEnv } from './env';
import { fetchGlance } from './glance-client';
import {
  endPairing,
  readMeta,
  readSnapshot,
  samePairing,
  writeCache,
  writeMeta,
  type CachedGlance,
  type RefreshMeta,
  type RefreshOutcome,
  type StoredPairing,
} from './storage';

export const REFRESH_LOCK = 'fos-glance-refresh';
/** At most one glance request per interval across all tabs. */
export const MIN_REFRESH_INTERVAL_MS = 60_000;
/** Backoff after consecutive failures: 1, 5, then 15 minutes. */
export const FAILURE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
/** A manual "Try again" still waits this long after the previous attempt. */
export const MANUAL_RETRY_FLOOR_MS = 10_000;
/** Client-side cap on how long any glance is displayed, whatever the server says. */
export const MAX_DISPLAY_MS = 30 * 60_000;
/** An attempt that has not reported back after this long is treated as abandoned. */
export const ATTEMPT_STALE_MS = 15_000;

export type RefreshDecision = 'fetched' | 'throttled' | 'busy' | 'skipped';

export interface RefreshResult {
  decision: RefreshDecision;
  outcome?: RefreshOutcome;
}

export function backoffAfter(failures: number): number {
  if (failures <= 0) return MIN_REFRESH_INTERVAL_MS;
  const index = Math.min(failures, FAILURE_BACKOFF_MS.length) - 1;
  return Math.max(MIN_REFRESH_INTERVAL_MS, FAILURE_BACKOFF_MS[index] ?? MIN_REFRESH_INTERVAL_MS);
}

/**
 * The local instant after which a glance must not be shown: the server's validUntil, and never
 * longer than the server's own validity window (or MAX_DISPLAY_MS) counted from local receipt, so
 * a skewed device clock cannot stretch it.
 */
export function displayUntilFor(data: Pick<GlanceResponse, 'generatedAt' | 'validUntil'>, receivedAt: number): number {
  const validUntil = Date.parse(data.validUntil);
  const generatedAt = Date.parse(data.generatedAt);
  if (!Number.isFinite(validUntil) || !Number.isFinite(generatedAt)) return receivedAt;
  const window = Math.min(Math.max(0, validUntil - generatedAt), MAX_DISPLAY_MS);
  return Math.min(validUntil, receivedAt + window);
}

export function isCacheUsable(
  cache: CachedGlance | null,
  pairing: StoredPairing | null,
  now: number,
): cache is CachedGlance {
  return (
    !!cache &&
    !!pairing &&
    cache.origin === pairing.origin &&
    cache.deviceId === pairing.deviceId &&
    now < cache.displayUntil
  );
}

export function metaFor(meta: RefreshMeta | null, pairing: StoredPairing): RefreshMeta | null {
  return meta && meta.origin === pairing.origin && meta.deviceId === pairing.deviceId ? meta : null;
}

async function attempt(env: ExtEnv, manual: boolean): Promise<RefreshResult> {
  const snapshot = await readSnapshot(env);
  const { config, pairing } = snapshot;
  if (!config || !pairing || config.origin !== pairing.origin) return { decision: 'skipped' };
  const now = env.now();
  if (!(Date.parse(pairing.expiresAt) > now)) {
    await endPairing(env, pairing.origin, 'expired');
    return { decision: 'skipped', outcome: 'unauthorized' };
  }
  // Re-read inside the lock: another tab may have refreshed a moment ago.
  const previous = metaFor(await readMeta(env), pairing);
  if (previous) {
    const earliest = manual ? previous.lastAttemptAt + MANUAL_RETRY_FLOOR_MS : previous.nextAllowedAt;
    if (now < earliest) return { decision: 'throttled' };
  }
  const failures = previous?.failures ?? 0;
  // Reserve the slot before the request, so other tabs back off even if this one closes mid-request.
  await writeMeta(env, {
    origin: pairing.origin,
    deviceId: pairing.deviceId,
    lastAttemptAt: now,
    nextAllowedAt: now + backoffAfter(failures),
    failures,
    lastOutcome: previous?.lastOutcome ?? null,
    lastOutcomeAt: previous?.lastOutcomeAt ?? 0,
  });

  const result = await fetchGlance(env, config.origin, pairing);
  const finishedAt = env.now();
  // Discard the result if the owner forgot the device or changed the origin meanwhile.
  const current = (await readSnapshot(env)).pairing;
  if (!samePairing(current, pairing)) return { decision: 'fetched' };

  const record = async (outcome: RefreshOutcome, nextFailures: number) => {
    await writeMeta(env, {
      origin: pairing.origin,
      deviceId: pairing.deviceId,
      lastAttemptAt: now,
      nextAllowedAt: now + backoffAfter(nextFailures),
      failures: nextFailures,
      lastOutcome: outcome,
      lastOutcomeAt: finishedAt,
    });
    return { decision: 'fetched' as const, outcome };
  };

  switch (result.kind) {
    case 'ok':
      await writeCache(env, {
        origin: pairing.origin,
        deviceId: pairing.deviceId,
        fetchedAt: finishedAt,
        displayUntil: displayUntilFor(result.data, finishedAt),
        data: result.data,
      });
      return record('ok', 0);
    case 'unauthorized':
      await endPairing(env, pairing.origin, 'revoked');
      return { decision: 'fetched', outcome: 'unauthorized' };
    case 'refused':
      return record('refused', failures + 1);
    case 'invalid':
      return record('invalid', failures + 1);
    case 'unavailable':
      return record('unavailable', failures + 1);
    case 'unreachable':
      return record('unreachable', failures + 1);
    case 'origin_mismatch':
      return { decision: 'skipped' };
  }
}

/**
 * Refreshes the cached glance at most once per interval across every open tab. Tabs that find
 * the lock held do nothing and pick up the result through storage change events.
 */
export async function refreshGlance(env: ExtEnv, options: { manual?: boolean } = {}): Promise<RefreshResult> {
  const manual = options.manual ?? false;
  if (!env.locks) return attempt(env, manual);
  return env.locks.ifAvailable(REFRESH_LOCK, (acquired) =>
    acquired ? attempt(env, manual) : Promise.resolve({ decision: 'busy' as const }),
  );
}
