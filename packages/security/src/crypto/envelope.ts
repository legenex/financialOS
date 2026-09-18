/**
 * Envelope file encryption (documents, backups).
 *
 * Format (all integers big-endian):
 *
 *   header := magic "FOSENC" (6) | version 0x01 (1) | kidLen (1) | kid (kidLen, ASCII)
 *             | wrappedDek (60 = iv 12 + ct 32 + tag 16) | chunkSize u32 (4) | noncePrefix (7)
 *   body   := chunk* finalChunk
 *   chunk  := AES-256-GCM(dek, nonce(i, 0), plaintext[chunkSize], aad = header | purpose) | tag (16)
 *   final  := AES-256-GCM(dek, nonce(n, 1), plaintext[0..chunkSize], aad = header | purpose) | tag (16)
 *   nonce(i, last) := noncePrefix (7) | i u32 (4) | last (1)
 *
 * This is the STREAM construction: each chunk is authenticated on its own, its position is bound
 * by the counter, the header is bound by the associated data, and the final-chunk flag in the
 * nonce makes truncation at a chunk boundary detectable. The per-file data key (DEK) is random
 * and wrapped with the keyring's active key; the wrap is bound to the key id and purpose.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import type { Keyring } from './keyring';
import { DecryptionError } from './errors';

const MAGIC = Buffer.from('FOSENC', 'ascii');
const VERSION = 1;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const WRAPPED_DEK_BYTES = 12 + KEY_BYTES + TAG_BYTES;
const NONCE_PREFIX_BYTES = 7;
const MAX_COUNTER = 0xffffffff;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
export const MIN_CHUNK_SIZE = 1024;
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
const FIXED_HEADER_BYTES = MAGIC.length + 1 + 1;

export interface EnvelopeOptions {
  /** Purpose binding, e.g. `document:<id>` or `backup:<id>`. Must be identical when decrypting. */
  aad?: string;
  /** Plaintext bytes per chunk (default 64 KiB). */
  chunkSize?: number;
}

interface Header {
  bytes: Buffer;
  kid: string;
  wrappedDek: Buffer;
  chunkSize: number;
  noncePrefix: Buffer;
}

function purposeBytes(aad: string | undefined): Buffer {
  const value = aad ?? '';
  if (value.length > 512) throw new DecryptionError('envelope: purpose is too long');
  return Buffer.from(value, 'utf8');
}

function wrapContext(kid: string, purpose: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`fos-envelope-v${VERSION}:dek:${kid}:`, 'ascii'), purpose]);
}

