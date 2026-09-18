import { describe, expect, it } from 'vitest';
import { PINO_REDACT_PATHS, REDACTED, isSecretKey, redactText, redactUrl, redactValue } from './index';

describe('redactUrl', () => {
  it('drops the query string, which is where tokens travel', () => {
    expect(redactUrl('https://app.example.test/report?t=SUPERSECRET')).toBe(`https://app.example.test/report?${REDACTED}`);
    expect(redactUrl('/api/documents/1/download?token=abc123')).toBe(`/api/documents/1/download?${REDACTED}`);
    expect(redactUrl('https://app.example.test/a?b=c#frag')).toBe(`https://app.example.test/a?${REDACTED}`);
  });

  it('drops userinfo', () => {
    expect(redactUrl('postgres://fos_app:hunter2@db.internal:5432/financialos')).not.toContain('hunter2'); // privacy-check: allow-generic (synthetic fixture)
    expect(redactUrl('https://user:pass@example.test/x')).toBe('https://example.test/x');
  });

  it('leaves a clean path or URL alone', () => {
    expect(redactUrl('/api/today')).toBe('/api/today');
    expect(redactUrl('https://app.example.test')).toBe('https://app.example.test');
    expect(redactUrl('')).toBe('');
  });

  it('still strips secrets from an unparseable URL', () => {
    const mangled = redactUrl('http://[::bad::]/path?t=SECRET');
    expect(mangled).not.toContain('SECRET');
    expect(mangled).toContain(REDACTED);
  });
});

describe('redactText', () => {
  it('removes bearer and basic credentials', () => {
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactText('basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==')).toContain(REDACTED);
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });

  it('removes FinancialOS credentials and common vendor keys', () => {
    expect(redactText(`device credential fos_dev_${'A'.repeat(43)} used`)).toContain('[redacted-credential]');
    expect(redactText(`agent fos_agent_${'B'.repeat(43)}`)).not.toContain('B'.repeat(20));
    expect(redactText('key sk-abcdefghijklmnopqrstuvwx')).toContain('[redacted-credential]'); // privacy-check: allow-generic (synthetic fixture)
    expect(redactText('pushed with ghp_abcdefghijklmnopqrstuvwxyz1234')).toContain('[redacted-credential]'); // privacy-check: allow-generic (synthetic fixture)
    // Even when another rule matches first, the secret itself never survives.
    expect(redactText('token ghp_abcdefghijklmnopqrstuvwxyz1234')).not.toContain('ghp_'); // privacy-check: allow-generic (synthetic fixture)
    expect(redactText('AKIAIOSFODNN7EXAMPLE')).toContain('[redacted-credential]'); // privacy-check: allow-generic (AWS's own published example key)
    expect(redactText('eyJhbGciOi.eyJzdWIiOiJ4.c2lnbmF0dXJl')).toContain('[redacted-jwt]');
  });

  it('removes private keys', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADAN\n-----END PRIVATE KEY-----'; // privacy-check: allow-generic (synthetic fixture) // gitleaks:allow
    expect(redactText(`before ${pem} after`)).toBe('before [redacted-private-key] after');
    expect(redactText('-----BEGIN RSA PRIVATE KEY-----\nabc')).toBe('[redacted-private-key]'); // privacy-check: allow-generic (synthetic fixture)
  });

  it('removes key=value secrets in free text', () => {
    expect(redactText('password=hunter2seventeen')).toBe(`password=${REDACTED}`);
    expect(redactText('{"client_secret": "abc123def"}')).toContain(REDACTED);
    expect(redactText('verifier: abcdefghijklmnop')).toContain(REDACTED);
    expect(redactText('password=hunter2seventeen')).not.toContain('hunter2');
  });

  it('removes email addresses', () => {
    expect(redactText('mail owner@example.test now')).toBe('mail [redacted-email] now');
    expect(redactText('Contact: a.b+c@sub.example.test')).toContain('[redacted-email]');
  });

  it('removes card-like and account-like digit runs', () => {
    expect(redactText('card 4111 1111 1111 1111')).toBe('card [redacted-number]');
    expect(redactText('card 4111-1111-1111-1111')).toBe('card [redacted-number]');
    expect(redactText('account 123456789012')).toBe('account [redacted-number]');
    expect(redactText('iban GB29 NWBK 6016 1331 9268 19')).toContain('[redacted-iban]'); // privacy-check: allow-generic (well-known published example IBAN)
  });

  it('keeps short numbers and record ids readable', () => {
    expect(redactText('3 of 12 items, 2025-03-01')).toBe('3 of 12 items, 2025-03-01');
    const uuid = '11111111-2222-4333-8444-555555555555';
    expect(redactText(`session ${uuid} ended`)).toBe(`session ${uuid} ended`);
    expect(redactText(`ids ${uuid} and ${uuid}`)).toBe(`ids ${uuid} and ${uuid}`);
  });

  it('truncates enormous input instead of scanning forever', () => {
    const out = redactText('a'.repeat(100_000));
    expect(out.length).toBeLessThan(70_000);
    expect(out.endsWith('[truncated]')).toBe(true);
  });

  it('is a no-op for empty and non-string input', () => {
    expect(redactText('')).toBe('');
    expect(redactText(undefined as never)).toBeUndefined();
  });
});

