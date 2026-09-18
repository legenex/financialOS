import type { GlanceResponse } from '@financialos/contracts';
import { pairingDeadline } from '../lib/pairing';
import { ATTEMPT_STALE_MS, isCacheUsable, metaFor } from '../lib/refresh';
import type { RefreshOutcome, Snapshot } from '../lib/storage';

export type OfflineReason = 'unreachable' | 'unavailable' | 'invalid' | 'refused' | 'expired';

export type NewTabView =
  | { kind: 'not_configured' }
  | { kind: 'not_paired'; origin: string }
  | { kind: 'awaiting_approval'; origin: string; userCode: string; deadline: number }
  | { kind: 'pairing_ended'; origin: string; reason: 'revoked' | 'expired' }
  | { kind: 'origin_mismatch'; configuredOrigin: string; pairedOrigin: string }
  | { kind: 'loading'; origin: string }
  | { kind: 'offline'; origin: string; reason: OfflineReason; nextCheckAt: number | null }
  | {
      kind: 'connected';
      origin: string;
      glance: GlanceResponse;
      fetchedAt: number;
      displayUntil: number;
      /** Set when the most recent refresh failed but the cached glance is still valid. */
      refreshProblem: Exclude<RefreshOutcome, 'ok' | 'unauthorized'> | null;
    };

/** Derives what the new tab shows from stored state alone. Pure; `now` is injected. */
export function deriveView(snapshot: Snapshot, now: number): NewTabView {
  const { config, pairing, ended, pending, cache, meta } = snapshot;
  if (!config) return { kind: 'not_configured' };
  const origin = config.origin;

  if (pairing && pairing.origin !== origin) {
    return { kind: 'origin_mismatch', configuredOrigin: origin, pairedOrigin: pairing.origin };
  }
  if (!pairing) {
    if (pending && pending.origin === origin && now < pairingDeadline(pending)) {
      return { kind: 'awaiting_approval', origin, userCode: pending.userCode, deadline: pairingDeadline(pending) };
    }
    if (ended && ended.origin === origin) return { kind: 'pairing_ended', origin, reason: ended.reason };
    return { kind: 'not_paired', origin };
  }
  if (!(Date.parse(pairing.expiresAt) > now)) return { kind: 'pairing_ended', origin, reason: 'expired' };

  const current = metaFor(meta, pairing);
  const attemptOpen = !!current && current.lastOutcomeAt < current.lastAttemptAt;
  const attemptAbandoned = attemptOpen && now - current.lastAttemptAt > ATTEMPT_STALE_MS;

  if (isCacheUsable(cache, pairing, now)) {
    const lastFailed =
      current &&
      !attemptOpen &&
      current.lastOutcome &&
      current.lastOutcome !== 'ok' &&
      current.lastOutcome !== 'unauthorized' &&
      current.lastOutcomeAt > cache.fetchedAt
        ? current.lastOutcome
        : null;
    return {
      kind: 'connected',
      origin,
      glance: cache.data,
      fetchedAt: cache.fetchedAt,
      displayUntil: cache.displayUntil,
      refreshProblem: lastFailed,
    };
  }

  if (!current) return { kind: 'loading', origin };
  if (attemptOpen && !attemptAbandoned) return { kind: 'loading', origin };
  if (attemptAbandoned) return { kind: 'offline', origin, reason: 'unreachable', nextCheckAt: current.nextAllowedAt };
  switch (current.lastOutcome) {
    case 'unreachable':
    case 'unavailable':
    case 'invalid':
    case 'refused':
      return { kind: 'offline', origin, reason: current.lastOutcome, nextCheckAt: current.nextAllowedAt };
    case 'ok':
      // The last glance has expired and the next refresh is not due yet.
      return now < current.nextAllowedAt
        ? { kind: 'offline', origin, reason: 'expired', nextCheckAt: current.nextAllowedAt }
        : { kind: 'loading', origin };
    default:
      return { kind: 'loading', origin };
  }
}

/** The next instant at which the derived view can change without any storage event. */
export function nextViewChangeAt(snapshot: Snapshot, view: NewTabView, now: number): number | null {
  const candidates: number[] = [];
  if (view.kind === 'connected') candidates.push(view.displayUntil);
  if (view.kind === 'awaiting_approval') candidates.push(view.deadline);
  if (snapshot.pairing) candidates.push(Date.parse(snapshot.pairing.expiresAt));
  const meta = snapshot.meta;
  if (view.kind === 'loading' && meta && meta.lastOutcomeAt < meta.lastAttemptAt)
    candidates.push(meta.lastAttemptAt + ATTEMPT_STALE_MS + 1);
  const future = candidates.filter((t) => Number.isFinite(t) && t > now);
  return future.length ? Math.min(...future) : null;
}
