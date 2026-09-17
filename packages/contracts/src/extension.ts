import { z } from 'zod';
import { Id, IsoDateTime } from './common';

/** Paths inside the app that a launch request may redirect to after fresh authentication. */
export const LAUNCH_TARGETS = {
  today: { path: '/today', label: 'Today' },
  plan: { path: '/plan', label: 'Plan' },
  goals: { path: '/plan/goals', label: 'Goals' },
  commitments: { path: '/plan/commitments', label: 'Upcoming commitments' },
  money: { path: '/money', label: 'Money' },
  coach: { path: '/coach', label: 'Coach' },
  inbox: { path: '/inbox', label: 'Exception inbox' },
  connections: { path: '/connections', label: 'Connections' },
} as const;
export type LaunchTarget = keyof typeof LAUNCH_TARGETS;
export const LaunchTargetKey = z.enum(Object.keys(LAUNCH_TARGETS) as [LaunchTarget, ...LaunchTarget[]]);

export const DEVICE_SCOPES = ['glance:read'] as const;

export const RevealableField = z.enum(['safe_to_spend', 'budget_remaining', 'goal_amounts', 'due_amounts']);
export type RevealableField = z.infer<typeof RevealableField>;

export const PairStartInput = z.object({
  installationId: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  /** base64url(SHA-256(installation verifier)). The verifier never leaves the extension until completion. */
  verifierChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  deviceLabel: z.string().min(1).max(60),
  extensionVersion: z.string().max(20),
});
export type PairStartInput = z.infer<typeof PairStartInput>;

export const PairStartResult = z.object({
  pairingId: z.string(),
  userCode: z.string(),
  expiresAt: IsoDateTime,
  approveUrlPath: z.literal('/settings/devices/pair'),
});
export type PairStartResult = z.infer<typeof PairStartResult>;

export const PairApproveInput = z.object({
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  deviceLabel: z.string().min(1).max(60),
  expiresInDays: z.number().int().min(1).max(90),
});
export type PairApproveInput = z.infer<typeof PairApproveInput>;

export const PairCompleteInput = z.object({
  pairingId: z.string(),
  installationId: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
});
export type PairCompleteInput = z.infer<typeof PairCompleteInput>;

export const PairCompleteResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), retryAfterSeconds: z.number().int() }),
  z.object({ status: z.literal('approved'), deviceId: Id, credential: z.string(), expiresAt: IsoDateTime, scopes: z.array(z.string()) }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('denied') }),
]);
export type PairCompleteResult = z.infer<typeof PairCompleteResult>;

/** Masked-by-default glance. Amount fields are present only when the owner enabled them for this device. */
export const GlanceResponse = z.object({
  generatedAt: IsoDateTime,
  validUntil: IsoDateTime,
  privacy: z.object({ masked: z.boolean(), revealedFields: z.array(RevealableField) }),
  spending: z.object({
    status: z.enum(['on_track', 'watch', 'over', 'unknown']),
    periodLabel: z.string(),
    percentOfPlanUsed: z.number().int().min(0).max(999).nullable(),
    percentOfPeriodElapsed: z.number().int().min(0).max(100),
    safeToSpend: z.object({ amount: z.string(), currency: z.string() }).nullable(),
    safeToSpendStatus: z.enum(['ok', 'provisional', 'insufficient_data']),
    budgetRemaining: z.object({ amount: z.string(), currency: z.string() }).nullable(),
  }),
  goals: z
    .array(
      z.object({
        label: z.string(),
        percent: z.number().int().min(0).max(100),
        amount: z.object({ amount: z.string(), currency: z.string() }).nullable(),
      }),
    )
    .max(3),
  dueSoon: z.object({
    count: z.number().int(),
    windowDays: z.number().int(),
    nextLabel: z.string().nullable(),
    total: z.object({ amount: z.string(), currency: z.string() }).nullable(),
  }),
  nudge: z.object({ text: z.string().max(160), kind: z.enum(['review', 'reconcile', 'connect', 'goal', 'calm']) }),
  freshness: z.object({ state: z.enum(['fresh', 'aging', 'stale', 'unknown']), lastDataAt: IsoDateTime.nullable() }),
  attention: z.object({ openExceptions: z.number().int() }),
});
export type GlanceResponse = z.infer<typeof GlanceResponse>;

export const Device = z.object({
  id: Id,
  label: z.string(),
  kind: z.literal('chrome_extension'),
  extensionOrigin: z.string(),
  scopes: z.array(z.string()),
  revealedFields: z.array(RevealableField),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  lastAccessAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
  accessCount: z.number().int(),
});
export type Device = z.infer<typeof Device>;

export const DevicePrivacyInput = z.object({
  revealedFields: z.array(RevealableField).max(4),
  acknowledgeRisk: z.literal(true),
});
export type DevicePrivacyInput = z.infer<typeof DevicePrivacyInput>;