describe('isSecretKey', () => {
  it('matches secret-ish key names regardless of separators or case', () => {
    for (const key of ['password', 'Password', 'access_token', 'ACCESS-TOKEN', 'clientSecret', 'csrf token', 'recoveryCodes', 'cardNumber', 'iban', 'cookie']) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ['name', 'amount', 'entityId', 'tokenCount', 'currency']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe('redactValue', () => {
  it('replaces secret-named keys at any depth and scrubs strings', () => {
    const scrubbed = redactValue({
      user: { email: 'owner@example.test', password: 'hunter2seventeen' },
      nested: { deep: { apiKey: 'sk-abcdefghijklmnopqrstuvwx', note: 'card 4111 1111 1111 1111' } }, // privacy-check: allow-generic (synthetic fixture)
      ok: 'plain text',
    }) as Record<string, Record<string, unknown>>;

    expect(scrubbed.user!.password).toBe(REDACTED);
    expect(scrubbed.user!.email).toBe('[redacted-email]');
    expect((scrubbed.nested!.deep as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect((scrubbed.nested!.deep as Record<string, unknown>).note).toBe('card [redacted-number]');
    expect(scrubbed.ok).toBe('plain text');
  });

  it('bounds depth, array length and object size', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 12; i += 1) deep = { deep };
    expect(JSON.stringify(redactValue(deep))).toContain('[truncated]');

    const long = redactValue(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(long).toHaveLength(100);

    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(redactValue(wide) as object).length).toBeLessThanOrEqual(101);
  });

  it('summarises binary data and errors without leaking content', () => {
    expect(redactValue(Buffer.from('secret-bytes'))).toBe('[binary 12 bytes]');
    const error = redactValue(new Error('failed for owner@example.test')) as { message: string };
    expect(error.message).toBe('failed for [redacted-email]');
    expect(redactValue(new Date('2025-03-01T00:00:00.000Z'))).toBe('2025-03-01T00:00:00.000Z');
    expect(redactValue(10n)).toBe('10');
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
    expect(redactValue(() => 1)).toBe('[function]');
  });
});

describe('PINO_REDACT_PATHS', () => {
  it('covers the headers that carry credentials', () => {
    for (const path of ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]']) {
      expect(PINO_REDACT_PATHS, path).toContain(path);
    }
  });

  it('covers common secret fields at the top and two levels down', () => {
    for (const field of ['password', 'token', 'credential', 'verifier', 'totpCode', 'recoveryCode', 'csrfToken']) {
      expect(PINO_REDACT_PATHS, field).toContain(field);
      expect(PINO_REDACT_PATHS, field).toContain(`*.${field}`);
      expect(PINO_REDACT_PATHS, field).toContain(`*.*.${field}`);
    }
  });
});
