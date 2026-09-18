import { describe, expect, it } from 'vitest';
import { DEFAULT_CSP_DIRECTIVES, HSTS_VALUE, NO_STORE_HEADERS, PERMISSIONS_POLICY, buildCsp, securityHeaders } from './index';

function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...sources] = part.split(/\s+/);
        return [name as string, sources];
      }),
  );
}

describe('buildCsp', () => {
  const csp = buildCsp();
  const parsed = directives(csp);

  it('has no unsafe-inline or unsafe-eval anywhere, and least of all in script-src', () => {
    expect(parsed['script-src']).toEqual(["'self'"]);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('unsafe-hashes');
    expect(csp).not.toContain('*');
    expect(csp).not.toContain('data:script');
  });

  it('locks down framing, plugins, base URI and form targets', () => {
    expect(parsed['frame-ancestors']).toEqual(["'none'"]);
    expect(parsed['object-src']).toEqual(["'none'"]);
    expect(parsed['base-uri']).toEqual(["'none'"]);
    expect(parsed['form-action']).toEqual(["'self'"]);
    expect(parsed['default-src']).toEqual(["'self'"]);
    expect(parsed['connect-src']).toEqual(["'self'"]);
    expect(parsed['worker-src']).toEqual(["'self'"]);
  });

  it('only allows data: URLs for images', () => {
    for (const [name, sources] of Object.entries(parsed)) {
      if (name === 'img-src') continue;
      expect(sources.includes('data:'), name).toBe(false);
      expect(sources.includes('blob:'), name).toBe(false);
    }
    expect(parsed['img-src']).toEqual(["'self'", 'data:']);
  });

  it('applies overrides and removals', () => {
    expect(directives(buildCsp({ 'report-uri': ['/api/csp-report'] }))['report-uri']).toEqual(['/api/csp-report']);
    expect(directives(buildCsp({ 'manifest-src': null }))).not.toHaveProperty('manifest-src');
    expect(directives(buildCsp({ 'upgrade-insecure-requests': [] }))['upgrade-insecure-requests']).toEqual([]);
  });

  it('refuses directive names and sources that could break out of the header', () => {
    expect(() => buildCsp({ 'bad name': ["'self'"] })).toThrow(/invalid directive/);
    expect(() => buildCsp({ 'script-src': ["'self'; object-src *"] })).toThrow(/invalid source/);
    expect(() => buildCsp({ 'script-src': ['https://cdn.example.test,https://evil.test'] })).toThrow(/invalid source/);
    expect(() => buildCsp({ 'script-src': ['self with space'] })).toThrow(/invalid source/);
  });

  it('keeps the defaults immutable across calls', () => {
    buildCsp({ 'script-src': ["'unsafe-inline'"] });
    expect(DEFAULT_CSP_DIRECTIVES['script-src']).toEqual(["'self'"]);
    expect(buildCsp()).toBe(buildCsp());
  });
});

describe('securityHeaders', () => {
  const headers = securityHeaders();

  it('sets the expected protective headers', () => {
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['x-permitted-cross-domain-policies']).toBe('none');
    expect(headers['strict-transport-security']).toBe(HSTS_VALUE);
    expect(headers['content-security-policy']).toBe(buildCsp());
  });

  it('disables the sensitive browser features', () => {
    expect(headers['permissions-policy']).toBe(PERMISSIONS_POLICY);
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'display-capture', 'browsing-topics']) {
      expect(PERMISSIONS_POLICY, feature).toContain(`${feature}=()`);
    }
  });

  it('allows HSTS to be turned off and the CSP to be replaced', () => {
    expect(securityHeaders({ hsts: false })['strict-transport-security']).toBeUndefined();
    expect(securityHeaders({ csp: "default-src 'none'" })['content-security-policy']).toBe("default-src 'none'");
  });

  it('never carries a value with a newline', () => {
    for (const [name, value] of Object.entries(headers)) {
      expect(value, name).not.toMatch(/[\r\n]/);
      expect(name).toBe(name.toLowerCase());
    }
  });
});

describe('NO_STORE_HEADERS', () => {
  it('is a frozen no-store set', () => {
    expect(NO_STORE_HEADERS['cache-control']).toBe('no-store');
    expect(NO_STORE_HEADERS.pragma).toBe('no-cache');
    expect(Object.isFrozen(NO_STORE_HEADERS)).toBe(true);
  });
});
