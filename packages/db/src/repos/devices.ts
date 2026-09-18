import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Device, RevealableField } from '@financialos/contracts';
import { devicePairings, devices } from '../schema/security';
import { addDaysTo, addSeconds, ConflictError, iso, NotFoundError, tx, type DbOrTx } from './_util';

export type DeviceRow = typeof devices.$inferSelect;
export type DevicePairingRow = typeof devicePairings.$inferSelect;

export type PairingState = 'pending' | 'approved' | 'denied' | 'expired' | 'completed';

export function pairingState(row: DevicePairingRow, now = new Date()): PairingState {
  if (row.completedAt) return 'completed';
  if (row.deniedAt) return 'denied';
  if (row.expiresAt <= now) return 'expired';
  if (row.approvedAt) return 'approved';
  return 'pending';
}

export async function createPairing(
  db: DbOrTx,
  input: {
    installationId: string;
    verifierChallenge: string;
    userCodeHash: string;
    deviceLabel: string;
    extensionOrigin: string;
    extensionVersion: string;
    ttlSeconds: number;
    now?: Date;
  },
): Promise<DevicePairingRow> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(devicePairings)
    .values({
      installationId: input.installationId,
      verifierChallenge: input.verifierChallenge,
      userCodeHash: input.userCodeHash,
      deviceLabel: input.deviceLabel,
      extensionOrigin: input.extensionOrigin,
      extensionVersion: input.extensionVersion,
      createdAt: now,
      expiresAt: addSeconds(now, input.ttlSeconds),
    })
    .returning();
  if (!row) throw new Error('pairing insert returned no row');
  return row;
}

export async function getPairing(db: DbOrTx, id: string): Promise<DevicePairingRow | null> {
  const [row] = await db.select().from(devicePairings).where(eq(devicePairings.id, id)).limit(1);
  return row ?? null;
}

/** The pending (not approved, denied, completed, or expired) pairing for a user code. */
export async function findPendingPairingByUserCode(db: DbOrTx, userCodeHash: string, now = new Date()): Promise<DevicePairingRow | null> {
  const [row] = await db
    .select()
    .from(devicePairings)
    .where(
      and(
        eq(devicePairings.userCodeHash, userCodeHash),
        isNull(devicePairings.approvedAt),
        isNull(devicePairings.deniedAt),
        isNull(devicePairings.completedAt),
        gt(devicePairings.expiresAt, now),
      ),
    )
    .orderBy(desc(devicePairings.createdAt))
    .limit(1);
  return row ?? null;
}

export async function approvePairing(
  db: DbOrTx,
  id: string,
  input: { label: string; expiresInDays: number },
  now = new Date(),
): Promise<DevicePairingRow | null> {
  const [row] = await db
    .update(devicePairings)
    .set({ approvedAt: now, approvedLabel: input.label, approvedExpiresDays: input.expiresInDays })
    .where(
      and(
        eq(devicePairings.id, id),
        isNull(devicePairings.approvedAt),
        isNull(devicePairings.deniedAt),
        isNull(devicePairings.completedAt),
        gt(devicePairings.expiresAt, now),
      ),
    )
    .returning();
  return row ?? null;
}

export async function denyPairing(db: DbOrTx, id: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(devicePairings)
    .set({ deniedAt: now })
    .where(and(eq(devicePairings.id, id), isNull(devicePairings.completedAt), isNull(devicePairings.deniedAt)))
    .returning({ id: devicePairings.id });
  return rows.length > 0;
}

/** Increments and returns the attempt counter (used to cap completion polling). */
export async function incrementPairingAttempts(db: DbOrTx, id: string): Promise<number> {
  const [row] = await db
    .update(devicePairings)
    .set({ attempts: sql`${devicePairings.attempts} + 1` })
    .where(eq(devicePairings.id, id))
    .returning({ attempts: devicePairings.attempts });
  if (!row) throw new NotFoundError('pairing');
  return row.attempts;
}

