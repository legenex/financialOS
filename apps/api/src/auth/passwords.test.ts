import { describe, expect, it } from 'vitest';
import { PASSWORD_MIN_LENGTH } from '@financialos/contracts';
import { ARGON2_OPTIONS, PASSWORD_MAX_LENGTH, hashPassword, passwordProblem, verifyPassword } from './passwords';

const GOOD = 'plum-harbour-tangent-vessel-71';

describe('password hashing', () => {
  it('uses Argon2id with the configured OWASP parameters', async () => {
    expect(ARGON2_OPTIONS).toMatchObject({ algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const stored = await hashPassword(GOOD);
    expect(stored.startsWith('$argon2id$')).toBe(true);
    expect(stored).toContain('$v=19$');
    expect(stored).toContain('$m=19456,t=2,p=1$');
  });

  it('salts every hash, so the same password hashes differently', async () => {
    expect(await hashPassword(GOOD)).not.toBe(await hashPassword(GOOD));
  });

  it('verifies the right password and refuses the wrong one', async () => {
    const stored = await hashPassword(GOOD);
    expect(await verifyPassword(stored, GOOD)).toBe(true);
    expect(await verifyPassword(stored, `${GOOD}x`)).toBe(false);
    expect(await verifyPassword(stored, '')).toBe(false);
  });

  it('normalises to NFKC so a composed and decomposed passphrase match', async () => {
    const stored = await hashPassword('café-harbour-tangent-vessel-71');
    expect(await verifyPassword(stored, 'café-harbour-tangent-vessel-71')).toBe(true);
  });

  it('never throws on a malformed stored hash', async () => {
    for (const stored of ['', 'not-a-hash', '$argon2id$broken', '$2y$10$abcdefghijklmnopqrstuv']) {
      await expect(verifyPassword(stored, GOOD)).resolves.toBe(false);
    }
  });
});

describe('passwordProblem', () => {
  it('requires the configured minimum length', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(15);
    expect(passwordProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('too_short');
    expect(passwordProblem('x'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe('too_long');
  });

  it('rejects common long passwords and predictable shapes', () => {
    expect(passwordProblem('correcthorsebatterystaple')).toBe('too_common');
    expect(passwordProblem('correct horse battery staple')).toBe('too_common');
    expect(passwordProblem('abcabcabcabcabcabc')).toBe('too_simple');
    expect(passwordProblem('aaaaaaaaaaaaaaaaaaaa')).toBe('too_simple');
    expect(passwordProblem('123456789012345678')).toBe('too_simple');
  });

  it('rejects a password that is just the context term', () => {
    expect(passwordProblem('Example Holdings Limited', ['Example Holdings Limited'])).toBe('too_common');
    expect(passwordProblem('financialos', ['financialos'])).toBe('too_short');
  });

  it('accepts a reasonable passphrase', () => {
    expect(passwordProblem(GOOD, ['Example Owner', 'financialos'])).toBeNull();
  });
});
