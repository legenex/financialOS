import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { z } from 'zod';

const isLoopbackHost = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

/** An exact origin (`scheme://host[:port]`) with no path, query, or trailing slash. */
export const OriginString = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:' || url.protocol === 'http:');
  } catch {
    return false;
  }
}, 'Expected an exact origin such as https://finance.example.test');

const Cidr = z.string().refine((value) => {
  const [addr, bits, ...rest] = value.split('/');
  if (rest.length || !addr || !isIP(addr)) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && n >= 0 && n <= (isIP(addr) === 6 ? 128 : 32);
}, 'Expected an IP address or CIDR');

/** Chrome extension ids are 32 characters a-p. */
export const ExtensionId = z.string().regex(/^[a-p]{32}$/, 'Expected a Chrome extension id');

const AbsolutePath = z.string().min(1).refine((p) => p.startsWith('/'), 'Expected an absolute path');

export const RuntimeConfigSchema = z
  .object({
    environment: z.enum(['production', 'test', 'development']),
    listen: z
      .object({ host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(3000) })
      .default({ host: '127.0.0.1', port: 3000 }),
    canonicalOrigin: OriginString,
    allowedOrigins: z.array(OriginString).min(1),
    trustedProxyCidrs: z.array(Cidr).default([]),
    rpName: z.string().min(1).max(64).default('FinancialOS'),
    webDistDir: AbsolutePath,
    extensionPackagePath: AbsolutePath,
    allowedExtensionIds: z.array(ExtensionId).default([]),
    keyringPath: AbsolutePath,
    sessionPepperPath: AbsolutePath,
    bootstrapHashPath: AbsolutePath,
    database: z.object({
      url: z.string().min(1),
      role: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default('fos_app'),
      passwordFile: AbsolutePath.optional(),
    }),
    documentsDir: AbsolutePath,
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    publicBaseForOAuthCallbacks: OriginString,
    /** Directory where ops scripts drop status JSON (route, restore verification, release, disk). */
    opsStatusDir: AbsolutePath.optional(),
    /** Secret files may be group-readable (0640) when containers share the operator's group. */
    secretFilesGroupReadable: z.boolean().default(false),
    bodyLimitBytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.allowedOrigins.includes(cfg.canonicalOrigin)) {
      ctx.addIssue({ code: 'custom', path: ['allowedOrigins'], message: 'allowedOrigins must include canonicalOrigin' });
    }
    for (const [i, origin] of cfg.allowedOrigins.entries()) {
      const url = new URL(origin);
      if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
        ctx.addIssue({ code: 'custom', path: ['allowedOrigins', i], message: 'Plain HTTP is only allowed for loopback origins' });
      }
    }
    let dbUrl: URL | null = null;
    try {
      dbUrl = new URL(cfg.database.url);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['database', 'url'], message: 'Invalid database URL' });
    }
    if (dbUrl && dbUrl.password && cfg.environment === 'production') {
      ctx.addIssue({ code: 'custom', path: ['database', 'url'], message: 'Put the database password in database.passwordFile, not in the URL' });
    }
    if (cfg.environment === 'production' && !cfg.database.passwordFile) {
      ctx.addIssue({ code: 'custom', path: ['database', 'passwordFile'], message: 'database.passwordFile is required in production' });
    }
  });

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/** Environment variables that override top-level config values (container interface). */
const STRING_OVERRIDES = {
  FOS_ENVIRONMENT: 'environment',
  FOS_KEYRING_FILE: 'keyringPath',
  FOS_SESSION_PEPPER_FILE: 'sessionPepperPath',
  FOS_BOOTSTRAP_HASH_FILE: 'bootstrapHashPath',
  FOS_DOCUMENTS_DIR: 'documentsDir',
  FOS_EXTENSION_PACKAGE: 'extensionPackagePath',
  FOS_OPS_STATUS_DIR: 'opsStatusDir',
  FOS_WEB_DIST_DIR: 'webDistDir',
  FOS_LOG_LEVEL: 'logLevel',
} as const;

/** `FOS_DATABASE_ROLE=app` names the role `fos_app`. */
function normalizeRole(value: string): string {
  return value.startsWith('fos_') ? value : `fos_${value}`;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function parseRuntimeConfig(raw: unknown, env: NodeJS.ProcessEnv = {}): RuntimeConfig {
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
  const listen = { ...((merged.listen ?? {}) as Record<string, unknown>) };
  if (env.FOS_HOST) listen.host = env.FOS_HOST;
  if (env.FOS_PORT) {
    const port = Number(env.FOS_PORT);
    if (!Number.isInteger(port)) throw new ConfigError('FOS_PORT must be an integer');
    listen.port = port;
  }
  merged.listen = listen;
  if (env.FOS_SECRET_FILES_GROUP_READABLE === '1') merged.secretFilesGroupReadable = true;
  const result = RuntimeConfigSchema.safeParse(merged);
  if (!result.success) {
    const summary = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid runtime configuration: ${summary}`);
  }
  return result.data;
}

/** Reads the JSON file named by FOS_CONFIG_FILE. */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
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
  return parseRuntimeConfig(raw, env);
}

/** Allowed extension origins derived from configured ids. */
export function extensionOrigins(config: Pick<RuntimeConfig, 'allowedExtensionIds'>): string[] {
  return config.allowedExtensionIds.map((id) => `chrome-extension://${id}`);
}
