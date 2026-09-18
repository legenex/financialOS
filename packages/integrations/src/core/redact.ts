/**
 * Local redaction helpers for integration logs and errors. Query-string values are always removed, because
 * several providers (IBKR Flex, some custom sources) carry tokens in the URL.
 */

const SENSITIVE_KEY = /(token|secret|password|passwd|pwd|key|auth|signature|sig|session|cookie|code|credential|^t$|^q$)/i;

/** Returns origin + path, with query parameter names kept and every value replaced. */
export function redactUrl(input: string | URL): string {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.href);
  } catch {
    return '[invalid-url]';
  }
  const names = [...new Set([...url.searchParams.keys()])];
  const query = names.length ? `?${names.map((n) => `${encodeURIComponent(n)}=[redacted]`).join('&')}` : '';
  return `${url.protocol}//${url.host}${url.pathname}${query}`;
}

const TOKEN_PATTERNS: RegExp[] = [
  /secret-token:[A-Za-z0-9_\-:]+/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /([?&](?:t|token|access_token|refresh_token|api_key|apikey|key|code|client_secret)=)[^&\s"']+/gi,
];

/** Removes known secret values and token-shaped strings from free text. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out;
}

/** Deep-redacts log fields: sensitive keys are masked and string values are scrubbed. */
export function redactFields(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactFields(v, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) && typeof v === 'string' ? '[redacted]' : redactFields(v, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

/** Masks an account identifier to its last four characters. */
export function maskIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/\s+/g, '');
  if (clean.length <= 4) return `****${clean}`.slice(-8);
  return `****${clean.slice(-4)}`;
}
