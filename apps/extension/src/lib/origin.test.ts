import { describe, expect, it } from 'vitest';
import { hostPermissionFor, isNormalizedOrigin, normalizeOrigin, urlOnOrigin } from './origin';

const ok = (input: string) => {
  const result = normalizeOrigin(input);
  if (!result.ok) throw new Error(`expected ${input} to be accepted, got: ${result.reason}`);
  return result.origin;
};

const rejected = (input: string) => {
  const result = normalizeOrigin(input);
  expect(result.ok, `expected ${JSON.stringify(input)} to be rejected`).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.reason.length).toBeGreaterThan(10);
  return result.reason;
};

describe('normalizeOrigin', () => {
  it('accepts https addresses and normalises them to an origin', () => {
    expect(ok('https://financialos.example.test')).toBe('https://financialos.example.test');
    expect(ok('https://financialos.example.test/')).toBe('https://financialos.example.test');
    expect(ok('  https://financialos.example.test  ')).toBe('https://financialos.example.test');
    expect(ok('https://financialos.example.test:8443')).toBe('https://financialos.example.test:8443');
    expect(ok('HTTPS://FinancialOS.Example.Test')).toBe('https://financialos.example.test');
  });

  it('assumes https when no scheme is typed', () => {
    expect(ok('financialos.example.test')).toBe('https://financialos.example.test');
    expect(ok('financialos.example.test:8443')).toBe('https://financialos.example.test:8443');
  });

  it('drops the default port, as the Origin header does', () => {
    expect(ok('https://financialos.example.test:443')).toBe('https://financialos.example.test');
  });

  it('accepts plain http only for loopback, with or without a port', () => {
    expect(ok('http://localhost:3180')).toBe('http://localhost:3180');
    expect(ok('http://127.0.0.1:3180')).toBe('http://127.0.0.1:3180');
    expect(ok('http://localhost')).toBe('http://localhost');
  });

  it('refuses plain http for every other host', () => {
    expect(rejected('http://financialos.example.test')).toMatch(/https/);
    expect(rejected('http://192.168.1.10:3180')).toMatch(/https/);
    expect(rejected('http://localhost.example.test')).toMatch(/https/);
    // A host that merely starts with the loopback name is a different host.
    expect(rejected('http://127.0.0.1.example.test')).toMatch(/https/);
  });

  it('refuses paths, queries, fragments and user info', () => {
    for (const input of [
      'https://financialos.example.test/app',
      'https://financialos.example.test/#/today',
      'https://financialos.example.test?tenant=a',
      'https://financialos.example.test/?tenant=a',
      'https://user@financialos.example.test',
      'https://user:secret@financialos.example.test',
      'financialos.example.test/app',
    ]) {
      rejected(input);
    }
  });

  it('refuses other schemes and malformed input', () => {
    for (const input of [
      '',
      '   ',
      'ftp://financialos.example.test',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      'data:text/html,hi',
      'https://',
      'https://finan cialos.example.test',
      'https://financialos.example.test\\evil.example.test',
      'https://*.example.test',
      'https://financial_os.example.test/../x',
    ]) {
      rejected(input);
    }
  });

  it('refuses a wildcard host, because the value becomes a host permission pattern', () => {
    rejected('https://*');
    rejected('*://financialos.example.test');
  });

  it('accepts an IPv6 literal only in brackets', () => {
    expect(ok('https://[2001:db8::1]:8443')).toBe('https://[2001:db8::1]:8443');
    rejected('https://2001:db8::1');
  });
});

describe('isNormalizedOrigin', () => {
  it('is true only for a value normalizeOrigin would return unchanged', () => {
    expect(isNormalizedOrigin('https://financialos.example.test')).toBe(true);
    expect(isNormalizedOrigin('https://financialos.example.test/')).toBe(false);
    expect(isNormalizedOrigin('financialos.example.test')).toBe(false);
    expect(isNormalizedOrigin('http://financialos.example.test')).toBe(false);
  });
});

describe('hostPermissionFor', () => {
  it('asks for exactly one origin, never a wildcard host', () => {
    expect(hostPermissionFor('https://financialos.example.test')).toBe('https://financialos.example.test/*');
    expect(hostPermissionFor('http://localhost:3180')).toBe('http://localhost:3180/*');
  });

  it('refuses anything that is not already a normalized origin', () => {
    expect(() => hostPermissionFor('https://financialos.example.test/')).toThrow();
    expect(() => hostPermissionFor('https://*.example.test')).toThrow();
  });
});

describe('urlOnOrigin', () => {
  it('builds absolute URLs on the configured origin', () => {
    expect(urlOnOrigin('https://financialos.example.test', '/api/ext/v1/glance')).toBe(
      'https://financialos.example.test/api/ext/v1/glance',
    );
    expect(urlOnOrigin('http://localhost:3180', '/launch/today')).toBe('http://localhost:3180/launch/today');
  });

  it('refuses any path that could leave the origin', () => {
    for (const path of ['//evil.example.test/x', 'https://evil.example.test/x', 'launch/today', '']) {
      expect(() => urlOnOrigin('https://financialos.example.test', path)).toThrow();
    }
  });
});
