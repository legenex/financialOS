/**
 * WebAuthn (passkeys) on @simplewebauthn/server.
 *
 * The RP ID is the hostname of the request's Origin, and that origin must be one of the
 * configured allowedOrigins. Challenges are stored server-side, expire after five minutes, and
 * are consumed exactly once (before verification, so a failed attempt burns the challenge).
 */
import type { FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { webauthnChallenges, webauthnCredentials, type Database, type DbOrTx } from '@financialos/db';
import { addSeconds, type Clock } from '../clock';
import { ApiError, errors } from '../errors';
import type { OwnerRow } from './store';

export const CHALLENGE_TTL_SECONDS = 300;
export type ChallengePurpose = 'register' | 'authenticate';
export type CredentialRow = typeof webauthnCredentials.$inferSelect;

export interface RelyingParty {
  origin: string;
  rpId: string;
}

/** Resolves the relying party from the request Origin. Rejects origins that are not configured. */
export function relyingPartyFor(req: FastifyRequest): RelyingParty {
  const origin = req.headers.origin;
  const allowed = req.server.fos.config.allowedOrigins;
  if (typeof origin !== 'string' || !allowed.includes(origin)) throw errors.origin();
  return { origin, rpId: new URL(origin).hostname };
}

function uuidBytes(id: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(id.replace(/-/g, ''), 'hex'));
}

function base64UrlJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length > 16_384 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Reads the challenge the browser signed, without trusting anything else in the response. */
export function challengeOf(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const inner = (response as { response?: unknown }).response;
  if (!inner || typeof inner !== 'object') return null;
  const clientData = base64UrlJson((inner as { clientDataJSON?: unknown }).clientDataJSON);
  const challenge = clientData?.challenge;
  return typeof challenge === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(challenge) ? challenge : null;
}

function isRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const inner = v.response as Record<string, unknown> | undefined;
  return typeof v.id === 'string' && v.type === 'public-key' && !!inner && typeof inner.attestationObject === 'string' && typeof inner.clientDataJSON === 'string';
}

function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const inner = v.response as Record<string, unknown> | undefined;
  return (
    typeof v.id === 'string' &&
    v.id.length <= 1024 &&
    v.type === 'public-key' &&
    !!inner &&
    typeof inner.authenticatorData === 'string' &&
    typeof inner.signature === 'string' &&
    typeof inner.clientDataJSON === 'string'
  );
}

/**
 * Accepts either `{ response: RegistrationResponseJSON, name? }` or a bare
 * RegistrationResponseJSON body.
 */
export function parseRegistrationBody(body: unknown): { response: RegistrationResponseJSON; name: string | null } {
  if (isRegistrationResponse(body)) return { response: body, name: null };
  if (body && typeof body === 'object') {
    const wrapped = body as { response?: unknown; name?: unknown };
    if (isRegistrationResponse(wrapped.response)) {
      const name = typeof wrapped.name === 'string' ? wrapped.name.trim().slice(0, 60) : '';
      return { response: wrapped.response, name: name || null };
    }
  }
  throw errors.badRequest('A passkey registration response is required.');
}

export function parseAuthenticationResponse(value: unknown): AuthenticationResponseJSON {
  if (isAuthenticationResponse(value)) return value;
  throw errors.badRequest('A passkey authentication response is required.');
}

