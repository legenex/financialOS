import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DecryptionError } from './errors';
import { Keyring, generateKeyringFile } from './keyring';
import { MIN_CHUNK_SIZE, decryptEnvelope, encryptEnvelope, envelopeKeyId } from './envelope';

const AAD = 'document:22222222-2222-4222-8222-222222222222';
const CHUNK = MIN_CHUNK_SIZE;

function keyring(): Keyring {
  return new Keyring(generateKeyringFile());
}

async function streamEncrypt(k: Keyring, data: Buffer, options: { aad?: string; chunkSize?: number } = {}): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(Readable.from([data]), k.createEncryptStream(options), async function* (source) {
    for await (const piece of source) out.push(Buffer.from(piece as Buffer));
  });
  return Buffer.concat(out);
}

async function streamDecrypt(k: Keyring, data: Buffer, options: { aad?: string } = {}): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(Readable.from([data]), k.createDecryptStream(options), async function* (source) {
    for await (const piece of source) out.push(Buffer.from(piece as Buffer));
  });
  return Buffer.concat(out);
}

describe('envelope round trip', () => {
  it('handles empty, short, exact-chunk and multi-chunk payloads', () => {
    const k = keyring();
    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 3, CHUNK * 3 + 7]) {
      const plain = randomBytes(size);
      const sealed = encryptEnvelope(k, plain, { aad: AAD, chunkSize: CHUNK });
      expect(sealed.subarray(0, 6).toString('ascii'), `size ${size}`).toBe('FOSENC');
      expect(decryptEnvelope(k, sealed, { aad: AAD }).equals(plain), `size ${size}`).toBe(true);
    }
  });

  it('produces the same format from the streams and the in-memory helpers', async () => {
    const k = keyring();
    const plain = randomBytes(CHUNK * 2 + 11);
    const streamed = await streamEncrypt(k, plain, { aad: AAD, chunkSize: CHUNK });
    expect(decryptEnvelope(k, streamed, { aad: AAD }).equals(plain)).toBe(true);

    const inMemory = encryptEnvelope(k, plain, { aad: AAD, chunkSize: CHUNK });
    expect((await streamDecrypt(k, inMemory, { aad: AAD })).equals(plain)).toBe(true);
  });

  it('works without a purpose, as long as both sides agree', () => {
    const k = keyring();
    const plain = randomBytes(64);
    const sealed = encryptEnvelope(k, plain);
    expect(decryptEnvelope(k, sealed).equals(plain)).toBe(true);
    expect(() => decryptEnvelope(k, sealed, { aad: AAD })).toThrow(DecryptionError);
  });

  it('refuses a chunk size outside the allowed range', () => {
    const k = keyring();
    expect(() => encryptEnvelope(k, Buffer.alloc(1), { chunkSize: 16 })).toThrow(RangeError);
    expect(() => encryptEnvelope(k, Buffer.alloc(1), { chunkSize: 64 * 1024 * 1024 })).toThrow(RangeError);
    expect(() => k.createEncryptStream({ chunkSize: 0 })).toThrow(RangeError);
  });

  it('exposes the wrapping key id from the header without decrypting', () => {
    const k = keyring();
    const sealed = encryptEnvelope(k, Buffer.from('x'), { aad: AAD });
    expect(envelopeKeyId(sealed)).toBe(k.activeKid);
    expect(envelopeKeyId(Buffer.from('not an envelope'))).toBeNull();
    expect(envelopeKeyId(Buffer.alloc(3))).toBeNull();
  });
});

