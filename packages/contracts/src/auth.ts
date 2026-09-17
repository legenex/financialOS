import { z } from 'zod';
import { Id, IsoDateTime } from './common';

/** Hard limits. The server enforces them; clients only use them for UX timers. */
export const SESSION_ABSOLUTE_SECONDS = 600;
export const SESSION_IDLE_MAX_SECONDS = 600;
export const SESSION_WARNING_SECONDS = 60;

export const SessionInfo = z.object({
  authenticated: z.literal(true),
  sessionId: z.string(),
  ownerName: z.string(),
  authenticatedAt: IsoDateTime,
  absoluteExpiresAt: IsoDateTime,
  idleExpiresAt: IsoDateTime,
  serverNow: IsoDateTime,
  csrfToken: z.string(),
  authMethod: z.enum(['password_totp', 'password_recovery_code', 'passkey']),
  privacyMode: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const SetupStatus = z.object({
  state: z.enum(['awaiting_bootstrap_secret', 'in_progress', 'sealed']),
  steps: z.object({
    owner: z.boolean(),
    totp: z.boolean(),
    recoveryCodes: z.boolean(),
    passkey: z.boolean(),
  }),
  rpId: z.string(),
  origin: z.string(),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

export const SetupBeginInput = z.object({
  bootstrapSecret: z.string().min(32).max(256),
});
export type SetupBeginInput = z.infer<typeof SetupBeginInput>;

export const PASSWORD_MIN_LENGTH = 15;

export const SetupOwnerInput = z.object({
  displayName: z.string().min(1).max(80),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(512),
});
export type SetupOwnerInput = z.infer<typeof SetupOwnerInput>;

export const TotpEnrollment = z.object({
  otpauthUri: z.string(),
  qrSvg: z.string(),
  manualKey: z.string(),
});
export type TotpEnrollment = z.infer<typeof TotpEnrollment>;

export const TotpVerifyInput = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TotpVerifyInput = z.infer<typeof TotpVerifyInput>;

export const RecoveryCodes = z.object({ codes: z.array(z.string()).length(10) });
export type RecoveryCodes = z.infer<typeof RecoveryCodes>;

export const PasswordLoginInput = z.object({
  password: z.string().min(1).max(512),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().min(8).max(40).optional(),
  launchId: z.string().max(100).optional(),
});
export type PasswordLoginInput = z.infer<typeof PasswordLoginInput>;

export const PasskeyLoginFinishInput = z.object({
  /** AuthenticationResponseJSON from @simplewebauthn/browser, validated server-side. */
  response: z.record(z.string(), z.unknown()),
  launchId: z.string().max(100).optional(),
});
export type PasskeyLoginFinishInput = z.infer<typeof PasskeyLoginFinishInput>;

export const LoginResult = z.object({
  session: SessionInfo,
  redirectTo: z.string().nullable(),
});
export type LoginResult = z.infer<typeof LoginResult>;

export const LaunchInfo = z.object({
  launchId: z.string(),
  targetLabel: z.string(),
  expiresAt: IsoDateTime,
  requiresFreshAuthentication: z.literal(true),
});
export type LaunchInfo = z.infer<typeof LaunchInfo>;

export const PasskeyCredential = z.object({
  id: Id,
  name: z.string(),
  rpId: z.string(),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
  backedUp: z.boolean(),
});
export type PasskeyCredential = z.infer<typeof PasskeyCredential>;

export const SessionListItem = z.object({
  id: z.string(),
  current: z.boolean(),
  authMethod: z.string(),
  createdAt: IsoDateTime,
  absoluteExpiresAt: IsoDateTime,
  userAgent: z.string().nullable(),
  revokedAt: IsoDateTime.nullable(),
  revokeReason: z.string().nullable(),
});
export type SessionListItem = z.infer<typeof SessionListItem>;

export const SecurityOverview = z.object({
  passkeys: z.array(PasskeyCredential),
  totpEnabled: z.boolean(),
  recoveryCodesRemaining: z.number().int(),
  sessions: z.array(SessionListItem),
  idleTimeoutSeconds: z.number().int(),
  absoluteTimeoutSeconds: z.literal(SESSION_ABSOLUTE_SECONDS),
});
export type SecurityOverview = z.infer<typeof SecurityOverview>;

export const PasswordChangeInput = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(512),
  totpCode: z.string().regex(/^\d{6}$/),
});
export type PasswordChangeInput = z.infer<typeof PasswordChangeInput>;