/**
 * Completes an approved pairing exactly once: creates the device with the hashed
 * credential and links it to the pairing. The caller verifies the installation verifier
 * before calling. Returns null when the pairing is not in the approved state.
 */
export async function completePairing(
  db: DbOrTx,
  input: { pairingId: string; installationId: string; credentialHash: string; scopes: string[]; now?: Date },
): Promise<DeviceRow | null> {
  const now = input.now ?? new Date();
  return tx(db, async (t) => {
    const [pairing] = await t
      .select()
      .from(devicePairings)
      .where(eq(devicePairings.id, input.pairingId))
      .for('update')
      .limit(1);
    if (!pairing || pairing.installationId !== input.installationId) return null;
    if (pairingState(pairing, now) !== 'approved') return null;
    const [device] = await t
      .insert(devices)
      .values({
        label: pairing.approvedLabel ?? pairing.deviceLabel,
        kind: 'chrome_extension',
        extensionOrigin: pairing.extensionOrigin,
        installationId: pairing.installationId,
        credentialHash: input.credentialHash,
        scopes: input.scopes,
        revealedFields: [],
        createdAt: now,
        expiresAt: addDaysTo(now, pairing.approvedExpiresDays ?? 30),
      })
      .returning();
    if (!device) throw new Error('device insert returned no row');
    await t
      .update(devicePairings)
      .set({ completedAt: now, deviceId: device.id })
      .where(eq(devicePairings.id, pairing.id));
    return device;
  });
}

export async function deleteExpiredPairings(db: DbOrTx, retainSeconds = 86_400, now = new Date()): Promise<number> {
  const rows = await db
    .delete(devicePairings)
    .where(and(lt(devicePairings.expiresAt, addSeconds(now, -retainSeconds)), isNull(devicePairings.deviceId)))
    .returning({ id: devicePairings.id });
  return rows.length;
}

export async function listDevices(db: DbOrTx): Promise<DeviceRow[]> {
  return db.select().from(devices).orderBy(desc(devices.createdAt));
}

export async function getDevice(db: DbOrTx, id: string): Promise<DeviceRow | null> {
  const [row] = await db.select().from(devices).where(eq(devices.id, id)).limit(1);
  return row ?? null;
}

/** An unrevoked, unexpired device for a credential hash. */
export async function findActiveDeviceByCredentialHash(db: DbOrTx, credentialHash: string, now = new Date()): Promise<DeviceRow | null> {
  const [row] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.credentialHash, credentialHash), isNull(devices.revokedAt), gt(devices.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

export async function recordDeviceAccess(db: DbOrTx, id: string, now = new Date()): Promise<void> {
  await db
    .update(devices)
    .set({ lastAccessAt: now, accessCount: sql`${devices.accessCount} + 1` })
    .where(eq(devices.id, id));
}

export async function setDeviceRevealedFields(db: DbOrTx, id: string, fields: RevealableField[]): Promise<DeviceRow> {
  const unique = [...new Set(fields)];
  const [row] = await db
    .update(devices)
    .set({ revealedFields: unique })
    .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
    .returning();
  if (!row) throw new ConflictError('Device not found or revoked');
  return row;
}

export async function revokeDevice(db: DbOrTx, id: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(devices)
    .set({ revokedAt: now })
    .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
    .returning({ id: devices.id });
  return rows.length > 0;
}

export async function revokeAllDevices(db: DbOrTx, now = new Date()): Promise<number> {
  const rows = await db.update(devices).set({ revokedAt: now }).where(isNull(devices.revokedAt)).returning({ id: devices.id });
  return rows.length;
}

export function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    label: row.label,
    kind: 'chrome_extension',
    extensionOrigin: row.extensionOrigin,
    scopes: row.scopes,
    revealedFields: row.revealedFields as RevealableField[],
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    lastAccessAt: iso(row.lastAccessAt),
    revokedAt: iso(row.revokedAt),
    accessCount: row.accessCount,
  };
}
