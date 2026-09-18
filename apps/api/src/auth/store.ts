/**
 * Queries on the security tables that are shared by several route modules.
 */
import { eq } from 'drizzle-orm';
import { ownerAccount, settings, setupState, type Database, type DbOrTx } from '@financialos/db';
import { SESSION_IDLE_MAX_SECONDS } from '@financialos/contracts';
import type { Clock } from '../clock';

export type OwnerRow = typeof ownerAccount.$inferSelect;
export type SetupStateRow = typeof setupState.$inferSelect;

export const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;

export async function getOwner(db: DbOrTx): Promise<OwnerRow | null> {
  const [row] = await db.select().from(ownerAccount).limit(1);
  return row ?? null;
}

export async function getSetupState(db: DbOrTx): Promise<SetupStateRow | null> {
  const [row] = await db.select().from(setupState).where(eq(setupState.id, 1)).limit(1);
  return row ?? null;
}

/**
 * Creates the setup row on first start. While setup has not begun, the stored bootstrap hash
 * follows the file (the operator may regenerate the secret before using it). Once setup has
 * begun, the file is ignored.
 */
export async function ensureSetupState(db: Database, clock: Clock, bootstrapHash: string | null): Promise<SetupStateRow> {
  const now = clock.now();
  await db
    .insert(setupState)
    .values({ id: 1, state: 'awaiting_bootstrap_secret', bootstrapSecretHash: bootstrapHash, updatedAt: now })
    .onConflictDoNothing();
  const row = await getSetupState(db);
  if (!row) throw new Error('setup_state row is missing');
  if (row.state === 'awaiting_bootstrap_secret' && row.bootstrapSecretHash !== bootstrapHash) {
    const [updated] = await db
      .update(setupState)
      .set({ bootstrapSecretHash: bootstrapHash, updatedAt: now })
      .where(eq(setupState.id, 1))
      .returning();
    return updated ?? row;
  }
  return row;
}

export interface SettingsStore {
  getIdleTimeoutSeconds(): Promise<number>;
  setIdleTimeoutSeconds(seconds: number): Promise<void>;
  getPrivacyModeDefault(): Promise<boolean>;
}

/**
 * Key/value settings (`settings.key` text, `settings.value` jsonb). Values outside the allowed
 * range fall back to safe defaults; the idle timeout can never exceed the ten-minute cap.
 */
export class DbSettingsStore implements SettingsStore {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  async #get(key: string): Promise<unknown> {
    const [row] = await this.#db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    return row ? row.value : undefined;
  }

  async #set(key: string, value: unknown, updatedBy: string): Promise<void> {
    const now = this.#clock.now();
    await this.#db
      .insert(settings)
      .values({ key, value, updatedBy, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy, updatedAt: now } });
  }

  async getIdleTimeoutSeconds(): Promise<number> {
    const value = await this.#get('idleTimeoutSeconds');
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isInteger(n) || n < 60) return DEFAULT_IDLE_TIMEOUT_SECONDS;
    return Math.min(n, SESSION_IDLE_MAX_SECONDS);
  }

  async setIdleTimeoutSeconds(seconds: number): Promise<void> {
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > SESSION_IDLE_MAX_SECONDS) {
      throw new RangeError('idle timeout must be an integer between 60 and 600');
    }
    await this.#set('idleTimeoutSeconds', seconds, 'owner');
  }

  async getPrivacyModeDefault(): Promise<boolean> {
    return (await this.#get('privacyModeDefault')) === true;
  }
}
