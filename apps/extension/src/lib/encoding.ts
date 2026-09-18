import type { ExtEnv } from './env';

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes as base64url (43 characters). */
export function randomToken(env: ExtEnv, byteLength = 32): string {
  const bytes = env.randomBytes(byteLength);
  if (bytes.length !== byteLength) throw new Error('random source returned the wrong length');
  return base64url(bytes);
}

/** PKCE-style S256 challenge: base64url(SHA-256(ASCII verifier)). */
export async function challengeFor(env: ExtEnv, verifier: string): Promise<string> {
  return base64url(await env.sha256(new TextEncoder().encode(verifier)));
}
