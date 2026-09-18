import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * Address classification for outbound requests.
 *
 * Every address a hostname resolves to is checked against these ranges. Only an exact owner-allowlisted
 * scheme/host/port combination may reach a non-public address, and a few addresses are never reachable at all.
 */

type Cidr = readonly [string, number, string];

/** IPv4 ranges that are never public destinations. */
export const BLOCKED_IPV4: readonly Cidr[] = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade-nat'], // privacy-check: allow-generic (documented CGNAT range, not a real tailnet IP)
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-protocol-assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4-relay-anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

/** IPv6 ranges that are never public destinations (embedded-IPv4 ranges are handled separately). */
export const BLOCKED_IPV6: readonly Cidr[] = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['::', 96, 'ipv4-compatible'],
  ['100::', 64, 'discard-only'],
  ['64:ff9b:1::', 48, 'nat64-local-use'],
  ['2001::', 32, 'teredo'],
  ['2001:2::', 48, 'benchmarking'],
  ['2001:10::', 28, 'orchid'],
  ['2001:20::', 28, 'orchid-v2'],
  ['2001:db8::', 32, 'documentation'],
  ['3fff::', 20, 'documentation'],
  ['5f00::', 16, 'segment-routing'],
  ['fc00::', 7, 'unique-local'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast'],
];

/** Destinations that stay blocked even when an allowlist entry names them. */
const NEVER_ALLOWED: readonly Cidr[] = [
  ['0.0.0.0', 32, 'unspecified'],
  ['169.254.169.254', 32, 'cloud-metadata'],
  ['169.254.170.2', 32, 'cloud-metadata'],
  ['255.255.255.255', 32, 'broadcast'],
  ['224.0.0.0', 4, 'multicast'],
];
const NEVER_ALLOWED_V6: readonly Cidr[] = [
  ['::', 128, 'unspecified'],
  ['fd00:ec2::254', 128, 'cloud-metadata'],
  ['ff00::', 8, 'multicast'],
];

type Parsed = ipaddr.IPv4 | ipaddr.IPv6;

const parsedV4 = BLOCKED_IPV4.map(([a, bits, label]) => ({ range: ipaddr.IPv4.parse(a), bits, label }));
const parsedV6 = BLOCKED_IPV6.map(([a, bits, label]) => ({ range: ipaddr.IPv6.parse(a), bits, label }));
const neverV4 = NEVER_ALLOWED.map(([a, bits, label]) => ({ range: ipaddr.IPv4.parse(a), bits, label }));
const neverV6 = NEVER_ALLOWED_V6.map(([a, bits, label]) => ({ range: ipaddr.IPv6.parse(a), bits, label }));

const NAT64_WKP = ipaddr.IPv6.parse('64:ff9b::');
const IPV4_MAPPED = ipaddr.IPv6.parse('::ffff:0:0');
const IPV4_TRANSLATED = ipaddr.IPv6.parse('::ffff:0:0:0');
const SIX_TO_FOUR = ipaddr.IPv6.parse('2002::');
const GLOBAL_UNICAST = ipaddr.IPv6.parse('2000::');

export interface AddressVerdict {
  /** Canonical textual form (no brackets). */
  address: string;
  family: 4 | 6;
  /** True when the address is a normal public unicast destination. */
  public: boolean;
  /** True when no allowlist entry can ever make this address reachable. */
  neverAllowed: boolean;
  /** Range label explaining why the address is not public, or null. */
  reason: string | null;
}

/** Strips IPv6 URL brackets. Returns null when the value is not an IP literal. */
export function ipLiteral(host: string): string | null {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(bare) === 0 ? null : bare;
}

/**
 * Parses an IP literal. IPv6 text is first canonicalised by the WHATWG URL serializer, which handles
 * embedded dotted-quad forms (e.g. `::127.0.0.1`) correctly; some parsers misread those as IPv4-mapped.
 */
function parseIp(literal: string): Parsed {
  if (isIP(literal) === 6) {
    const canonical = new URL(`http://[${literal}]/`).hostname.slice(1, -1);
    return ipaddr.IPv6.parse(canonical);
  }
  return ipaddr.IPv4.parse(literal);
}

function v4FromBytes(bytes: number[]): ipaddr.IPv4 {
  return new ipaddr.IPv4(bytes);
}

/** IPv4 addresses embedded in IPv6 forms that translate to IPv4 on the wire. */
function embeddedV4(addr: ipaddr.IPv6): { v4: ipaddr.IPv4; via: string } | null {
  const bytes = addr.toByteArray();
  if (addr.match(IPV4_MAPPED, 96)) return { v4: v4FromBytes(bytes.slice(12)), via: 'ipv4-mapped' };
  if (addr.match(IPV4_TRANSLATED, 96)) return { v4: v4FromBytes(bytes.slice(12)), via: 'ipv4-translated' };
  if (addr.match(NAT64_WKP, 96)) return { v4: v4FromBytes(bytes.slice(12)), via: 'nat64' };
  if (addr.match(SIX_TO_FOUR, 16)) return { v4: v4FromBytes(bytes.slice(2, 6)), via: '6to4' };
  return null;
}

function classifyV4(addr: ipaddr.IPv4): { reason: string | null; never: boolean } {
  const never = neverV4.find((r) => addr.match(r.range, r.bits));
  if (never) return { reason: never.label, never: true };
  const hit = parsedV4.find((r) => addr.match(r.range, r.bits));
  return { reason: hit ? hit.label : null, never: false };
}

/** Classifies a literal IPv4 or IPv6 address. Throws on anything that is not an IP literal. */
export function classifyAddress(input: string): AddressVerdict {
  const literal = ipLiteral(input);
  if (literal === null) throw new TypeError('Not an IP address literal');
  let parsed: Parsed;
  try {
    parsed = parseIp(literal);
  } catch {
    throw new TypeError('Not an IP address literal');
  }
  if (parsed.kind() === 'ipv4') {
    const v4 = parsed as ipaddr.IPv4;
    const { reason, never } = classifyV4(v4);
    return { address: v4.toString(), family: 4, public: reason === null, neverAllowed: never, reason };
  }
  const v6 = parsed as ipaddr.IPv6;
  const address = v6.toRFC5952String();
  const never = neverV6.find((r) => v6.match(r.range, r.bits));
  if (never) return { address, family: 6, public: false, neverAllowed: true, reason: never.label };
  const embedded = embeddedV4(v6);
  if (embedded) {
    const inner = classifyV4(embedded.v4);
    if (inner.reason !== null) {
      return { address, family: 6, public: false, neverAllowed: inner.never, reason: `${embedded.via}:${inner.reason}` };
    }
    return { address, family: 6, public: true, neverAllowed: false, reason: null };
  }
  const hit = parsedV6.find((r) => v6.match(r.range, r.bits));
  if (hit) return { address, family: 6, public: false, neverAllowed: false, reason: hit.label };
  // Only the global unicast block (2000::/3) is publicly routable.
  if (!v6.match(GLOBAL_UNICAST, 3)) return { address, family: 6, public: false, neverAllowed: false, reason: 'non-global-unicast' };
  return { address, family: 6, public: true, neverAllowed: false, reason: null };
}

/** Normalises an IP literal for allowlist comparison, or returns null for hostnames. */
export function canonicalIp(host: string): string | null {
  const literal = ipLiteral(host);
  if (literal === null) return null;
  const parsed = parseIp(literal);
  return parsed.kind() === 'ipv4' ? parsed.toString() : (parsed as ipaddr.IPv6).toRFC5952String();
}
