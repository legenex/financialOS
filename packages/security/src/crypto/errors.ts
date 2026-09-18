export class KeyringError extends Error {
  override readonly name = 'KeyringError';
}

/** Raised for any decryption failure. The message never includes key material or plaintext. */
export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';
}
