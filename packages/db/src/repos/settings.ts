import { eq, inArray } from 'drizzle-orm';
import { AppSettings } from '@financialos/contracts';
import { settings } from '../schema/system';
import { InvalidError, tx, type DbOrTx } from './_util';

export type SettingRow = typeof settings.$inferSelect;
export type AppSettingsValue = AppSettings;
export type AppSettingKey = keyof AppSettings;

/**
 * Defaults for every AppSettings key. Migration 0003 inserts the same values when absent;
 * a unit test keeps the two in sync.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  reportingCurrency: 'USD',
  budgetCurrency: 'ZAR',
  reportingTimezone: 'Africa/Johannesburg',
  safeToSpendHorizonDays: 30,
  safeToSpendHorizonBasis: 'fixed_days',
  includeNearCashInSafeToSpend: false,
  runwayMinimumHistoryMonths: 3,
  staleAfterHours: 48,
  idleTimeoutSeconds: 300,
  privacyModeDefault: true,
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  weekStartsOn: 'monday',
  cloudAiAllowed: false,
  publicMarketDataEnabled: false,
};

export const APP_SETTING_KEYS = Object.keys(DEFAULT_APP_SETTINGS) as AppSettingKey[];

export async function getSetting(db: DbOrTx, key: string): Promise<unknown> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row ? row.value : undefined;
}

export async function setSetting(db: DbOrTx, key: string, value: unknown, updatedBy = 'owner'): Promise<void> {
  if (value === undefined) throw new InvalidError('A setting value cannot be undefined');
  const now = new Date();
  await db
    .insert(settings)
    .values({ key, value, updatedBy, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy, updatedAt: now } });
}

/** Inserts a setting only when it does not exist yet. Returns true when inserted. */
export async function setSettingIfAbsent(db: DbOrTx, key: string, value: unknown, updatedBy = 'system'): Promise<boolean> {
  const rows = await db
    .insert(settings)
    .values({ key, value, updatedBy })
    .onConflictDoNothing({ target: settings.key })
    .returning({ key: settings.key });
  return rows.length > 0;
}

/**
 * Reads AppSettings. Missing or invalid stored values fall back to the defaults and are
 * reported in `invalidKeys` so callers can surface them.
 */
export async function getAppSettingsWithDiagnostics(db: DbOrTx): Promise<{ settings: AppSettings; invalidKeys: AppSettingKey[] }> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, APP_SETTING_KEYS));
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const result: Record<string, unknown> = {};
  const invalidKeys: AppSettingKey[] = [];
  for (const key of APP_SETTING_KEYS) {
    const fallback = DEFAULT_APP_SETTINGS[key];
    if (!stored.has(key)) {
      result[key] = fallback;
      continue;
    }
    const parsed = AppSettings.shape[key].safeParse(stored.get(key));
    if (parsed.success) {
      result[key] = parsed.data;
    } else {
      result[key] = fallback;
      invalidKeys.push(key);
    }
  }
  return { settings: AppSettings.parse(result), invalidKeys };
}

export async function getAppSettings(db: DbOrTx): Promise<AppSettings> {
  return (await getAppSettingsWithDiagnostics(db)).settings;
}

/** Validates and stores a partial AppSettings update in one transaction. */
export async function updateAppSettings(db: DbOrTx, patch: Partial<AppSettings>, updatedBy = 'owner'): Promise<AppSettings> {
  const parsed = AppSettings.partial().strict().safeParse(patch);
  if (!parsed.success) throw new InvalidError('Invalid settings update');
  return tx(db, async (t) => {
    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined) await setSetting(t, key, value, updatedBy);
    }
    return getAppSettings(t);
  });
}

/** Inserts defaults for any missing AppSettings keys (never overwrites). */
export async function ensureDefaultSettings(db: DbOrTx): Promise<number> {
  let inserted = 0;
  for (const key of APP_SETTING_KEYS) {
    if (await setSettingIfAbsent(db, key, DEFAULT_APP_SETTINGS[key], 'system')) inserted += 1;
  }
  return inserted;
}

export async function listSettingRows(db: DbOrTx): Promise<SettingRow[]> {
  return db.select().from(settings);
}
