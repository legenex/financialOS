/**
 * Redaction for logs, audit summaries, and error messages. Applied defensively: callers should
 * still avoid passing secrets, but anything that slips through is scrubbed here.
 */

export const REDACTED = '[redacted]';

/** Object keys whose values are always replaced, at any depth. Compared case-insensitively without separators. */
const SECRET_KEY_NAMES = new Set(
  [
    'password',
    'passwd',
    'newPassword',
    'currentPassword',
    'passphrase',
    'secret',
    'clientSecret',
    'bootstrapSecret',
    'token',
    'accessToken',
    'refreshToken',
    'idToken',
    'apiKey',
    'authorization',
    'cookie',
    'setCookie',
    'credential',
    'credentials',
    'verifier',
    'totpCode',
    'totpSecret',
    'recoveryCode',
    'recoveryCodes',
    'codes',
    'userCode',
    'csrfToken',
    'privateKey',
    'sessionToken',
    'otp',
    'pin',
    'cvv',
    'cardNumber',
    'accountNumber',
    'iban',
    'dek',
    'keyring',
    'encryptionKey',
  ].map((k) => k.toLowerCase()),
);

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_NAMES.has(key.replace(/[-_\s]/g, '').toLowerCase());
}

/**
 * Pino `redact.paths`. Covers request/response headers and common secret fields up to three levels.
 * The request serializer in the API additionally strips query strings from logged URLs.
 */
export const PINO_REDACT_PATHS: string[] = (() => {
  const headerPaths = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-csrf-token"]',
    'req.headers["proxy-authorization"]',
    'res.headers["set-cookie"]',
    'headers.authorization',
    'headers.cookie',
    'headers["set-cookie"]',
  ];
  const fields = [
    'password',
    'newPassword',
    'currentPassword',
    'secret',
    'clientSecret',
    'bootstrapSecret',
    'token',
    'accessToken',
    'refreshToken',
    'apiKey',
    'authorization',
    'cookie',
    'credential',
    'verifier',
    'totpCode',
    'recoveryCode',
    'codes',
    'userCode',
    'csrfToken',
    'privateKey',
  ];
  const paths = [...headerPaths];
  for (const f of fields) {
    paths.push(f, `*.${f}`, `*.*.${f}`);
  }
  return paths;
})();

const URL_IN_TEXT = /\b(?:https?|wss?|ftp|postgres(?:ql)?|redis|amqps?|mongodb(?:\+srv)?):\/\/[^\s"'<>`]+/gi;

/**
 * Removes userinfo, query string, and fragment from a URL. Query strings routinely carry
 * credentials (for example report-service tokens passed as `t=`), so they are never logged.
 */
export function redactUrl(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  const hadQuery = /[?]/.test(input);
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
    const url = new URL(input, hasScheme ? undefined : 'http://relative.invalid');
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    let out = hasScheme ? url.toString() : `${url.pathname}`;
    if (hasScheme && !input.includes('/', input.indexOf('://') + 3) && out.endsWith('/')) out = out.slice(0, -1);
    return hadQuery ? `${out}?${REDACTED}` : out;
  } catch {
    // Unparseable: strip anything that looks like userinfo and everything after ? or #.
    const noUserinfo = input.replace(/\/\/[^/@\s]*@/g, '//');
    const cut = noUserinfo.search(/[?#]/);
    return cut >= 0 ? `${noUserinfo.slice(0, cut)}${hadQuery ? `?${REDACTED}` : ''}` : noUserinfo;
  }
}

interface TextRule {
  re: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
}

const TEXT_RULES: TextRule[] = [
  // PEM private keys.
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: '[redacted-private-key]' },
  // URLs: drop userinfo and query strings.
  { re: URL_IN_TEXT, replace: (m) => redactUrl(m) },
  // Authorization schemes.
  { re: /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi, replace: (_m, scheme) => `${scheme} ${REDACTED}` },
  // Mercury-style and similar `secret-token:` credentials.
  { re: /secret-token:[^\s"'&,;]+/gi, replace: `secret-token:${REDACTED}` },
  // FinancialOS credentials.
  { re: /\bfos_(?:dev|agent)_[A-Za-z0-9_-]{8,}/g, replace: '[redacted-credential]' },
  // Common vendor key formats and JWTs.
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, replace: '[redacted-credential]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: '[redacted-credential]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '[redacted-credential]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[redacted-credential]' },
  { re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, replace: '[redacted-jwt]' },
  // key=value / key: value secrets outside URLs (form bodies, error strings, JSON fragments).
  {
    re: /(["']?\b(?:password|passwd|passphrase|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|t|verifier|credential)["']?\s*[:=]\s*["']?)([^\s"'&,;}]+)/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}`,
  },
  // Email addresses.
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: '[redacted-email]' },
  // IBAN-like: country code, check digits, 11-30 alphanumerics (optionally grouped by spaces).
  { re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, replace: '[redacted-iban]' },
  // Card-number-like groups (4-4-4-4 etc.) and any run of 8+ digits (account and card numbers).
  { re: /\b\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,4})?\b/g, replace: '[redacted-number]' },
  { re: /\b\d{8,}\b/g, replace: '[redacted-number]' },
];

/** Scrubs credentials, URLs with query strings, emails, IBAN-like strings, and long digit runs. */
export function redactText(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input.length > 64_000 ? `${input.slice(0, 64_000)}…[truncated]` : input;
  // Record ids (UUIDs) are not sensitive; shield them so digit rules do not mangle them.
  const shielded: string[] = [];
  out = out.replace(UUID_PATTERN, (m) => {
    shielded.push(m);
    return `\uE000${shielded.length - 1}\uE000`;
  });
  for (const rule of TEXT_RULES) {
    out = out.replace(rule.re, rule.replace as (substring: string, ...args: string[]) => string);
  }
  if (shielded.length) out = out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => shielded[Number(i)] ?? '');
  return out;
}

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Deep-copies a value, replacing secret-named keys and scrubbing every string. Bounded depth
 * and size so it is safe to call on arbitrary error details.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= 100) {
        out['…'] = '[truncated]';
        break;
      }
      out[k] = isSecretKey(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}
