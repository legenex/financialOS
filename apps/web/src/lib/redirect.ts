const BLOCKED = ['/login', '/locked', '/setup'];
const BASE = 'https://financialos.invalid';

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Only same-origin app paths are allowed as post-login destinations. */
export function safeRedirect(target: string | null | undefined, fallback = '/today'): string {
  if (!target || typeof target !== 'string') return fallback;
  if (!target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return fallback;
  if (hasControlCharacters(target)) return fallback;
  let url: URL;
  try {
    url = new URL(target, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  if (BLOCKED.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return fallback;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/launch/')) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
