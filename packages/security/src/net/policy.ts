import { lookup as dnsLookup } from 'node:dns/promises';
import { canonicalIp, classifyAddress, ipLiteral } from './ip';
import { SsrfBlockedError, redactUrlForError } from './errors';

/** One owner-managed `outbound_allowlist` row. Matching is exact on scheme, host, and port. */
export interface AllowlistEntry {
  scheme: 'https' | 'http';
  host: string;
  port: number;
}

export interface OutboundPolicy {
  /** Exact scheme/host/port combinations that may use http, a non-standard port, or a non-public address. */
  allowlist: readonly AllowlistEntry[];
  /** Ports allowed for https to public destinations without an allowlist entry. Default: [443]. */
  allowedHttpsPorts?: readonly number[];
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** DNS resolver seam. The default uses the system resolver with every A/AAAA record returned. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

export interface ValidatedTarget {
  url: URL;
  scheme: 'https' | 'http';
  /** Lower-case hostname without brackets or trailing dot. */
  host: string;
  port: number;
  allowlisted: boolean;
  /** The single address the connection will be pinned to. */
  pinned: ResolvedAddress;
  /** True when the URL host is itself an IP literal (no DNS lookup, no SNI). */
  literal: boolean;
}

export function normaliseHost(host: string): string {
  const lower = host.toLowerCase().replace(/\.$/, '');
  const ip = canonicalIp(lower);
  return ip ?? lower;
}

export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

export function isAllowlisted(policy: OutboundPolicy, scheme: string, host: string, port: number): boolean {
  const h = normaliseHost(host);
  return policy.allowlist.some((e) => e.scheme === scheme && normaliseHost(e.host) === h && e.port === port);
}

function isLocalName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain';
}

/**
 * Static URL checks (no DNS): scheme, userinfo, port, local names, and IP literals.
 * Returns the parsed parts; throws SsrfBlockedError when the URL can never be fetched.
 */
export function checkUrl(input: string | URL, policy: OutboundPolicy): { url: URL; scheme: 'https' | 'http'; host: string; port: number; allowlisted: boolean } {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.href);
  } catch {
    throw new SsrfBlockedError('invalid URL', null);
  }
  const redacted = redactUrlForError(url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SsrfBlockedError(`scheme ${url.protocol} is not allowed`, redacted);
  if (url.username || url.password) throw new SsrfBlockedError('credentials in URLs are not allowed', redacted);
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const bare = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const host = normaliseHost(bare);
  if (!host) throw new SsrfBlockedError('empty host', redacted);
  const port = effectivePort(url);
  const allowlisted = isAllowlisted(policy, scheme, host, port);
  if (scheme === 'http' && !allowlisted) throw new SsrfBlockedError('plain http is only allowed for allowlisted destinations', redacted);
  const httpsPorts = policy.allowedHttpsPorts ?? [443];
  if (!allowlisted && !httpsPorts.includes(port)) throw new SsrfBlockedError(`port ${port} is not allowed`, redacted);
  if (isLocalName(host) && !allowlisted) throw new SsrfBlockedError('local hostnames are not allowed', redacted);
  if (ipLiteral(host) === null && !host.includes('.') && !allowlisted) {
    throw new SsrfBlockedError('single-label hostnames are not allowed', redacted);
  }
  if (ipLiteral(host) !== null) {
    const verdict = classifyAddress(host);
    if (verdict.neverAllowed) throw new SsrfBlockedError(`address range ${verdict.reason ?? 'blocked'} is never allowed`, redacted);
    if (!verdict.public && !allowlisted) throw new SsrfBlockedError(`address range ${verdict.reason ?? 'blocked'} is not allowed`, redacted);
  }
  return { url, scheme, host, port, allowlisted };
}

/**
 * Full destination validation: static checks, DNS resolution, and a verdict on every resolved address.
 * The first address is pinned; the connection must use it so a second DNS answer cannot rebind the target.
 */
export async function validateTarget(input: string | URL, policy: OutboundPolicy, resolver: Resolver = systemResolver): Promise<ValidatedTarget> {
  const checked = checkUrl(input, policy);
  const redacted = redactUrlForError(checked.url);
  const literal = ipLiteral(checked.host);
  if (literal !== null) {
    const verdict = classifyAddress(literal);
    return { ...checked, pinned: { address: verdict.address, family: verdict.family }, literal: true };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(checked.host);
  } catch {
    throw new SsrfBlockedError('hostname could not be resolved', redacted);
  }
  if (addresses.length === 0) throw new SsrfBlockedError('hostname resolved to no addresses', redacted);
  const verdicts = addresses.map((a) => {
    try {
      return classifyAddress(a.address);
    } catch {
      return null;
    }
  });
  for (const verdict of verdicts) {
    if (verdict === null) throw new SsrfBlockedError('resolver returned an invalid address', redacted);
    if (verdict.neverAllowed) throw new SsrfBlockedError(`resolved address range ${verdict.reason ?? 'blocked'} is never allowed`, redacted);
    if (!verdict.public && !checked.allowlisted) {
      throw new SsrfBlockedError(`resolved address range ${verdict.reason ?? 'blocked'} is not allowed`, redacted);
    }
  }
  const first = verdicts[0]!;
  return { ...checked, pinned: { address: first.address, family: first.family }, literal: false };
}
