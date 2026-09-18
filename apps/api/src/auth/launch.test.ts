import { describe, expect, it } from 'vitest';
import { LAUNCH_TARGETS } from '@financialos/contracts';
import { isLaunchTarget, launchPath, LOGIN_PATH_FOR_LAUNCH } from './launch';

describe('launch target allowlist', () => {
  it('only ever yields an internal absolute path', () => {
    for (const key of Object.keys(LAUNCH_TARGETS)) {
      const path = launchPath(key);
      expect(path, key).toBeTruthy();
      expect(path!.startsWith('/'), key).toBe(true);
      expect(path!.startsWith('//'), key).toBe(false);
      expect(path!.startsWith('/\\'), key).toBe(false);
      expect(() => new URL(path as string)).toThrow(); // not an absolute URL
      expect(new URL(path as string, 'https://app.example.test').origin).toBe('https://app.example.test');
    }
  });

  it('refuses anything that is not an allowlisted key', () => {
    const attacks = [
      '//evil.test',
      'https://evil.test',
      'http://evil.test',
      '/../',
      '../../etc/passwd',
      '/today',
      'today/../../evil',
      '%2F%2Fevil.test',
      'javascript:alert(1)',
      '\\\\evil.test',
      'today ',
      'TODAY',
      '',
    ];
    for (const attack of attacks) {
      expect(isLaunchTarget(attack), attack).toBe(false);
      expect(launchPath(attack), attack).toBeNull();
    }
  });

  it('is not fooled by inherited Object properties', () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(isLaunchTarget(key), key).toBe(false);
      expect(launchPath(key), key).toBeNull();
    }
  });

  it('sends the browser to the login screen, never to the destination', () => {
    expect(LOGIN_PATH_FOR_LAUNCH.startsWith('/login')).toBe(true);
    expect(Object.values(LAUNCH_TARGETS).some((t) => (t.path as unknown as string) === LOGIN_PATH_FOR_LAUNCH)).toBe(false);
  });
});
