import { readFileSync, statSync } from 'node:fs';

export class SecretFileError extends Error {
  override readonly name = 'SecretFileError';
}

/**
 * Reads a small secret file. Refuses files accessible to "other" users (group-readable 0640 is
 * accepted: containers read secrets through a shared group). Never logs the content.
 */
export function readSecretFile(path: string, label: string): string {
  let mode: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new SecretFileError(`${label}: not a regular file`);
    mode = st.mode;
  } catch (err) {
    if (err instanceof SecretFileError) throw err;
    throw new SecretFileError(`${label}: file is not readable`);
  }
  if ((mode & 0o007) !== 0) throw new SecretFileError(`${label}: file must not be accessible to other users`);
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new SecretFileError(`${label}: file is empty`);
  return value;
}

/** Session pepper: at least 32 characters of high-entropy material. */
export function loadSessionPepper(path: string): Buffer {
  const value = readSecretFile(path, 'session pepper');
  if (value.length < 32) throw new SecretFileError('session pepper: must contain at least 32 characters');
  return Buffer.from(value, 'utf8');
}

/**
 * Bootstrap secret hash (sha256 hex). Returns null when the file does not exist, which is
 * normal once setup is sealed.
 */
export function loadBootstrapHash(path: string): string | null {
  try {
    statSync(path);
  } catch {
    return null;
  }
  const value = readSecretFile(path, 'bootstrap secret hash').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) throw new SecretFileError('bootstrap secret hash: expected 64 hex characters (sha256)');
  return value;
}
