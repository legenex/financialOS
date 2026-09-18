import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DecryptionError, KeyringError } from './errors';
import { Keyring, generateKeyringFile, KEY_BYTES } from './keyring';

const AAD = 'connection-secret:11111111-1111-4111-8111-111111111111';
const SECRET = 'provider-api-key-EXAMPLE-not-real';

function key(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

describe('Keyring construction', () => {
  it('refuses malformed files', () => {
    expect(() => new Keyring(undefined as never)).toThrow(KeyringError);
    expect(() => new Keyring({ active: '', keys: {} })).toThrow(/active/);
    expect(() => new Keyring({ active: 'k1', keys: null as never })).toThrow(/keys/);
    expect(() => new Keyring({ active: 'k1', keys: {} })).toThrow(/not present/);
    expect(() => new Keyring({ active: 'k1', keys: { k1: 'not-base64!' } })).toThrow(/base64/);
    expect(() => new Keyring({ active: 'k1', keys: { k1: Buffer.alloc(16).toString('base64') } })).toThrow(/32 bytes/);
    expect(() => new Keyring({ active: 'k1', keys: { 'bad kid': key(), k1: key() } })).toThrow(/invalid key id/);
    expect(() => Keyring.fromJson('{ not json')).toThrow(/valid JSON/);
  });

  it('accepts a well-formed file', () => {
    const keyring = new Keyring({ active: 'k2', keys: { k1: key(), k2: key() } });
    expect(keyring.activeKid).toBe('k2');
    expect(keyring.keyIds.sort()).toEqual(['k1', 'k2']);
    expect(keyring.hasKey('k1')).toBe(true);
    expect(keyring.hasKey('k3')).toBe(false);
  });
});

describe('string and byte encryption', () => {
  const keyring = new Keyring(generateKeyringFile());

  it('round-trips text and bytes', () => {
    const payload = keyring.encryptString(SECRET, AAD);
    expect(payload).not.toContain(SECRET);
    expect(payload.split('.')).toHaveLength(5);
    expect(payload.startsWith(`fos1.${keyring.activeKid}.`)).toBe(true);
    expect(keyring.decryptString(payload, AAD)).toBe(SECRET);

    const bytes = randomBytes(1000);
    expect(keyring.decryptBytes(keyring.encryptBytes(bytes, AAD), AAD).equals(bytes)).toBe(true);
    expect(keyring.decryptString(keyring.encryptString('', AAD), AAD)).toBe('');
    const unicode = 'naïve – ünïcödé — 😀';
    expect(keyring.decryptString(keyring.encryptString(unicode, AAD), AAD)).toBe(unicode);
  });

  it('uses a fresh nonce for every encryption', () => {
    const one = keyring.encryptString(SECRET, AAD);
    const two = keyring.encryptString(SECRET, AAD);
    expect(one).not.toBe(two);
    expect(one.split('.')[2]).not.toBe(two.split('.')[2]);
  });

  it('requires associated data', () => {
    expect(() => keyring.encryptString(SECRET, '')).toThrow(/associated data/);
    expect(() => keyring.encryptString(SECRET, 'x'.repeat(513))).toThrow(/associated data/);
    expect(() => keyring.decryptBytes(keyring.encryptString(SECRET, AAD), '')).toThrow(/associated data/);
  });

  it('refuses a payload decrypted with different associated data', () => {
    const payload = keyring.encryptString(SECRET, AAD);
    expect(() => keyring.decryptString(payload, 'totp-secret')).toThrow(DecryptionError);
    expect(() => keyring.decryptString(payload, `${AAD} `)).toThrow(DecryptionError);
    expect(() => keyring.decryptString(payload, AAD.toUpperCase())).toThrow(DecryptionError);
  });

  it('detects tampering in every part of the payload', () => {
    const payload = keyring.encryptString(SECRET, AAD);
    const [version, kid, iv, ct, tag] = payload.split('.') as [string, string, string, string, string];

    const flip = (part: string) => {
      const buf = Buffer.from(part, 'base64url');
      buf[0] = (buf[0] as number) ^ 0x01;
      return buf.toString('base64url');
    };

    expect(() => keyring.decryptString([version, kid, flip(iv), ct, tag].join('.'), AAD)).toThrow(DecryptionError);
    expect(() => keyring.decryptString([version, kid, iv, flip(ct), tag].join('.'), AAD)).toThrow(DecryptionError);
    expect(() => keyring.decryptString([version, kid, iv, ct, flip(tag)].join('.'), AAD)).toThrow(DecryptionError);
    expect(() => keyring.decryptString(['fos2', kid, iv, ct, tag].join('.'), AAD)).toThrow(/format version/);
    expect(() => keyring.decryptString([version, 'other', iv, ct, tag].join('.'), AAD)).toThrow(/unknown key id/);
  });

  it('refuses malformed payloads without leaking anything', () => {
    for (const payload of ['', 'fos1', 'fos1.k1.a.b', 'fos1.k1.a.b.c.d', 'fos1.bad kid.a.b.c', 'fos1.k1.!!.b.c']) {
      expect(() => keyring.decryptString(payload, AAD), payload).toThrow(DecryptionError);
    }
    const payload = keyring.encryptString(SECRET, AAD);
    const parts = payload.split('.');
    // Short IV and short tag.
    expect(() => keyring.decryptString([parts[0], parts[1], 'AAAA', parts[3], parts[4]].join('.'), AAD)).toThrow(DecryptionError);
    expect(() => keyring.decryptString([parts[0], parts[1], parts[2], parts[3], 'AAAA'].join('.'), AAD)).toThrow(DecryptionError);
  });

  it('never puts key material or plaintext in the error message', () => {
    const payload = keyring.encryptString(SECRET, AAD);
    try {
      keyring.decryptString(payload, 'wrong-purpose');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptionError);
      expect((err as Error).message).not.toContain(SECRET);
      expect((err as Error).message).not.toContain(payload);
    }
  });
});

