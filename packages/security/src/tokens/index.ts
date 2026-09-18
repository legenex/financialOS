import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** A random value encoded as base64url. 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 1024) {
    throw new RangeError('randomToken: bytes must be an integer between 16 and 1024');
  }
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string | Uint8Array): Buffer {
  return createHash('sha256').update(input).digest();
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Base64Url(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function hmacSha256Base64Url(key: string | Uint8Array, data: string | Uint8Array): string {
  return hmacSha256(key, data).toString('base64url');
}

/**
 * Constant-time string comparison. Both inputs are hashed first so that neither the
 * content nor the length of the expected value leaks through timing.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Constant-time comparison of two hex digests of equal expected length. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  return timingSafeEqualString(a.toLowerCase(), b.toLowerCase());
}

/** Crockford-like alphabet without 0/O, 1/I/L, U. Codes are easy to read aloud and type. */
export const UNAMBIGUOUS_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** Uniformly random string from an alphabet (rejection-free via crypto.randomInt). */
export function randomFromAlphabet(length: number, alphabet: string = UNAMBIGUOUS_ALPHABET): string {
  if (!Number.isInteger(length) || length < 1 || length > 256) throw new RangeError('randomFromAlphabet: bad length');
  if (alphabet.length < 2 || alphabet.length > 256) throw new RangeError('randomFromAlphabet: bad alphabet');
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** A grouped code such as `ABCD-EFGH`. */
export function generateGroupedCode(groups: number, groupLength: number, alphabet: string = UNAMBIGUOUS_ALPHABET): string {
  const parts: string[] = [];
  for (let i = 0; i < groups; i += 1) parts.push(randomFromAlphabet(groupLength, alphabet));
  return parts.join('-');
}

/** Short device pairing code `XXXX-XXXX` (about 39 bits). Always short-lived and attempt-limited. */
export function generateUserCode(): string {
  return generateGroupedCode(2, 4);
}

/**
 * Normalises user-typed codes: upper-case, strip whitespace and hyphens, then regroup.
 * Returns null when the input contains characters outside the alphabet.
 */
export function normalizeGroupedCode(input: string, groupLength: number, alphabet: string = UNAMBIGUOUS_ALPHABET): string | null {
  const compact = input.toUpperCase().replace(/[\s-]+/g, '');
  if (compact.length === 0 || compact.length % groupLength !== 0 || compact.length > 128) return null;
  for (const ch of compact) if (!alphabet.includes(ch)) return null;
  const groups: string[] = [];
  for (let i = 0; i < compact.length; i += groupLength) groups.push(compact.slice(i, i + groupLength));
  return groups.join('-');
}

export function normalizeUserCode(input: string): string | null {
  const normalized = normalizeGroupedCode(input, 4);
  return normalized !== null && normalized.length === 9 ? normalized : null;
}

/** Recovery codes: 16 characters (80 bits) in four groups, e.g. `ABCD-EFGH-JKMN-PQRS`. */
export function generateRecoveryCode(): string {
  return generateGroupedCode(4, 4);
}

export function normalizeRecoveryCode(input: string): string | null {
  const normalized = normalizeGroupedCode(input, 4);
  return normalized !== null && normalized.length === 19 ? normalized : null;
}

export const CREDENTIAL_PREFIXES = {
  device: 'fos_dev_',
  agent: 'fos_agent_',
} as const;
export type CredentialKind = keyof typeof CREDENTIAL_PREFIXES;

const CREDENTIAL_BODY = /^[A-Za-z0-9_-]{43}$/;

/** A bearer credential with a recognisable prefix (helps secret scanners) and 256 random bits. */
export function generatePrefixedCredential(kind: CredentialKind): string {
  return `${CREDENTIAL_PREFIXES[kind]}${randomToken(32)}`;
}

/** True when the value has the exact shape of a credential of this kind. Does not check validity. */
export function isPrefixedCredential(value: string, kind: CredentialKind): boolean {
  const prefix = CREDENTIAL_PREFIXES[kind];
  return value.startsWith(prefix) && CREDENTIAL_BODY.test(value.slice(prefix.length));
}

/** Which kind of prefixed credential a value looks like, if any. */
export function credentialKindOf(value: string): CredentialKind | null {
  for (const kind of Object.keys(CREDENTIAL_PREFIXES) as CredentialKind[]) {
    if (isPrefixedCredential(value, kind)) return kind;
  }
  return null;
}
