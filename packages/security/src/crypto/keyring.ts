import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { Transform } from 'node:stream';
import { EnvelopeDecryptStream, EnvelopeEncryptStream, type EnvelopeOptions } from './envelope';
import { DecryptionError, KeyringError } from './errors';

export { DecryptionError, KeyringError };

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const STRING_FORMAT_VERSION = 'fos1';
const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const B64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** On-disk keyring format: `{ "active": "k1", "keys": { "k1": "<base64 of 32 bytes>" } }`. */
export interface KeyringFile {
  active: string;
  keys: Record<string, string>;
}

function decodeKey(kid: string, value: unknown): Buffer {
  if (typeof value !== 'string') throw new KeyringError(`keyring: key "${kid}" must be a base64 string`);
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) throw new KeyringError(`keyring: key "${kid}" is not base64`);
  const buf = Buffer.from(trimmed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length !== KEY_BYTES) throw new KeyringError(`keyring: key "${kid}" must decode to ${KEY_BYTES} bytes`);
  return buf;
}

function assertAad(aad: string): Buffer {
  if (typeof aad !== 'string' || aad.length === 0 || aad.length > 512) {
    throw new KeyringError('keyring: associated data (purpose) is required, e.g. "connection-secret:<id>"');
  }
  return Buffer.from(aad, 'utf8');
}

/**
 * AES-256-GCM keyring with versioned keys. Ciphertext records the key id, so older keys keep
 * decrypting after a new key becomes active (rotation without bulk re-encryption).
 */
export class Keyring {
  readonly activeKid: string;
  readonly #keys: Map<string, Buffer>;

  constructor(file: KeyringFile) {
    if (!file || typeof file !== 'object') throw new KeyringError('keyring: invalid file');
    if (typeof file.active !== 'string' || !KID_PATTERN.test(file.active)) {
      throw new KeyringError('keyring: "active" must be a key id matching [A-Za-z0-9_-]{1,32}');
    }
    if (!file.keys || typeof file.keys !== 'object' || Array.isArray(file.keys)) {
      throw new KeyringError('keyring: "keys" must be an object');
    }
    const keys = new Map<string, Buffer>();
    for (const [kid, value] of Object.entries(file.keys)) {
      if (!KID_PATTERN.test(kid)) throw new KeyringError(`keyring: invalid key id "${kid.slice(0, 40)}"`);
      keys.set(kid, decodeKey(kid, value));
    }
    if (!keys.has(file.active)) throw new KeyringError('keyring: active key id is not present in "keys"');
    this.activeKid = file.active;
    this.#keys = keys;
  }

