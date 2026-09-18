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
