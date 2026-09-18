import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

/** Associated data binding stored TOTP ciphertext to its purpose. */
export const TOTP_AAD = 'totp-secret';
export const TOTP_PERIOD_SECONDS = 30;

/** 160-bit Base32 secret (RFC 4226 recommendation). */
export function newTotpSecret(): string {
  return generateSecret({ length: 20 });
}

export function totpUri(issuer: string, label: string, secret: string): string {
  return generateURI({ issuer, label, secret });
}

export async function totpQrSvg(uri: string): Promise<string> {
  return QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
}

/** Base32 secret grouped in fours for manual entry. */
export function formatManualKey(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export type TotpCheck = { ok: true; step: number } | { ok: false };

/**
 * Verifies a 6-digit code within one time step either side of `now`. Codes from a step at or
 * before `lastUsedStep` are rejected (replay protection). Never throws.
 */
export async function verifyTotp(secret: string, code: string, now: Date, lastUsedStep: number | null): Promise<TotpCheck> {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const epoch = Math.floor(now.getTime() / 1000);
  const maxStep = Math.floor((epoch + TOTP_PERIOD_SECONDS) / TOTP_PERIOD_SECONDS);
  if (lastUsedStep !== null && lastUsedStep >= maxStep) return { ok: false };
  try {
    const result = await verify({
      secret,
      token: code,
      epoch,
      period: TOTP_PERIOD_SECONDS,
      epochTolerance: TOTP_PERIOD_SECONDS,
      ...(lastUsedStep !== null ? { afterTimeStep: lastUsedStep } : {}),
    });
    return result.valid && 'timeStep' in result ? { ok: true, step: result.timeStep } : { ok: false };
  } catch {
    return { ok: false };
  }
}
