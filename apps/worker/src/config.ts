import { readFileSync } from 'node:fs';
import { z } from 'zod';

const AbsolutePath = z.string().min(1).refine((p) => p.startsWith('/'), 'Expected an absolute path');

/**
 * Worker runtime configuration. The worker reads the SAME `app-config.json` file as the API
 * (FOS_CONFIG_FILE) — see coordination notes — but only cares about a subset of its keys, so this
 * schema is deliberately non-strict (unknown keys from the API's config are ignored).
 */
export const WorkerConfigSchema = z
  .object({
    environment: z.enum(['production', 'test', 'development']),
    keyringPath: AbsolutePath,
    documentsDir: AbsolutePath,
    /** Where backup-now writes artifacts. Not needed by every subcommand (e.g. `migrate`, `health`). */
    backupDir: AbsolutePath.optional(),
    backupKeyPath: AbsolutePath.optional(),
    backupDbUser: z.string().min(1).default('fos_backup'),
    backupDbPasswordFile: AbsolutePath.optional(),
    /** Directory where ops scripts drop status JSON; the worker does not write here itself today. */
    opsStatusDir: AbsolutePath.optional(),
    database: z.object({
      url: z.string().min(1),
      role: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default('fos_worker'),
      passwordFile: AbsolutePath.optional(),
    }),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    secretFilesGroupReadable: z.boolean().default(false),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.environment === 'production' && !cfg.database.passwordFile) {
      ctx.addIssue({ code: 'custom', path: ['database', 'passwordFile'], message: 'database.passwordFile is required in production' });
    }
  });

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

const STRING_OVERRIDES = {
  FOS_ENVIRONMENT: 'environment',
  FOS_KEYRING_FILE: 'keyringPath',
  FOS_DOCUMENTS_DIR: 'documentsDir',
  FOS_BACKUP_DIR: 'backupDir',
  FOS_BACKUP_KEY_FILE: 'backupKeyPath',
  FOS_BACKUP_DB_USER: 'backupDbUser',
  FOS_BACKUP_DB_PASSWORD_FILE: 'backupDbPasswordFile',
  FOS_OPS_STATUS_DIR: 'opsStatusDir',
  FOS_LOG_LEVEL: 'logLevel',
} as const;

function normalizeRole(value: string): string {
  return value.startsWith('fos_') ? value : `fos_${value}`;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function parseWorkerConfig(raw: unknown, env: NodeJS.ProcessEnv = {}): WorkerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('Configuration must be a JSON object');
  const merged: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [envName, key] of Object.entries(STRING_OVERRIDES)) {
    const value = env[envName];
    if (value) merged[key] = value;
  }
  const db = { ...((merged.database ?? {}) as Record<string, unknown>) };
  if (env.FOS_DATABASE_URL) db.url = env.FOS_DATABASE_URL;
  if (env.FOS_DATABASE_ROLE) db.role = normalizeRole(env.FOS_DATABASE_ROLE);
  if (env.FOS_DB_PASSWORD_FILE) db.passwordFile = env.FOS_DB_PASSWORD_FILE;
  merged.database = db;
  if (env.FOS_SECRET_FILES_GROUP_READABLE === '1') merged.secretFilesGroupReadable = true;
  const result = WorkerConfigSchema.safeParse(merged);
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid runtime configuration: ${summary}`);
  }
  return result.data;
}

/** Reads the JSON file named by FOS_CONFIG_FILE. */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const path = env.FOS_CONFIG_FILE;
  if (!path) throw new ConfigError('FOS_CONFIG_FILE is not set');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError('Configuration file could not be read (FOS_CONFIG_FILE)');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError('Configuration file is not valid JSON');
  }
  return parseWorkerConfig(raw, env);
}
