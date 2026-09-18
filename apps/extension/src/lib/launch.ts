import type { LaunchTarget } from '@financialos/contracts';
import { urlOnOrigin } from './origin';

/**
 * The launch targets the server accepts (LAUNCH_TARGETS in @financialos/contracts). Kept as a
 * typed record so the compiler rejects missing or unknown keys, and a unit test checks it against
 * the contract at runtime. The new tab does not import the contract module itself, which keeps
 * the validator out of the first paint.
 */
const ALLOWED_TARGETS: Record<LaunchTarget, true> = {
  today: true,
  plan: true,
  goals: true,
  commitments: true,
  money: true,
  coach: true,
  inbox: true,
  connections: true,
};

export const LAUNCH_TARGET_KEYS = Object.keys(ALLOWED_TARGETS) as LaunchTarget[];

export function isLaunchTarget(value: string): value is LaunchTarget {
  return Object.hasOwn(ALLOWED_TARGETS, value);
}

/**
 * `${origin}/launch/<target>`: the server records a short-lived launch request and asks for fresh
 * authentication before opening the destination. No token or code is ever put in this URL.
 */
export function launchUrl(origin: string, target: LaunchTarget): string {
  if (!isLaunchTarget(target)) throw new Error('launch target is not allowlisted');
  return urlOnOrigin(origin, `/launch/${target}`);
}
