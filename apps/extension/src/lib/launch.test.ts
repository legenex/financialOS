import { describe, expect, it } from 'vitest';
import { LAUNCH_TARGETS } from '@financialos/contracts';
import { isLaunchTarget, LAUNCH_TARGET_KEYS, launchUrl } from './launch';

const ORIGIN = 'https://financialos.example.test';

describe('launch targets', () => {
  it('matches the server contract exactly', () => {
    expect([...LAUNCH_TARGET_KEYS].sort()).toEqual(Object.keys(LAUNCH_TARGETS).sort());
  });

  it('accepts only the allowlisted keys', () => {
    for (const target of LAUNCH_TARGET_KEYS) expect(isLaunchTarget(target)).toBe(true);
    for (const other of ['', 'admin', 'today/', '../settings', 'toString', 'constructor', 'TODAY']) {
      expect(isLaunchTarget(other)).toBe(false);
    }
  });
});

describe('launchUrl', () => {
  it('points at /launch/<target> on the configured origin and carries no token', () => {
    for (const target of LAUNCH_TARGET_KEYS) {
      const url = launchUrl(ORIGIN, target);
      expect(url).toBe(`${ORIGIN}/launch/${target}`);
      expect(new URL(url).search).toBe('');
      expect(new URL(url).hash).toBe('');
    }
  });

  it('refuses a target outside the allowlist', () => {
    for (const bad of ['settings', '../admin', 'today?next=x', 'constructor']) {
      expect(() => launchUrl(ORIGIN, bad as never)).toThrow();
    }
  });

  it('refuses an origin that is not normalized', () => {
    expect(() => launchUrl('https://financialos.example.test/', 'today')).toThrow();
  });
});
