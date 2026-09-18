/** Production Content-Security-Policy and the response security-header set. */

export type CspDirectives = Record<string, readonly string[]>;

export const DEFAULT_CSP_DIRECTIVES: CspDirectives = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  // Vite inlines small built assets (including some font subsets) as data: URIs by default.
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'object-src': ["'none'"],
  'manifest-src': ["'self'"],
  'worker-src': ["'self'"],
};

const DIRECTIVE_NAME = /^[a-z-]+$/;
const SOURCE_TOKEN = /^[^\s;,]+$/;

/** Serialises CSP directives. Overrides replace a directive's source list; `null` removes it. */
export function buildCsp(overrides: Record<string, readonly string[] | null> = {}): string {
  const merged: Record<string, readonly string[]> = { ...DEFAULT_CSP_DIRECTIVES };
  for (const [name, sources] of Object.entries(overrides)) {
    if (sources === null) delete merged[name];
    else merged[name] = sources;
  }
  return Object.entries(merged)
    .map(([name, sources]) => {
      if (!DIRECTIVE_NAME.test(name)) throw new Error(`csp: invalid directive name ${name}`);
      for (const s of sources) if (!SOURCE_TOKEN.test(s)) throw new Error(`csp: invalid source in ${name}`);
      return sources.length ? `${name} ${sources.join(' ')}` : name;
    })
    .join('; ');
}

export const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'bluetooth=()',
  'midi=()',
  'display-capture=()',
  'screen-wake-lock=()',
  'browsing-topics=()',
  'accelerometer=()',
  'gyroscope=()',
  'magnetometer=()',
  'fullscreen=(self)',
].join(', ');

export const HSTS_VALUE = 'max-age=31536000';

export interface SecurityHeaderOptions {
  csp?: string;
  /** HSTS is harmless over loopback HTTP (browsers ignore it there); disable only for special cases. */
  hsts?: boolean;
}

/** Headers applied to every response. */
export function securityHeaders(options: SecurityHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': options.csp ?? buildCsp(),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    'x-frame-options': 'DENY',
    'origin-agent-cluster': '?1',
    'x-dns-prefetch-control': 'off',
    'x-permitted-cross-domain-policies': 'none',
  };
  if (options.hsts !== false) headers['strict-transport-security'] = HSTS_VALUE;
  return headers;
}

/** Headers for responses that must never be stored by browsers or intermediaries. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store',
  pragma: 'no-cache',
});
