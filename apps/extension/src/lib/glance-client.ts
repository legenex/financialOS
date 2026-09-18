import type { GlanceResponse } from '@financialos/contracts';
import type { ExtEnv } from './env';
import { requestJson } from './http';
import { urlOnOrigin } from './origin';
import type { StoredPairing } from './storage';

export const GLANCE_PATH = '/api/ext/v1/glance';
export const GLANCE_TIMEOUT_MS = 5_000;

export type GlanceFetchResult =
  | { kind: 'ok'; data: GlanceResponse }
  | { kind: 'unauthorized' }
  | { kind: 'refused' }
  | { kind: 'unavailable'; status: number }
  | { kind: 'unreachable' }
  | { kind: 'invalid' }
  | { kind: 'origin_mismatch' };

export const loadSchemas = () => import('./schemas');

/**
 * Fetches the glance for the paired device. The credential is sent only when the configured
 * origin is exactly the origin the device was paired with; otherwise no request is made at all.
 */
export async function fetchGlance(
  env: ExtEnv,
  configuredOrigin: string | null,
  pairing: StoredPairing,
): Promise<GlanceFetchResult> {
  if (!configuredOrigin || configuredOrigin !== pairing.origin) return { kind: 'origin_mismatch' };
  let url: string;
  try {
    url = urlOnOrigin(pairing.origin, GLANCE_PATH);
  } catch {
    return { kind: 'origin_mismatch' };
  }
  const outcome = await requestJson(env, url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${pairing.credential}` },
    timeoutMs: GLANCE_TIMEOUT_MS,
  });
  if (outcome.kind !== 'response') return { kind: 'unreachable' };
  if (outcome.status === 401) return { kind: 'unauthorized' };
  if (outcome.status === 403) return { kind: 'refused' };
  if (outcome.status !== 200) return { kind: 'unavailable', status: outcome.status };
  const { GlanceResponse } = await loadSchemas();
  const parsed = GlanceResponse.safeParse(outcome.body);
  return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'invalid' };
}