describe('key rotation', () => {
  it('keeps decrypting payloads written with an older key', () => {
    const first = generateKeyringFile();
    const old = new Keyring(first);
    const legacy = old.encryptString(SECRET, AAD);
    expect(old.needsRotation(legacy)).toBe(false);

    const rotatedFile = generateKeyringFile(first);
    const rotated = new Keyring(rotatedFile);
    expect(rotated.activeKid).not.toBe(old.activeKid);
    expect(rotated.keyIds).toContain(old.activeKid);

    expect(rotated.decryptString(legacy, AAD)).toBe(SECRET);
    expect(rotated.needsRotation(legacy)).toBe(true);
    expect(Keyring.keyIdOf(legacy)).toBe(old.activeKid);

    const fresh = rotated.encryptString(SECRET, AAD);
    expect(Keyring.keyIdOf(fresh)).toBe(rotated.activeKid);
    expect(rotated.needsRotation(fresh)).toBe(false);
    // The old keyring cannot read what the new key wrote.
    expect(() => old.decryptString(fresh, AAD)).toThrow(/unknown key id/);
  });

  it('generates distinct key ids and refuses to reuse one', () => {
    const first = generateKeyringFile();
    const second = generateKeyringFile(first);
    const third = generateKeyringFile(second);
    expect(new Set(Object.keys(third.keys)).size).toBe(3);
    expect(() => generateKeyringFile(third, third.active)).toThrow(/already exists/);
    expect(() => generateKeyringFile(undefined, 'bad kid')).toThrow(/invalid key id/);
  });

  it('reports null for a key id when the payload is not in this format', () => {
    expect(Keyring.keyIdOf('nonsense')).toBeNull();
    expect(Keyring.keyIdOf('fos2.k1.a.b.c')).toBeNull();
    expect(new Keyring(generateKeyringFile()).needsRotation('nonsense')).toBe(false);
  });
});

describe('Keyring.load file permissions', () => {
  let dir: string;
  let path: string;
  const originalEnv = process.env.FOS_SECRET_FILES_GROUP_READABLE;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fos-keyring-'));
    path = join(dir, 'keyring.json');
    writeFileSync(path, JSON.stringify(generateKeyringFile()));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.FOS_SECRET_FILES_GROUP_READABLE;
    else process.env.FOS_SECRET_FILES_GROUP_READABLE = originalEnv;
  });

  it('loads a 0600 file', () => {
    chmodSync(path, 0o600);
    expect(Keyring.load(path).keyIds).toHaveLength(1);
    chmodSync(path, 0o400);
    expect(Keyring.load(path).keyIds).toHaveLength(1);
  });

  it('refuses a world-readable file, whatever the group setting', () => {
    for (const mode of [0o644, 0o604, 0o666, 0o777]) {
      chmodSync(path, mode);
      expect(() => Keyring.load(path), mode.toString(8)).toThrow(KeyringError);
      expect(() => Keyring.load(path, { allowGroupReadable: true }), mode.toString(8)).toThrow(KeyringError);
    }
  });

  it('refuses a group-readable file unless group access is explicitly allowed', () => {
    chmodSync(path, 0o640);
    expect(() => Keyring.load(path)).toThrow(/too open/);
    expect(() => Keyring.load(path, { allowGroupReadable: false })).toThrow(/too open/);
    expect(Keyring.load(path, { allowGroupReadable: true }).keyIds).toHaveLength(1);
  });

  it('honours FOS_SECRET_FILES_GROUP_READABLE=1 as the default', () => {
    chmodSync(path, 0o640);
    delete process.env.FOS_SECRET_FILES_GROUP_READABLE;
    expect(() => Keyring.load(path)).toThrow(KeyringError);
    process.env.FOS_SECRET_FILES_GROUP_READABLE = '1';
    expect(Keyring.load(path).keyIds).toHaveLength(1);
    process.env.FOS_SECRET_FILES_GROUP_READABLE = 'yes';
    expect(() => Keyring.load(path)).toThrow(KeyringError);
    delete process.env.FOS_SECRET_FILES_GROUP_READABLE;
  });

  it('refuses a missing path and a directory', () => {
    expect(() => Keyring.load(join(dir, 'nope.json'))).toThrow(/not readable/);
    expect(() => Keyring.load(dir)).toThrow(/regular file/);
  });
});
