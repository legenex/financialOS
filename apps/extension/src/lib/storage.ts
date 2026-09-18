import type { GlanceResponse } from '@financialos/contracts';
import type { ExtEnv } from './env';

/**
 * Storage layout.
 *
 * chrome.storage.local (persists on this computer, never synced):
 *   fos.config        { origin }                       the configured FinancialOS origin
 *   fos.pairing       StoredPairing                     the device credential and its binding
 *   fos.pairingEnded  PairingEndedMarker                why the last pairing stopped working
 *
 * chrome.storage.session (memory only, cleared when the browser restarts):
 *   fos.glance        CachedGlance                      last validated glance, shown until it expires
 *   fos.refresh       RefreshMeta                       cross-tab throttle and backoff state
 *   fos.pairingDraft  PendingPairing                    in-progress pairing, including the verifier
 */
export const LOCAL_KEYS = {
  config: 'fos.config',
  pairing: 'fos.pairing',
  ended: 'fos.pairingEnded',
} as const;

export const SESSION_KEYS = {
  glance: 'fos.glance',
  refresh: 'fos.refresh',
  pending: 'fos.pairingDraft',
} as const;

export interface StoredConfig {
  origin: string;
}

export interface StoredPairing {
  origin: string;
  deviceId: string;
  credential: string;
  expiresAt: string;
  scopes: string[];
  pairedAt: string;
  deviceLabel: string;
}

export interface PairingEndedMarker {
  origin: string;
  reason: 'revoked' | 'expired';
  at: number;
}

export interface PendingPairing {
  origin: string;
  deviceLabel: string;
  installationId: string;
  verifier: string;
  pairingId: string;
  userCode: string;
  codeExpiresAt: string;
  startedAt: number;
}

export interface CachedGlance {
  origin: string;
  deviceId: string;
  fetchedAt: number;
  /** Local time after which no figure from this glance may be shown. */
  displayUntil: number;
  data: GlanceResponse;
}

export type RefreshOutcome = 'ok' | 'unreachable' | 'unavailable' | 'invalid' | 'refused' | 'unauthorized';

export interface RefreshMeta {
  origin: string;
  deviceId: string;
  lastAttemptAt: number;
  nextAllowedAt: number;
  failures: number;
  lastOutcome: RefreshOutcome | null;
  lastOutcomeAt: number;
}