  static fromJson(json: string): Keyring {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new KeyringError('keyring: file is not valid JSON');
    }
    return new Keyring(parsed as KeyringFile);
  }

  /**
   * Loads the keyring file. Refuses files accessible to others; group access is refused too
   * unless `allowGroupReadable` is set (default: `FOS_SECRET_FILES_GROUP_READABLE=1`, used when
   * containers read secrets through a shared group with mode 0640).
   */
  static load(path: string, options: { allowGroupReadable?: boolean } = {}): Keyring {
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new KeyringError('keyring: file is not readable');
    }
    if (!st.isFile()) throw new KeyringError('keyring: path is not a regular file');
    const allowGroup = options.allowGroupReadable ?? process.env.FOS_SECRET_FILES_GROUP_READABLE === '1';
    const forbidden = allowGroup ? 0o007 : 0o077;
    if ((st.mode & forbidden) !== 0) {
      throw new KeyringError(
        allowGroup ? 'keyring: file must not be accessible to other users (expected 0640 or stricter)' : 'keyring: file permissions are too open (expected 0600 or 0400)',
      );
    }
    return Keyring.fromJson(readFileSync(path, 'utf8'));
  }

  get keyIds(): string[] {
    return [...this.#keys.keys()];
  }

  hasKey(kid: string): boolean {
    return this.#keys.has(kid);
  }

  /** @internal Used by the envelope format. */
  keyFor(kid: string): Buffer {
    const key = this.#keys.get(kid);
    if (!key) throw new DecryptionError('decryption failed: unknown key id');
    return key;
  }

  /** Encrypts UTF-8 text. Output: `fos1.<kid>.<iv>.<ciphertext>.<tag>` (base64url parts). */
  encryptString(plaintext: string, aad: string): string {
    return this.encryptBytes(Buffer.from(plaintext, 'utf8'), aad);
  }

  decryptString(payload: string, aad: string): string {
    return this.decryptBytes(payload, aad).toString('utf8');
  }

  encryptBytes(plaintext: Uint8Array, aad: string): string {
    const aadBuf = assertAad(aad);
    const kid = this.activeKid;
    const key = this.keyFor(kid);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.concat([Buffer.from(`${STRING_FORMAT_VERSION}.${kid}.`), aadBuf]));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [STRING_FORMAT_VERSION, kid, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
  }

  decryptBytes(payload: string, aad: string): Buffer {
    const aadBuf = assertAad(aad);
    if (typeof payload !== 'string' || payload.length > 16 * 1024 * 1024) throw new DecryptionError('decryption failed: malformed payload');
    const parts = payload.split('.');
    if (parts.length !== 5) throw new DecryptionError('decryption failed: malformed payload');
    const [version, kid, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
    if (version !== STRING_FORMAT_VERSION) throw new DecryptionError('decryption failed: unsupported format version');
    if (!KID_PATTERN.test(kid) || ![ivB64, ctB64, tagB64].every((p) => B64URL_PATTERN.test(p))) {
      throw new DecryptionError('decryption failed: malformed payload');
    }
    const key = this.keyFor(kid);
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptionError('decryption failed: malformed payload');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.concat([Buffer.from(`${version}.${kid}.`), aadBuf]));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]);
    } catch {
      throw new DecryptionError('decryption failed: authentication tag mismatch');
    }
  }

  /** Key id recorded in a string payload, or null when the payload is not in this format. */
  static keyIdOf(payload: string): string | null {
    const parts = payload.split('.');
    return parts.length === 5 && parts[0] === STRING_FORMAT_VERSION && KID_PATTERN.test(parts[1] ?? '') ? (parts[1] ?? null) : null;
  }

  /** True when the payload was encrypted with a key other than the active one (candidate for re-encryption). */
  needsRotation(payload: string): boolean {
    const kid = Keyring.keyIdOf(payload);
    return kid !== null && kid !== this.activeKid;
  }

  /**
   * Streaming envelope encryption for documents and backups: a random per-file data key is
   * wrapped with the active key, and the content is sealed in authenticated chunks.
   */
  createEncryptStream(options: EnvelopeOptions = {}): Transform {
    return new EnvelopeEncryptStream(this, options);
  }

  /** Emits plaintext only for chunks that authenticated. Truncation and tampering raise an error. */
  createDecryptStream(options: Pick<EnvelopeOptions, 'aad'> = {}): Transform {
    return new EnvelopeDecryptStream(this, options);
  }

  /** @internal Wraps a data key with the active key. */
  wrapDataKey(dek: Buffer, context: Buffer): { kid: string; wrapped: Buffer } {
    const kid = this.activeKid;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keyFor(kid), iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(context);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return { kid, wrapped: Buffer.concat([iv, ct, cipher.getAuthTag()]) };
  }

  /** @internal */
  unwrapDataKey(kid: string, wrapped: Buffer, context: Buffer): Buffer {
    const key = this.keyFor(kid);
    if (wrapped.length !== IV_BYTES + KEY_BYTES + TAG_BYTES) throw new DecryptionError('decryption failed: malformed header');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAAD(context);
      decipher.setAuthTag(wrapped.subarray(IV_BYTES + KEY_BYTES));
      return Buffer.concat([decipher.update(wrapped.subarray(IV_BYTES, IV_BYTES + KEY_BYTES)), decipher.final()]);
    } catch {
      throw new DecryptionError('decryption failed: data key could not be unwrapped');
    }
  }
}

/**
 * Creates a new keyring file, or rotates an existing one by adding a fresh key and making it
 * active. Old keys are kept so existing ciphertext stays readable.
 */
export function generateKeyringFile(existing?: KeyringFile, kid?: string): KeyringFile {
  const keys: Record<string, string> = { ...(existing?.keys ?? {}) };
  let newKid = kid;
  if (!newKid) {
    let n = Object.keys(keys).length + 1;
    while (keys[`k${n}`] !== undefined) n += 1;
    newKid = `k${n}`;
  }
  if (!KID_PATTERN.test(newKid)) throw new KeyringError('keyring: invalid key id');
  if (keys[newKid] !== undefined) throw new KeyringError('keyring: key id already exists');
  keys[newKid] = randomBytes(KEY_BYTES).toString('base64');
  const file: KeyringFile = { active: newKid, keys };
  // Validate the result before handing it back.
  new Keyring(file);
  return file;
}
