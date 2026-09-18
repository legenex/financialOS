import type { Algorithm } from '@node-rs/argon2';
import { hash, verify } from '@node-rs/argon2';
import { PASSWORD_MIN_LENGTH } from '@financialos/contracts';

/** OWASP-recommended Argon2id parameters (m = 19 MiB, t = 2, p = 1). */
export const ARGON2_OPTIONS = {
  algorithm: 2 as Algorithm, // Argon2id
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MAX_LENGTH = 512;

export function hashPassword(password: string): Promise<string> {
  return hash(password.normalize('NFKC'), ARGON2_OPTIONS);
}

/** Never throws: a malformed stored hash is simply a failed verification. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password.normalize('NFKC'));
  } catch {
    return false;
  }
}

/**
 * Frequently used long passwords and phrases. The minimum length already rules out most
 * breached passwords; this list catches the long ones people still reach for.
 */
const COMMON_LONG_PASSWORDS = new Set(
  [
    'passwordpassword',
    'password12345678',
    'password123456789',
    'passwordpassword1',
    'password1234567890',
    'mypasswordismypassword',
    'thisismypassword',
    'thisismypassword1',
    'thisisapassword',
    'iloveyouiloveyou',
    'iloveyousomuch',
    'qwertyuiopasdfgh',
    'qwertyuiopasdfghjkl',
    'qwertyuiopasdfghjklzxcvbnm',
    'qwertyuiop123456',
    '1qaz2wsx3edc4rfv',
    '1q2w3e4r5t6y7u8i',
    'zaq12wsxcde34rfv',
    'abcdefghijklmnop',
    'abcdefghijklmnopqrstuvwxyz',
    'administrator123',
    'administratoradmin',
    'letmeinletmein',
    'welcometoyourhome',
    'correcthorsebatterystaple',
    'trustno1trustno1',
    'changemechangeme',
    'changemeplease',
    'defaultpassword',
    'supersecretpassword',
    'mysecretpassword',
    'financialospassword',
    'financialos123456',
    'masterpassword123',
    'passw0rdpassw0rd',
    'p@ssw0rdp@ssw0rd',
    'baseballbaseball',
    'footballfootball',
    'monkeymonkeymonkey',
    'sunshinesunshine',
    'princessprincess',
    'starwarsstarwars',
    'dragondragondragon',
    'michaelmichael1',
    'superman123456789',
    'batman1234567890',
    'loveyouforever',
    'nevergonnagiveyouup',
    'thequickbrownfox',
    'thequickbrownfoxjumpsoverthelazydog',
    'onetwothreefourfive',
    'letmeinplease123',
  ].map((p) => p.toLowerCase()),
);

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common' | 'too_simple';

export function passwordProblem(password: string, context: string[] = []): PasswordProblem | null {
  const normalized = password.normalize('NFKC');
  const length = [...normalized].length;
  if (length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (normalized.length > PASSWORD_MAX_LENGTH) return 'too_long';
  const compact = normalized.toLowerCase().replace(/[\s_.-]+/g, '');
  if (COMMON_LONG_PASSWORDS.has(compact)) return 'too_common';
  // Very low variety: one short unit repeated (aaaa…, abcabc…, 1234 1234 …).
  if (/^(.{1,4})\1+.{0,3}$/su.test(compact)) return 'too_simple';
  if (new Set(compact).size < 5) return 'too_simple';
  // Keyboard or numeric runs only.
  if (/^\d+$/.test(compact) && isSequential(compact)) return 'too_simple';
  for (const term of context) {
    const t = term.toLowerCase().replace(/[\s_.-]+/g, '');
    if (t.length >= 4 && compact === t) return 'too_common';
  }
  return null;
}

function isSequential(digits: string): boolean {
  for (let i = 1; i < digits.length; i += 1) {
    const prev = digits.charCodeAt(i - 1);
    const cur = digits.charCodeAt(i);
    if ((cur - prev + 10) % 10 !== 1 && !(prev === 57 && cur === 48)) return false;
  }
  return true;
}

export const PASSWORD_PROBLEM_MESSAGES: Record<PasswordProblem, string> = {
  too_short: `Use at least ${PASSWORD_MIN_LENGTH} characters. A few unrelated words make a good passphrase.`,
  too_long: `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
  too_common: 'This password is too common. Choose a passphrase that is unique to you.',
  too_simple: 'This password is too predictable. Mix several unrelated words.',
};
