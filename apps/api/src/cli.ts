/**
 * Operations CLI (bundled to dist/cli.mjs).
 *
 *   keys:generate --out <file> [--rotate] [--mode 0600|0640|0400|0440]
 *       Writes a new AES-256-GCM keyring. With --rotate, adds a key to an existing keyring and
 *       makes it active (old keys stay for decryption).
 *   pepper:generate --out <file> [--mode ...]
 *       Writes a new session pepper (refuses to overwrite).
 *   bootstrap-secret:hash
 *       Reads a bootstrap secret from stdin and prints its SHA-256 (hex). Nothing else is printed.
 *   sessions:revoke-all
 *       Emergency: revokes every owner web session (uses FOS_CONFIG_FILE for the database).
 *   setup:restart
 *       Resets an unsealed, stuck setup so a new bootstrap secret can be used. Refuses once sealed.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { eq, isNull } from 'drizzle-orm';
import {
  auditEvents,
  createDb,
  ownerAccount,
  recoveryCodes,
  sessions,
  setupState,
  webauthnChallenges,
  webauthnCredentials,
} from '@financialos/db';
import { generateKeyringFile, Keyring, type KeyringFile } from '@financialos/security/crypto';
import { redactText } from '@financialos/security/redact';
import { sha256Hex } from '@financialos/security/tokens';
import { loadRuntimeConfig } from './config';
import { loadBootstrapHash, readSecretFile } from './secrets';

const MODES: Record<string, number> = { '0600': 0o600, '0640': 0o640, '0400': 0o400, '0440': 0o440 };

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`financialos-cli: ${message}\n`);
  process.exit(1);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) fail(`${name} needs a value`);
  return value;
}

function modeOption(args: string[]): number {
  const raw = option(args, '--mode') ?? '0600';
  const mode = MODES[raw];
  if (mode === undefined) fail('--mode must be one of 0600, 0640, 0400, 0440');
  return mode;
}

/** Writes via a temporary file in the same directory, then renames (never a partial file). */
function writeSecretFileAtomic(path: string, content: string, mode: number): void {
  const tmp = join(dirname(path), `.${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, content, { mode, flag: 'wx' });
  renameSync(tmp, path);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > 4096) fail('input is too long');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function keysGenerate(args: string[]): void {
  const path = option(args, '--out') ?? fail('--out <file> is required');
  const mode = modeOption(args);
  const rotate = args.includes('--rotate');
  if (rotate) {
    if (!existsSync(path)) fail('--rotate needs an existing keyring file');
    const existing = JSON.parse(readFileSync(path, 'utf8')) as KeyringFile;
    new Keyring(existing);
    const next = generateKeyringFile(existing);
    writeSecretFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, mode);
    out(`keyring rotated; active key is now ${next.active} (${Object.keys(next.keys).length} keys kept)`);
    return;
  }
  if (existsSync(path)) fail('refusing to overwrite an existing keyring (use --rotate to add a key)');
  const file = generateKeyringFile();
  writeSecretFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, mode);
  out(`keyring written with active key ${file.active}`);
}

function pepperGenerate(args: string[]): void {
  const path = option(args, '--out') ?? fail('--out <file> is required');
  if (existsSync(path)) fail('refusing to overwrite an existing pepper file');
  writeSecretFileAtomic(path, `${randomBytes(48).toString('base64url')}\n`, modeOption(args));
  out('session pepper written');
}

async function bootstrapHash(): Promise<void> {
  const secret = (await readStdin()).replace(/\r?\n$/, '');
  if (secret.length < 32 || secret.length > 256) fail('the bootstrap secret must be 32 to 256 characters');
  out(sha256Hex(secret));
}

function openDatabase() {
  const config = loadRuntimeConfig();
  const password = config.database.passwordFile ? readSecretFile(config.database.passwordFile, 'database password') : undefined;
  const handle = createDb({ url: config.database.url, ...(password !== undefined ? { password } : {}), applicationName: 'financialos-cli', max: 1 });
  return { config, handle };
}

async function sessionsRevokeAll(): Promise<void> {
  const { handle } = openDatabase();
  try {
    const now = new Date();
    const rows = await handle.db.transaction(async (tx) => {
      const revoked = await tx
        .update(sessions)
        .set({ revokedAt: now, revokeReason: 'ops_revoke_all' })
        .where(isNull(sessions.revokedAt))
        .returning({ id: sessions.id });
      await tx.insert(auditEvents).values({
        occurredAt: now,
        actorType: 'system',
        actorId: 'cli',
        action: 'auth.sessions_revoked_by_operator',
        objectType: 'session',
        summary: 'All owner sessions revoked from the operations CLI',
        details: { count: revoked.length },
      });
      return revoked;
    });
    out(`revoked ${rows.length} session(s)`);
  } finally {
    await handle.close();
  }
}

async function setupRestart(): Promise<void> {
  const { config, handle } = openDatabase();
  try {
    const hash = loadBootstrapHash(config.bootstrapHashPath);
    if (!hash) fail('write a new bootstrap secret hash to the configured file first');
    const now = new Date();
    await handle.db.transaction(async (tx) => {
      const [state] = await tx.select().from(setupState).where(eq(setupState.id, 1)).for('update');
      if (!state) throw new Error('setup state is missing');
      if (state.state === 'sealed') throw new Error('setup is sealed; restarting it is not possible');
      await tx.delete(webauthnChallenges);
      await tx.delete(webauthnCredentials);
      await tx.delete(recoveryCodes);
      await tx.update(sessions).set({ revokedAt: now, revokeReason: 'ops_revoke_all' }).where(isNull(sessions.revokedAt));
      await tx.delete(ownerAccount);
      await tx
        .update(setupState)
        .set({
          state: 'awaiting_bootstrap_secret',
          bootstrapSecretHash: hash,
          bootstrapConsumedAt: null,
          setupTokenHash: null,
          setupTokenExpiresAt: null,
          ownerCreatedAt: null,
          totpVerifiedAt: null,
          recoveryCodesIssuedAt: null,
          passkeyEnrolledAt: null,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(setupState.id, 1));
      await tx.insert(auditEvents).values({
        occurredAt: now,
        actorType: 'system',
        actorId: 'cli',
        action: 'setup.restarted_by_operator',
        objectType: 'setup',
        summary: 'Unsealed setup was reset from the operations CLI',
        details: {},
      });
    });
    out('setup reset; open the app and enter the new bootstrap secret');
  } finally {
    await handle.close();
  }
}

const USAGE = `usage: cli.mjs <command>
  keys:generate --out <file> [--rotate] [--mode 0600|0640|0400|0440]
  pepper:generate --out <file> [--mode ...]
  bootstrap-secret:hash            (secret on stdin; prints sha256 hex)
  sessions:revoke-all              (uses FOS_CONFIG_FILE)
  setup:restart                    (unsealed setup only; uses FOS_CONFIG_FILE)`;

async function run(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case 'keys:generate':
      return keysGenerate(args);
    case 'pepper:generate':
      return pepperGenerate(args);
    case 'bootstrap-secret:hash':
      return bootstrapHash();
    case 'sessions:revoke-all':
      return sessionsRevokeAll();
    case 'setup:restart':
      return setupRestart();
    default:
      process.stderr.write(`${USAGE}\n`);
      process.exit(command ? 2 : 0);
  }
}

run(process.argv.slice(2)).catch((err: unknown) => {
  fail(err instanceof Error ? redactText(err.message) : 'command failed');
});
