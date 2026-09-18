import { generateRecoveryCode, hmacSha256, normalizeRecoveryCode } from '@financialos/security/tokens';

export const RECOVERY_CODE_COUNT = 10;

/** Codes carry 80 random bits, so a keyed SHA-256 is sufficient and allows direct lookup. */
export function hashRecoveryCode(pepper: Buffer, normalizedCode: string): string {
  return hmacSha256(pepper, `recovery-code:${normalizedCode}`).toString('hex');
}

export function newRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(generateRecoveryCode());
  return [...codes];
}

/** Returns the lookup hash for user input, or null when the input cannot be a recovery code. */
export function recoveryCodeLookupHash(pepper: Buffer, input: string): string | null {
  const normalized = normalizeRecoveryCode(input);
  return normalized ? hashRecoveryCode(pepper, normalized) : null;
}