export class WebAuthnService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #rpName: string;

  constructor(db: Database, clock: Clock, rpName: string) {
    this.#db = db;
    this.#clock = clock;
    this.#rpName = rpName;
  }

  async #storeChallenge(purpose: ChallengePurpose, challenge: string, rp: RelyingParty, binding: string): Promise<void> {
    const now = this.#clock.now();
    await this.#db.insert(webauthnChallenges).values({
      purpose,
      challenge,
      rpId: rp.rpId,
      origin: rp.origin,
      binding,
      createdAt: now,
      expiresAt: addSeconds(now, CHALLENGE_TTL_SECONDS),
    });
  }

  /** Atomically marks a matching, unexpired, unused challenge as consumed. */
  async consumeChallenge(purpose: ChallengePurpose, challenge: string, rp: RelyingParty, binding: string): Promise<boolean> {
    const now = this.#clock.now();
    const rows = await this.#db
      .update(webauthnChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(webauthnChallenges.challenge, challenge),
          eq(webauthnChallenges.purpose, purpose),
          eq(webauthnChallenges.rpId, rp.rpId),
          eq(webauthnChallenges.origin, rp.origin),
          eq(webauthnChallenges.binding, binding),
          isNull(webauthnChallenges.consumedAt),
          gt(webauthnChallenges.expiresAt, now),
        ),
      )
      .returning({ id: webauthnChallenges.id });
    return rows.length === 1;
  }

  async activeCredentials(rpId?: string): Promise<CredentialRow[]> {
    const where = rpId
      ? and(isNull(webauthnCredentials.revokedAt), eq(webauthnCredentials.rpId, rpId))
      : isNull(webauthnCredentials.revokedAt);
    return this.#db.select().from(webauthnCredentials).where(where);
  }

  async registrationOptions(owner: OwnerRow, rp: RelyingParty, binding: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await this.activeCredentials(rp.rpId);
    const options = await generateRegistrationOptions({
      rpName: this.#rpName,
      rpID: rp.rpId,
      userName: owner.displayName,
      userDisplayName: owner.displayName,
      userID: uuidBytes(owner.id),
      attestationType: 'none',
      timeout: CHALLENGE_TTL_SECONDS * 1000,
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    await this.#storeChallenge('register', options.challenge, rp, binding);
    return options;
  }

  /** Verifies a registration and stores the credential. */
  async verifyRegistration(body: unknown, rp: RelyingParty, binding: string, defaultName: string, tx?: DbOrTx): Promise<CredentialRow> {
    const { response, name } = parseRegistrationBody(body);
    const challenge = challengeOf(response);
    if (!challenge || !(await this.consumeChallenge('register', challenge, rp, binding))) {
      throw new ApiError(400, 'passkey_challenge_invalid', 'The passkey request expired or was already used. Start again.');
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
    } catch {
      throw new ApiError(400, 'passkey_verification_failed', 'The passkey could not be verified.');
    }
    if (!verification.verified) throw new ApiError(400, 'passkey_verification_failed', 'The passkey could not be verified.');
    const info = verification.registrationInfo;
    const now = this.#clock.now();
    const [row] = await (tx ?? this.#db)
      .insert(webauthnCredentials)
      .values({
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: info.credential.counter,
        transports: (info.credential.transports ?? []).slice(0, 8),
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        rpId: rp.rpId,
        name: name ?? defaultName,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ApiError(409, 'passkey_exists', 'This passkey is already registered.');
    return row;
  }

  async authenticationOptions(rp: RelyingParty): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const creds = await this.activeCredentials(rp.rpId);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports })),
      userVerification: 'required',
      timeout: CHALLENGE_TTL_SECONDS * 1000,
    });
    await this.#storeChallenge('authenticate', options.challenge, rp, 'login');
    return options;
  }

  /**
   * Verifies an assertion with user verification. Returns the credential on success, or a
   * failure reason (never throws for authenticator-side problems).
   */
  async verifyAuthentication(
    value: unknown,
    rp: RelyingParty,
  ): Promise<{ ok: true; credential: CredentialRow } | { ok: false; reason: 'challenge' | 'unknown_credential' | 'verification' | 'counter_regression'; credentialId: string | null }> {
    const response = parseAuthenticationResponse(value);
    const challenge = challengeOf(response);
    if (!challenge || !(await this.consumeChallenge('authenticate', challenge, rp, 'login'))) {
      return { ok: false, reason: 'challenge', credentialId: null };
    }
    const [credential] = await this.#db
      .select()
      .from(webauthnCredentials)
      .where(and(eq(webauthnCredentials.credentialId, response.id), eq(webauthnCredentials.rpId, rp.rpId), isNull(webauthnCredentials.revokedAt)))
      .limit(1);
    if (!credential) return { ok: false, reason: 'unknown_credential', credentialId: null };
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      const counterProblem = err instanceof Error && /counter value/i.test(err.message);
      return { ok: false, reason: counterProblem ? 'counter_regression' : 'verification', credentialId: credential.id };
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      return { ok: false, reason: 'verification', credentialId: credential.id };
    }
    const now = this.#clock.now();
    const [updated] = await this.#db
      .update(webauthnCredentials)
      .set({
        counter: verification.authenticationInfo.newCounter,
        backedUp: verification.authenticationInfo.credentialBackedUp,
        lastUsedAt: now,
      })
      .where(eq(webauthnCredentials.id, credential.id))
      .returning();
    return { ok: true, credential: updated ?? credential };
  }

  async revoke(id: string): Promise<boolean> {
    const rows = await this.#db
      .update(webauthnCredentials)
      .set({ revokedAt: this.#clock.now() })
      .where(and(eq(webauthnCredentials.id, id), isNull(webauthnCredentials.revokedAt)))
      .returning({ id: webauthnCredentials.id });
    return rows.length === 1;
  }

  /** Removes challenges that expired or were used more than a day ago. */
  async housekeeping(): Promise<void> {
    const cutoff = addSeconds(this.#clock.now(), -24 * 3600);
    await this.#db
      .delete(webauthnChallenges)
      .where(or(lt(webauthnChallenges.expiresAt, cutoff), lt(webauthnChallenges.consumedAt, cutoff)));
  }
}