function buildHeader(kid: string, wrappedDek: Buffer, chunkSize: number, noncePrefix: Buffer): Buffer {
  const kidBuf = Buffer.from(kid, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(chunkSize);
  return Buffer.concat([MAGIC, Buffer.from([VERSION, kidBuf.length]), kidBuf, wrappedDek, size, noncePrefix]);
}

/** Returns null when more bytes are needed. Throws on an invalid header. */
function parseHeader(buf: Buffer): Header | null {
  if (buf.length < FIXED_HEADER_BYTES) return null;
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new DecryptionError('decryption failed: not an encrypted FinancialOS file');
  if (buf[MAGIC.length] !== VERSION) throw new DecryptionError('decryption failed: unsupported envelope version');
  const kidLen = buf[MAGIC.length + 1] ?? 0;
  if (kidLen < 1 || kidLen > 32) throw new DecryptionError('decryption failed: malformed header');
  const total = FIXED_HEADER_BYTES + kidLen + WRAPPED_DEK_BYTES + 4 + NONCE_PREFIX_BYTES;
  if (buf.length < total) return null;
  let offset = FIXED_HEADER_BYTES;
  const kid = buf.subarray(offset, offset + kidLen).toString('ascii');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new DecryptionError('decryption failed: malformed header');
  offset += kidLen;
  const wrappedDek = Buffer.from(buf.subarray(offset, offset + WRAPPED_DEK_BYTES));
  offset += WRAPPED_DEK_BYTES;
  const chunkSize = buf.readUInt32BE(offset);
  offset += 4;
  if (chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) throw new DecryptionError('decryption failed: malformed header');
  const noncePrefix = Buffer.from(buf.subarray(offset, offset + NONCE_PREFIX_BYTES));
  offset += NONCE_PREFIX_BYTES;
  return { bytes: Buffer.from(buf.subarray(0, offset)), kid, wrappedDek, chunkSize, noncePrefix };
}

function nonceFor(prefix: Buffer, counter: number, last: boolean): Buffer {
  if (counter > MAX_COUNTER) throw new DecryptionError('envelope: too many chunks');
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(counter, NONCE_PREFIX_BYTES);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

function sealChunk(dek: Buffer, header: Buffer, purpose: Buffer, prefix: Buffer, counter: number, last: boolean, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', dek, nonceFor(prefix, counter, last), { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.concat([header, purpose]));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function openChunk(dek: Buffer, header: Buffer, purpose: Buffer, prefix: Buffer, counter: number, last: boolean, frame: Buffer): Buffer {
  if (frame.length < TAG_BYTES) throw new DecryptionError('decryption failed: truncated file');
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, nonceFor(prefix, counter, last), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.concat([header, purpose]));
    decipher.setAuthTag(frame.subarray(frame.length - TAG_BYTES));
    return Buffer.concat([decipher.update(frame.subarray(0, frame.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new DecryptionError(last ? 'decryption failed: file is truncated or was modified' : 'decryption failed: file was modified');
  }
}

/** Accumulates bytes without quadratic copying. */
class ByteQueue {
  #parts: Buffer[] = [];
  length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#parts.push(chunk);
    this.length += chunk.length;
  }

  peekAll(): Buffer {
    if (this.#parts.length !== 1) this.#parts = [Buffer.concat(this.#parts, this.length)];
    return this.#parts[0] ?? Buffer.alloc(0);
  }

  take(n: number): Buffer {
    const all = this.peekAll();
    const head = all.subarray(0, n);
    const rest = all.subarray(n);
    this.#parts = rest.length ? [rest] : [];
    this.length = rest.length;
    return head;
  }
}

function toBuffer(chunk: unknown, encoding: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding);
  throw new TypeError('envelope: stream chunks must be Buffer, Uint8Array or string');
}

export class EnvelopeEncryptStream extends Transform {
  readonly #dek: Buffer;
  readonly #header: Buffer;
  readonly #purpose: Buffer;
  readonly #prefix: Buffer;
  readonly #chunkSize: number;
  readonly #queue = new ByteQueue();
  #counter = 0;
  #headerSent = false;

  constructor(keyring: Keyring, options: EnvelopeOptions = {}) {
    super();
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
      throw new RangeError('envelope: chunkSize out of range');
    }
    this.#chunkSize = chunkSize;
    this.#purpose = purposeBytes(options.aad);
    this.#dek = randomBytes(KEY_BYTES);
    this.#prefix = randomBytes(NONCE_PREFIX_BYTES);
    const kid = keyring.activeKid;
    const { wrapped } = keyring.wrapDataKey(this.#dek, wrapContext(kid, this.#purpose));
    this.#header = buildHeader(kid, wrapped, chunkSize, this.#prefix);
  }

  #sendHeader(): void {
    if (!this.#headerSent) {
      this.push(this.#header);
      this.#headerSent = true;
    }
  }

  override _transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.#sendHeader();
      this.#queue.push(toBuffer(chunk, encoding));
      // Keep at least one byte beyond a full chunk before sealing it as non-final, so the final
      // chunk is always sealed with the final flag (possibly as a full chunk).
      while (this.#queue.length > this.#chunkSize) {
        const plain = this.#queue.take(this.#chunkSize);
        this.push(sealChunk(this.#dek, this.#header, this.#purpose, this.#prefix, this.#counter, false, plain));
        this.#counter += 1;
      }
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.#sendHeader();
      const rest = this.#queue.take(this.#queue.length);
      this.push(sealChunk(this.#dek, this.#header, this.#purpose, this.#prefix, this.#counter, true, rest));
      this.#dek.fill(0);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}

export class EnvelopeDecryptStream extends Transform {
  readonly #keyring: Keyring;
  readonly #purpose: Buffer;
  readonly #queue = new ByteQueue();
  #header: Header | null = null;
  #dek: Buffer | null = null;
  #counter = 0;

  constructor(keyring: Keyring, options: Pick<EnvelopeOptions, 'aad'> = {}) {
    super();
    this.#keyring = keyring;
    this.#purpose = purposeBytes(options.aad);
  }

  #ensureHeader(): boolean {
    if (this.#header) return true;
    const header = parseHeader(this.#queue.peekAll());
    if (!header) return false;
    this.#queue.take(header.bytes.length);
    this.#dek = this.#keyring.unwrapDataKey(header.kid, header.wrappedDek, wrapContext(header.kid, this.#purpose));
    this.#header = header;
    return true;
  }

  override _transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.#queue.push(toBuffer(chunk, encoding));
      if (!this.#ensureHeader()) return callback();
      const header = this.#header as Header;
      const dek = this.#dek as Buffer;
      const frame = header.chunkSize + TAG_BYTES;
      while (this.#queue.length > frame) {
        const sealed = this.#queue.take(frame);
        this.push(openChunk(dek, header.bytes, this.#purpose, header.noncePrefix, this.#counter, false, sealed));
        this.#counter += 1;
      }
      callback();
    } catch (err) {
      callback(err instanceof DecryptionError ? err : new DecryptionError('decryption failed'));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (!this.#ensureHeader()) throw new DecryptionError('decryption failed: truncated file');
      const header = this.#header as Header;
      const dek = this.#dek as Buffer;
      const rest = this.#queue.take(this.#queue.length);
      if (rest.length < TAG_BYTES) throw new DecryptionError('decryption failed: truncated file');
      this.push(openChunk(dek, header.bytes, this.#purpose, header.noncePrefix, this.#counter, true, rest));
      dek.fill(0);
      callback();
    } catch (err) {
      callback(err instanceof DecryptionError ? err : new DecryptionError('decryption failed'));
    }
  }
}

/** In-memory helpers with the same format as the streams (for small payloads and tests). */
export function encryptEnvelope(keyring: Keyring, data: Uint8Array, options: EnvelopeOptions = {}): Buffer {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new RangeError('envelope: chunkSize out of range');
  }
  const purpose = purposeBytes(options.aad);
  const dek = randomBytes(KEY_BYTES);
  const prefix = randomBytes(NONCE_PREFIX_BYTES);
  const kid = keyring.activeKid;
  const { wrapped } = keyring.wrapDataKey(dek, wrapContext(kid, purpose));
  const header = buildHeader(kid, wrapped, chunkSize, prefix);
  const input = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const out: Buffer[] = [header];
  let offset = 0;
  let counter = 0;
  while (input.length - offset > chunkSize) {
    out.push(sealChunk(dek, header, purpose, prefix, counter, false, input.subarray(offset, offset + chunkSize)));
    offset += chunkSize;
    counter += 1;
  }
  out.push(sealChunk(dek, header, purpose, prefix, counter, true, input.subarray(offset)));
  dek.fill(0);
  return Buffer.concat(out);
}

export function decryptEnvelope(keyring: Keyring, data: Uint8Array, options: Pick<EnvelopeOptions, 'aad'> = {}): Buffer {
  const purpose = purposeBytes(options.aad);
  const input = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const header = parseHeader(input);
  if (!header) throw new DecryptionError('decryption failed: truncated file');
  const dek = keyring.unwrapDataKey(header.kid, header.wrappedDek, wrapContext(header.kid, purpose));
  const frame = header.chunkSize + TAG_BYTES;
  const out: Buffer[] = [];
  let offset = header.bytes.length;
  let counter = 0;
  while (input.length - offset > frame) {
    out.push(openChunk(dek, header.bytes, purpose, header.noncePrefix, counter, false, input.subarray(offset, offset + frame)));
    offset += frame;
    counter += 1;
  }
  out.push(openChunk(dek, header.bytes, purpose, header.noncePrefix, counter, true, input.subarray(offset)));
  dek.fill(0);
  return Buffer.concat(out);
}

/** Key id used to wrap an envelope's data key, read from its header (no decryption). */
export function envelopeKeyId(headerBytes: Uint8Array): string | null {
  try {
    return parseHeader(Buffer.from(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength))?.kid ?? null;
  } catch {
    return null;
  }
}