export interface Snapshot {
  config: StoredConfig | null;
  pairing: StoredPairing | null;
  ended: PairingEndedMarker | null;
  pending: PendingPairing | null;
  cache: CachedGlance | null;
  meta: RefreshMeta | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function asConfig(v: unknown): StoredConfig | null {
  return isRecord(v) && isString(v.origin) ? { origin: v.origin } : null;
}

export function asPairing(v: unknown): StoredPairing | null {
  if (!isRecord(v)) return null;
  const { origin, deviceId, credential, expiresAt, scopes, pairedAt, deviceLabel } = v;
  if (![origin, deviceId, credential, expiresAt, pairedAt].every(isString)) return null;
  if (!Array.isArray(scopes) || !scopes.every(isString)) return null;
  return {
    origin: origin as string,
    deviceId: deviceId as string,
    credential: credential as string,
    expiresAt: expiresAt as string,
    scopes: [...scopes],
    pairedAt: pairedAt as string,
    deviceLabel: isString(deviceLabel) ? deviceLabel : '',
  };
}

export function asEnded(v: unknown): PairingEndedMarker | null {
  if (!isRecord(v) || !isString(v.origin) || !isFiniteNumber(v.at)) return null;
  if (v.reason !== 'revoked' && v.reason !== 'expired') return null;
  return { origin: v.origin, reason: v.reason, at: v.at };
}

export function asPending(v: unknown): PendingPairing | null {
  if (!isRecord(v)) return null;
  const strings = [
    'origin',
    'deviceLabel',
    'installationId',
    'verifier',
    'pairingId',
    'userCode',
    'codeExpiresAt',
  ] as const;
  if (!strings.every((k) => isString(v[k])) || !isFiniteNumber(v.startedAt)) return null;
  return {
    origin: v.origin as string,
    deviceLabel: v.deviceLabel as string,
    installationId: v.installationId as string,
    verifier: v.verifier as string,
    pairingId: v.pairingId as string,
    userCode: v.userCode as string,
    codeExpiresAt: v.codeExpiresAt as string,
    startedAt: v.startedAt,
  };
}

export function asCache(v: unknown): CachedGlance | null {
  if (!isRecord(v)) return null;
  if (!isString(v.origin) || !isString(v.deviceId) || !isFiniteNumber(v.fetchedAt) || !isFiniteNumber(v.displayUntil))
    return null;
  // The glance was validated against the contract before it was cached; session storage is only
  // reachable from this extension's own pages. A structural spot check guards against old formats.
  const data = v.data;
  if (!isRecord(data) || !isRecord(data.spending) || !isRecord(data.privacy) || !Array.isArray(data.goals)) return null;
  return {
    origin: v.origin,
    deviceId: v.deviceId,
    fetchedAt: v.fetchedAt,
    displayUntil: v.displayUntil,
    data: data as unknown as GlanceResponse,
  };
}

const OUTCOMES: readonly RefreshOutcome[] = ['ok', 'unreachable', 'unavailable', 'invalid', 'refused', 'unauthorized'];

export function asMeta(v: unknown): RefreshMeta | null {
  if (!isRecord(v) || !isString(v.origin) || !isString(v.deviceId)) return null;
  const numbers = ['lastAttemptAt', 'nextAllowedAt', 'failures', 'lastOutcomeAt'] as const;
  if (!numbers.every((k) => isFiniteNumber(v[k]))) return null;
  const lastOutcome = OUTCOMES.includes(v.lastOutcome as RefreshOutcome) ? (v.lastOutcome as RefreshOutcome) : null;
  return {
    origin: v.origin,
    deviceId: v.deviceId,
    lastAttemptAt: v.lastAttemptAt as number,
    nextAllowedAt: v.nextAllowedAt as number,
    failures: v.failures as number,
    lastOutcome,
    lastOutcomeAt: v.lastOutcomeAt as number,
  };
}

export async function readSnapshot(env: ExtEnv): Promise<Snapshot> {
  const [local, session] = await Promise.all([
    env.local.get([LOCAL_KEYS.config, LOCAL_KEYS.pairing, LOCAL_KEYS.ended]),
    env.session.get([SESSION_KEYS.glance, SESSION_KEYS.refresh, SESSION_KEYS.pending]),
  ]);
  return {
    config: asConfig(local[LOCAL_KEYS.config]),
    pairing: asPairing(local[LOCAL_KEYS.pairing]),
    ended: asEnded(local[LOCAL_KEYS.ended]),
    pending: asPending(session[SESSION_KEYS.pending]),
    cache: asCache(session[SESSION_KEYS.glance]),
    meta: asMeta(session[SESSION_KEYS.refresh]),
  };
}

export async function readConfig(env: ExtEnv): Promise<StoredConfig | null> {
  return asConfig((await env.local.get([LOCAL_KEYS.config]))[LOCAL_KEYS.config]);
}

export async function readPairing(env: ExtEnv): Promise<StoredPairing | null> {
  return asPairing((await env.local.get([LOCAL_KEYS.pairing]))[LOCAL_KEYS.pairing]);
}

export async function readPending(env: ExtEnv): Promise<PendingPairing | null> {
  return asPending((await env.session.get([SESSION_KEYS.pending]))[SESSION_KEYS.pending]);
}

export async function readMeta(env: ExtEnv): Promise<RefreshMeta | null> {
  return asMeta((await env.session.get([SESSION_KEYS.refresh]))[SESSION_KEYS.refresh]);
}

export const writeMeta = (env: ExtEnv, meta: RefreshMeta) => env.session.set({ [SESSION_KEYS.refresh]: meta });
export const writeCache = (env: ExtEnv, cache: CachedGlance) => env.session.set({ [SESSION_KEYS.glance]: cache });
export const writePending = (env: ExtEnv, pending: PendingPairing) =>
  env.session.set({ [SESSION_KEYS.pending]: pending });
export const clearPending = (env: ExtEnv) => env.session.remove([SESSION_KEYS.pending]);

export function samePairing(a: StoredPairing | null, b: StoredPairing | null): boolean {
  return !!a && !!b && a.origin === b.origin && a.deviceId === b.deviceId && a.credential === b.credential;
}

/** Stores a freshly approved pairing and resets everything tied to a previous one. */
export async function savePairing(env: ExtEnv, pairing: StoredPairing): Promise<void> {
  await env.session.remove([SESSION_KEYS.glance, SESSION_KEYS.refresh, SESSION_KEYS.pending]);
  await env.local.remove([LOCAL_KEYS.ended]);
  await env.local.set({ [LOCAL_KEYS.pairing]: pairing });
}

/** Drops the credential and every cached figure. Used for 401 responses and local expiry. */
export async function endPairing(env: ExtEnv, origin: string, reason: PairingEndedMarker['reason']): Promise<void> {
  await env.local.remove([LOCAL_KEYS.pairing]);
  await env.session.remove([SESSION_KEYS.glance, SESSION_KEYS.refresh]);
  const marker: PairingEndedMarker = { origin, reason, at: env.now() };
  await env.local.set({ [LOCAL_KEYS.ended]: marker });
}

/** Sets a new configured origin. Any credential, cache, or pairing in progress is discarded first. */
export async function setConfiguredOrigin(env: ExtEnv, origin: string): Promise<void> {
  await env.local.remove([LOCAL_KEYS.pairing, LOCAL_KEYS.ended]);
  await env.session.remove([SESSION_KEYS.glance, SESSION_KEYS.refresh, SESSION_KEYS.pending]);
  const config: StoredConfig = { origin };
  await env.local.set({ [LOCAL_KEYS.config]: config });
}

/** "Forget this device locally": removes everything this extension stored. */
export async function forgetEverything(env: ExtEnv): Promise<void> {
  await env.session.remove(Object.values(SESSION_KEYS));
  await env.local.remove(Object.values(LOCAL_KEYS));
}