describe('envelope integrity', () => {
  const k = keyring();
  const plain = randomBytes(CHUNK * 2 + 5);
  const sealed = encryptEnvelope(k, plain, { aad: AAD, chunkSize: CHUNK });

  it('detects a wrong purpose', () => {
    expect(() => decryptEnvelope(k, sealed, { aad: 'document:other' })).toThrow(DecryptionError);
    expect(() => decryptEnvelope(k, sealed)).toThrow(DecryptionError);
  });

  it('detects a modified byte anywhere in the body', () => {
    for (const offset of [80, 200, CHUNK, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[offset] = (tampered[offset] as number) ^ 0x01;
      expect(() => decryptEnvelope(k, tampered, { aad: AAD }), `offset ${offset}`).toThrow(DecryptionError);
    }
  });

  it('detects a modified header', () => {
    const tampered = Buffer.from(sealed);
    tampered[6] = 2; // version
    expect(() => decryptEnvelope(k, tampered, { aad: AAD })).toThrow(/envelope version/);

    const notOurs = Buffer.from(sealed);
    notOurs.write('XOSENC', 0, 'ascii');
    expect(() => decryptEnvelope(k, notOurs, { aad: AAD })).toThrow(/not an encrypted/);
  });

  it('detects truncation at a chunk boundary', () => {
    // Drop the final (short, final-flagged) chunk: what is left ends on a full non-final chunk,
    // which is exactly the case a length-only check would miss.
    const truncated = sealed.subarray(0, sealed.length - (5 + 16));
    expect(() => decryptEnvelope(k, truncated, { aad: AAD })).toThrow(DecryptionError);
  });

  it('detects truncation by a single byte', async () => {
    expect(() => decryptEnvelope(k, sealed.subarray(0, sealed.length - 1), { aad: AAD })).toThrow(DecryptionError);
    await expect(streamDecrypt(k, sealed.subarray(0, sealed.length - 1), { aad: AAD })).rejects.toBeInstanceOf(DecryptionError);
  });

  it('detects a header-only file and a too-short file', async () => {
    expect(() => decryptEnvelope(k, sealed.subarray(0, 40), { aad: AAD })).toThrow(/truncated/);
    await expect(streamDecrypt(k, Buffer.alloc(0), { aad: AAD })).rejects.toBeInstanceOf(DecryptionError);
    await expect(streamDecrypt(k, sealed.subarray(0, 40), { aad: AAD })).rejects.toBeInstanceOf(DecryptionError);
  });

  it('detects reordered chunks', () => {
    const frame = CHUNK + 16;
    const headerEnd = sealed.length - (2 * frame + 5 + 16);
    const header = sealed.subarray(0, headerEnd);
    const first = sealed.subarray(headerEnd, headerEnd + frame);
    const second = sealed.subarray(headerEnd + frame, headerEnd + 2 * frame);
    const last = sealed.subarray(headerEnd + 2 * frame);
    const swapped = Buffer.concat([header, second, first, last]);
    expect(swapped.length).toBe(sealed.length);
    expect(() => decryptEnvelope(k, swapped, { aad: AAD })).toThrow(DecryptionError);
  });

  it('will not decrypt a file wrapped by a different keyring', () => {
    // Same key id, different key material: the wrap must not open.
    const sameKidDifferentKey = keyring();
    expect(sameKidDifferentKey.activeKid).toBe(k.activeKid);
    expect(() => decryptEnvelope(sameKidDifferentKey, sealed, { aad: AAD })).toThrow(/could not be unwrapped/);

    // A keyring that has never heard of this key id at all.
    const rotatedAway = new Keyring(generateKeyringFile(undefined, 'zz'));
    expect(() => decryptEnvelope(rotatedAway, sealed, { aad: AAD })).toThrow(/unknown key id/);
  });

  it('still decrypts after the keyring is rotated', async () => {
    const file = generateKeyringFile();
    const before = new Keyring(file);
    const old = encryptEnvelope(before, plain, { aad: AAD, chunkSize: CHUNK });
    const after = new Keyring(generateKeyringFile(file));
    expect(decryptEnvelope(after, old, { aad: AAD }).equals(plain)).toBe(true);
    expect((await streamDecrypt(after, old, { aad: AAD })).equals(plain)).toBe(true);
    expect(envelopeKeyId(old)).toBe(before.activeKid);
  });

  it('never emits plaintext for a chunk that failed to authenticate', async () => {
    const tampered = Buffer.from(sealed);
    // Corrupt the FIRST chunk so any output at all would be a leak of unauthenticated data.
    const offset = 2 * (CHUNK + 16) + 1;
    const idx = tampered.length - offset;
    if (idx < 0 || idx >= tampered.length) {
      throw new Error('tamper index out of range');
    }
    const original = tampered[idx];
    if (original === undefined) {
      throw new Error('tamper index unexpectedly undefined');
    }
    tampered[idx] = original ^ 0x01;
    const out: Buffer[] = [];
    await expect(
      pipeline(Readable.from([tampered]), k.createDecryptStream({ aad: AAD }), async function* (source) {
        for await (const piece of source) out.push(Buffer.from(piece as Buffer));
      }),
    ).rejects.toBeInstanceOf(DecryptionError);
    expect(Buffer.concat(out).includes(plain.subarray(0, 32))).toBe(false);
  });
});
