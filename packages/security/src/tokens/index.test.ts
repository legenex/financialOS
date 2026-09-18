import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_PREFIXES,
  UNAMBIGUOUS_ALPHABET,
  credentialKindOf,
  generateGroupedCode,
  generatePrefixedCredential,
  generateRecoveryCode,
  generateUserCode,
  hmacSha256,
  hmacSha256Base64Url,
  isPrefixedCredential,
  normalizeGroupedCode,
  normalizeRecoveryCode,
  normalizeUserCode,
  randomFromAlphabet,
  randomToken,
  sha256,
  sha256Base64Url,
  sha256Hex,
  timingSafeEqualHex,
  timingSafeEqualString,
} from './index';

describe('randomToken', () => {
  it('produces base64url of the requested size and never repeats', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const many = new Set(Array.from({ length: 200 }, () => randomToken(32)));
    expect(many.size).toBe(200);
  });

  it('refuses sizes that would be too weak or absurd', () => {
    for (const bytes of [0, 15, -1, 1.5, 1025, Number.NaN]) {
      expect(() => randomToken(bytes), String(bytes)).toThrow(RangeError);
    }
  });
});

describe('hashes', () => {
  it('matches the documented SHA-256 test vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('abc')).toHaveLength(32);
    expect(sha256Base64Url('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });

  it('computes RFC 4231 HMAC-SHA-256 test case 1', () => {
    const key = Buffer.alloc(20, 0x0b);
    expect(hmacSha256(key, 'Hi There').toString('hex')).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    expect(hmacSha256Base64Url(key, 'Hi There')).toBe(hmacSha256(key, 'Hi There').toString('base64url'));
  });
});

describe('constant-time comparison', () => {
  it('compares equal and unequal values correctly', () => {
    expect(timingSafeEqualString('abcdef', 'abcdef')).toBe(true);
    expect(timingSafeEqualString('abcdef', 'abcdeg')).toBe(false);
    expect(timingSafeEqualString('abcdef', 'abcde')).toBe(false);
    expect(timingSafeEqualString('', '')).toBe(true);
    expect(timingSafeEqualString('a', '')).toBe(false);
  });

  it('never throws on different lengths (the usual timing-safe pitfall)', () => {
    expect(() => timingSafeEqualString('a', 'a'.repeat(5000))).not.toThrow();
    expect(timingSafeEqualString('a', 'a'.repeat(5000))).toBe(false);
  });

  it('compares hex digests case-insensitively and refuses non-hex', () => {
    const digest = sha256Hex('x');
    expect(timingSafeEqualHex(digest, digest.toUpperCase())).toBe(true);
    expect(timingSafeEqualHex(digest, sha256Hex('y'))).toBe(false);
    expect(timingSafeEqualHex(digest, `${digest}00`)).toBe(false);
    expect(timingSafeEqualHex('zz', 'zz')).toBe(false);
    expect(timingSafeEqualHex(digest, '')).toBe(false);
  });
});

describe('user-facing codes', () => {
  it('uses an alphabet without look-alike characters', () => {
    for (const ch of ['0', 'O', '1', 'I', 'L', 'U']) {
      expect(UNAMBIGUOUS_ALPHABET.includes(ch), ch).toBe(false);
    }
    expect(new Set(UNAMBIGUOUS_ALPHABET).size).toBe(UNAMBIGUOUS_ALPHABET.length);
    expect(UNAMBIGUOUS_ALPHABET).toMatch(/^[A-Z2-9]+$/);
  });

  it('draws only from the alphabet', () => {
    const sample = randomFromAlphabet(200);
    for (const ch of sample) expect(UNAMBIGUOUS_ALPHABET.includes(ch), ch).toBe(true);
    expect(randomFromAlphabet(8, 'AB')).toMatch(/^[AB]{8}$/);
    expect(() => randomFromAlphabet(0)).toThrow(RangeError);
    expect(() => randomFromAlphabet(8, 'A')).toThrow(RangeError);
  });

  it('formats pairing codes as XXXX-XXXX and normalises user input', () => {
    const code = generateUserCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normalizeUserCode(code)).toBe(code);
    expect(normalizeUserCode(code.toLowerCase())).toBe(code);
    expect(normalizeUserCode(code.replace('-', ' '))).toBe(code);
    expect(normalizeUserCode(` ${code.replace('-', '')} `)).toBe(code);
    for (const bad of ['', 'ABC', 'ABCD-EFG', 'ABCD-EFGH-JKMN', 'ABC0-EFGH', 'ABCI-EFGH', '!!!!-????']) {
      expect(normalizeUserCode(bad), bad).toBeNull();
    }
  });

  it('formats recovery codes as four groups of four', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect(normalizeRecoveryCode(code)).toBe(code);
    expect(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, ''))).toBe(code);
    expect(normalizeRecoveryCode(generateUserCode())).toBeNull();
    expect(normalizeRecoveryCode('')).toBeNull();
  });

  it('refuses absurdly long grouped input', () => {
    expect(normalizeGroupedCode('A'.repeat(200), 4)).toBeNull();
  });

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(500);
    expect(generateGroupedCode(3, 4)).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){2}$/);
  });
});

describe('prefixed credentials', () => {
  it('carries a recognisable prefix and 256 random bits', () => {
    const device = generatePrefixedCredential('device');
    const agent = generatePrefixedCredential('agent');
    expect(device.startsWith(CREDENTIAL_PREFIXES.device)).toBe(true);
    expect(agent.startsWith(CREDENTIAL_PREFIXES.agent)).toBe(true);
    expect(device.slice(CREDENTIAL_PREFIXES.device.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('recognises only the exact shape of each kind', () => {
    const device = generatePrefixedCredential('device');
    expect(isPrefixedCredential(device, 'device')).toBe(true);
    expect(isPrefixedCredential(device, 'agent')).toBe(false);
    expect(credentialKindOf(device)).toBe('device');
    expect(credentialKindOf(generatePrefixedCredential('agent'))).toBe('agent');

    for (const bad of ['', 'fos_dev_', `fos_dev_${'A'.repeat(42)}`, `fos_dev_${'A'.repeat(44)}`, `fos_dev_${'!'.repeat(43)}`, `xfos_dev_${'A'.repeat(43)}`]) {
      expect(isPrefixedCredential(bad, 'device'), bad).toBe(false);
      expect(credentialKindOf(bad), bad).toBeNull();
    }
  });
});
