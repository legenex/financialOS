/**
 * Validation for the FinancialOS address the owner types in.
 *
 * Accepted: https://<host>[:port], and plain http only for http://localhost[:port] or
 * http://127.0.0.1[:port] (on-host use). No user info, path, query, or fragment. Wildcards and
 * other odd host characters are rejected because the value becomes a host permission pattern.
 */

export type OriginCheck = { ok: true; origin: string } | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const HOST_LABEL = '[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?';
const DNS_HOST = new RegExp(`^(?:${HOST_LABEL}\\.)*${HOST_LABEL}$`);
const IPV6_HOST = /^\[[0-9a-f:.]+\]$/;
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

const fail = (reason: string): OriginCheck => ({ ok: false, reason });

export function normalizeOrigin(raw: string): OriginCheck {
  const input = raw.trim();
  if (!input) return fail('Enter the address you use to open FinancialOS.');
  if (/[\s\\]/.test(input)) return fail('The address cannot contain spaces or backslashes.');
  const withScheme = SCHEME_PREFIX.test(input) ? input : `https://${input}`;

  const authorityAndRest = withScheme.replace(SCHEME_PREFIX, '');
  const authority = /^[^/?#]*/.exec(authorityAndRest)?.[0] ?? '';
  const rest = authorityAndRest.slice(authority.length);
  if (authority.includes('@')) return fail('Remove the user name or password from the address.');
  if (rest.includes('?') || rest.includes('#')) return fail('Enter only the address, without “?” or “#” parts.');
  if (rest !== '' && rest !== '/') return fail('Enter only the address, without a path.');

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return fail('That does not look like a web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('Use an https:// address.');
  if (url.username || url.password) return fail('Remove the user name or password from the address.');
  if (url.pathname !== '/' || url.search || url.hash) return fail('Enter only the address, without a path.');
  const host = url.hostname;
  if (!host || !(DNS_HOST.test(host) || IPV6_HOST.test(host)))
    return fail('The host name contains characters that are not allowed.');
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(host)) {
    return fail('Use https://. Plain http:// is accepted only for localhost or 127.0.0.1 on this computer.');
  }
  return { ok: true, origin: url.origin };
}

export function isNormalizedOrigin(value: string): boolean {
  const checked = normalizeOrigin(value);
  return checked.ok && checked.origin === value;
}

/** The exact host permission requested for an origin, e.g. `https://financialos.example.test/*`. */
export function hostPermissionFor(origin: string): string {
  if (!isNormalizedOrigin(origin)) throw new Error('not a normalized origin');
  return `${origin}/*`;
}

/** Builds a URL on the configured origin and refuses anything that would leave it. */
export function urlOnOrigin(origin: string, pathname: string): string {
  if (!isNormalizedOrigin(origin)) throw new Error('not a normalized origin');
  if (!pathname.startsWith('/') || pathname.startsWith('//')) throw new Error('path must be absolute');
  const url = new URL(pathname, `${origin}/`);
  if (url.origin !== origin) throw new Error('URL left the configured origin');
  return url.href;
}
