/**
 * Helpers that drive the real setup / sign-in / pairing flows over HTTP. Tests use these so the
 * security-relevant paths are always exercised end to end rather than faked in the database.
 */
import { generate } from 'otplib';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ownerAccount, agentClients } from '@financialos/db';
import { sha256Base64Url } from '@financialos/security/tokens';
import { TOTP_PERIOD_SECONDS } from '../auth/totp';
import { TestClient } from './client';
import { TEST_EXTENSION_ORIGIN, TEST_OWNER_NAME, TEST_PASSWORD, type Harness } from './harness';

export interface OwnerCredentials {
  totpSecret: string;
  recoveryCodes: string[];
  password: string;
}

export function totpSecretFromUri(otpauthUri: string): string {
  const secret = new URL(otpauthUri).searchParams.get('secret');
  if (!secret) throw new Error(`no secret in otpauth uri: ${otpauthUri.slice(0, 40)}`);
  return secret;
}

export function stepOf(when: Date): number {
  return Math.floor(when.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

export async function totpCodeAt(secret: string, when: Date): Promise<string> {
  return generate({ secret, epoch: Math.floor(when.getTime() / 1000), period: TOTP_PERIOD_SECONDS });
}

/** A code for the current fake time, after moving past any step the owner already consumed. */
export async function freshTotpCode(harness: Harness, secret: string): Promise<string> {
  const [owner] = await harness.db.select().from(ownerAccount).limit(1);
  const lastStep = owner?.totpLastUsedStep ?? null;
  while (lastStep !== null && stepOf(harness.clock.now()) <= lastStep) {
    await harness.clock.advance(TOTP_PERIOD_SECONDS * 1000);
  }
  return totpCodeAt(secret, harness.clock.now());
}

export interface SetupResult extends OwnerCredentials {
  client: TestClient;
}

/** Runs the whole bootstrap: begin, owner, TOTP, recovery codes, seal. */
export async function completeSetup(harness: Harness, options: { password?: string; client?: TestClient } = {}): Promise<SetupResult> {
  const client = options.client ?? new TestClient(harness);
  const password = options.password ?? TEST_PASSWORD;

  const begin = await client.post('/api/setup/begin', { bootstrapSecret: harness.bootstrapSecret });
  if (begin.statusCode !== 200) throw new Error(`setup/begin failed: ${begin.statusCode} ${begin.body}`);

  const owner = await client.post('/api/setup/owner', { displayName: TEST_OWNER_NAME, password });
  if (owner.statusCode !== 200) throw new Error(`setup/owner failed: ${owner.statusCode} ${owner.body}`);

  const start = await client.post('/api/setup/totp/start');
  if (start.statusCode !== 200) throw new Error(`setup/totp/start failed: ${start.statusCode} ${start.body}`);
  const totpSecret = totpSecretFromUri((start.json() as { otpauthUri: string }).otpauthUri);

  const verify = await client.post('/api/setup/totp/verify', { code: await totpCodeAt(totpSecret, harness.clock.now()) });
  if (verify.statusCode !== 200) throw new Error(`setup/totp/verify failed: ${verify.statusCode} ${verify.body}`);

  const codes = await client.post('/api/setup/recovery-codes');
  if (codes.statusCode !== 200) throw new Error(`setup/recovery-codes failed: ${codes.statusCode} ${codes.body}`);
  const recoveryCodes = (codes.json() as { codes: string[] }).codes;

  const seal = await client.post('/api/setup/seal');
  if (seal.statusCode !== 200) throw new Error(`setup/seal failed: ${seal.statusCode} ${seal.body}`);

  return { client, totpSecret, recoveryCodes, password };
}

export interface LoginOptions {
  client?: TestClient;
  password?: string;
  launchId?: string;
  /** Use a recovery code instead of a TOTP code. */
  recoveryCode?: string;
}

/** Signs in with password + TOTP (or a recovery code) and returns the signed-in client. */
export async function login(harness: Harness, credentials: OwnerCredentials, options: LoginOptions = {}): Promise<TestClient> {
  const client = options.client ?? new TestClient(harness);
  const payload: Record<string, unknown> = { password: options.password ?? credentials.password };
  if (options.recoveryCode) payload.recoveryCode = options.recoveryCode;
  else payload.totpCode = await freshTotpCode(harness, credentials.totpSecret);
  if (options.launchId) payload.launchId = options.launchId;
  const response = await client.post('/api/auth/login/password', payload);
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  return client;
}

/** Setup + sign in, the usual starting point for owner-route tests. */
export async function setupAndLogin(harness: Harness): Promise<{ client: TestClient; credentials: OwnerCredentials }> {
  const credentials = await completeSetup(harness);
  const client = await login(harness, credentials, { client: credentials.client });
  return { client, credentials };
}

export interface AgentCredential {
  id: string;
  credential: string;
}

export async function createAgentClient(
  ownerClient: TestClient,
  options: { name?: string; scopes: string[]; entityIds?: string[]; expiresInDays?: number } = { scopes: ['read:summary'] },
): Promise<AgentCredential & { entityIds: string[] }> {
  const entityIds = options.entityIds ?? [randomUUID()];
  const response = await ownerClient.post('/api/agent-clients', {
    name: options.name ?? 'Test agent',
    scopes: options.scopes,
    entityIds,
    expiresInDays: options.expiresInDays ?? 30,
  });
  if (response.statusCode !== 201) throw new Error(`agent client creation failed: ${response.statusCode} ${response.body}`);
  const body = response.json() as { client: { id: string }; credential: string };
  return { id: body.client.id, credential: body.credential, entityIds };
}

export async function expireAgentClient(harness: Harness, id: string, at: Date): Promise<void> {
  await harness.db.update(agentClients).set({ expiresAt: at }).where(eq(agentClients.id, id));
}

export interface PairedDevice {
  deviceId: string;
  credential: string;
  pairingId: string;
  userCode: string;
  installationId: string;
  verifier: string;
}

export function newInstallation(): { installationId: string; verifier: string; verifierChallenge: string } {
  const installationId = `inst-${randomUUID().replace(/-/g, '')}`.slice(0, 40);
  const verifier = sha256Base64Url(randomUUID());
  return { installationId, verifier, verifierChallenge: sha256Base64Url(verifier) };
}

/** Full extension pairing: start (extension), approve (owner), complete (extension). */
export async function pairDevice(
  harness: Harness,
  ownerClient: TestClient,
  options: { extensionClient?: TestClient; deviceLabel?: string; expiresInDays?: number } = {},
): Promise<PairedDevice & { extensionClient: TestClient }> {
  const extensionClient = options.extensionClient ?? new TestClient(harness);
  const install = newInstallation();
  const label = options.deviceLabel ?? 'Test extension';
  const start = await extensionClient.post(
    '/api/ext/pair/start',
    { installationId: install.installationId, verifierChallenge: install.verifierChallenge, deviceLabel: label, extensionVersion: '1.0.0' },
    { origin: TEST_EXTENSION_ORIGIN },
  );
  if (start.statusCode !== 200) throw new Error(`pair/start failed: ${start.statusCode} ${start.body}`);
  const started = start.json() as { pairingId: string; userCode: string };

  const approve = await ownerClient.post('/api/devices/pair/approve', {
    userCode: started.userCode,
    deviceLabel: label,
    expiresInDays: options.expiresInDays ?? 30,
  });
  if (approve.statusCode !== 200) throw new Error(`pair/approve failed: ${approve.statusCode} ${approve.body}`);

  const complete = await extensionClient.post(
    '/api/ext/pair/complete',
    { pairingId: started.pairingId, installationId: install.installationId, verifier: install.verifier },
    { origin: TEST_EXTENSION_ORIGIN },
  );
  if (complete.statusCode !== 200) throw new Error(`pair/complete failed: ${complete.statusCode} ${complete.body}`);
  const done = complete.json() as { status: string; deviceId: string; credential: string };
  if (done.status !== 'approved') throw new Error(`pairing not approved: ${complete.body}`);

  return {
    extensionClient,
    deviceId: done.deviceId,
    credential: done.credential,
    pairingId: started.pairingId,
    userCode: started.userCode,
    installationId: install.installationId,
    verifier: install.verifier,
  };
}
