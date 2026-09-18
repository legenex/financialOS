import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SafeFetch } from '@financialos/security/net';
import { configString, type AdapterContext, type Clock } from '../core/context';
import {
  CredentialExpiredError,
  IntegrationError,
  InvalidConfigError,
  ProviderRequestError,
  ProviderResponseError,
  ProviderUnavailableError,
} from '../core/errors';
import { redactUrl } from '../core/redact';
import { connectMcp, type McpSession } from './mcpClient';
import type { ConnectionTestResult, ProviderAdapter } from './types';

/**
 * OAuth 2.1 client for MCP servers.
 *
 * Follows the MCP authorization profile: RFC 9728 protected-resource metadata to find the authorization
 * server, RFC 8414 authorization-server metadata to find its endpoints, RFC 7591 dynamic client registration
 * when the server advertises it, authorization code with PKCE S256 and a `state` value, the `resource`
 * indicator (RFC 8707), and refresh tokens.
 *
 * Only two non-GET requests exist here: the RFC 7591 registration POST and the RFC 6749 token POST. Both are
 * part of obtaining a read credential; there is no other write path. Everything goes through safeFetch.
 */

export const PKCE_METHOD = 'S256';

const HttpsUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Expected an absolute http(s) URL');

export const ProtectedResourceMetadata = z.object({
  resource: HttpsUrl,
  authorization_servers: z.array(HttpsUrl).min(1).max(10).optional(),
  scopes_supported: z.array(z.string().max(200)).max(100).optional(),
  bearer_methods_supported: z.array(z.string().max(40)).max(10).optional(),
  resource_documentation: HttpsUrl.optional(),
});
export type ProtectedResourceMetadata = z.infer<typeof ProtectedResourceMetadata>;

export const AuthorizationServerMetadata = z.object({
  issuer: HttpsUrl,
  authorization_endpoint: HttpsUrl,
  token_endpoint: HttpsUrl,
  registration_endpoint: HttpsUrl.optional(),
  revocation_endpoint: HttpsUrl.optional(),
  scopes_supported: z.array(z.string().max(200)).max(200).optional(),
  response_types_supported: z.array(z.string().max(40)).max(20).optional(),
  grant_types_supported: z.array(z.string().max(60)).max(20).optional(),
  code_challenge_methods_supported: z.array(z.string().max(20)).max(10).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string().max(60)).max(20).optional(),
});
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadata>;

const TokenResponse = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().max(40).optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
  refresh_token: z.string().min(1).max(8192).optional(),
  scope: z.string().max(2000).optional(),
});

const ClientRegistrationResponse = z.object({
  client_id: z.string().min(1).max(512),
  client_secret: z.string().min(1).max(2048).optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  registration_access_token: z.string().min(1).max(8192).optional(),
  registration_client_uri: HttpsUrl.optional(),
});

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO instant, or null when the server gave no expiry. */
  expiresAt: string | null;
  tokenType: string;
  scope: string | null;
}

export interface StoredClient {
  clientId: string;
  clientSecret: string | null;
  issuedAt: string;
  /** The authorization server the registration belongs to. A different issuer invalidates it. */
  issuer: string;
}

export interface PendingAuthorization {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  resource: string;
  scope: string | null;
  expiresAt: string;
}

/**
 * Persistence seam. The worker implements it over `oauth_clients`, `oauth_states`, and `oauth_tokens`, with
 * secrets encrypted at rest. Adapters never touch the database themselves.
 */
export interface TokenStore {
  loadTokens(): Promise<StoredTokens | null>;
  saveTokens(tokens: StoredTokens): Promise<void>;
  loadClient(): Promise<StoredClient | null>;
  saveClient(client: StoredClient): Promise<void>;
  loadPending(): Promise<PendingAuthorization | null>;
  savePending(pending: PendingAuthorization | null): Promise<void>;
}

/** In-memory store. Used by tests and never by the worker. */
export function createMemoryTokenStore(initial: Partial<{ tokens: StoredTokens; client: StoredClient; pending: PendingAuthorization }> = {}): TokenStore & { state: { tokens: StoredTokens | null; client: StoredClient | null; pending: PendingAuthorization | null } } {
  const state = {
    tokens: initial.tokens ?? null,
    client: initial.client ?? null,
    pending: initial.pending ?? null,
  };
  return {
    state,
    loadTokens: async () => state.tokens,
    saveTokens: async (t) => {
      state.tokens = t;
    },
    loadClient: async () => state.client,
    saveClient: async (c) => {
      state.client = c;
    },
    loadPending: async () => state.pending,
    savePending: async (p) => {
      state.pending = p;
    },
  };
}

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 code verifier: 43-128 unreserved characters. */
export function createCodeVerifier(): string {
  return base64Url(randomBytes(64));
}

export function codeChallengeS256(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier, 'ascii').digest());
}

export function createState(): string {
  return base64Url(randomBytes(32));
}

/** Constant-time comparison for the state value returned by the authorization server. */
export function statesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

interface FetchDeps {
  safeFetch: SafeFetch;
  signal?: AbortSignal;
  clock: Clock;
}

const METADATA_LIMIT = 256 * 1024;
const TOKEN_LIMIT = 64 * 1024;

async function getJson(deps: FetchDeps, url: string, label: string, options: { allowNotFound?: boolean } = {}): Promise<unknown | null> {
  const redacted = redactUrl(url);
  let response;
  try {
    response = await deps.safeFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'mcp-protocol-version': MCP_PROTOCOL_VERSION },
      ...(deps.signal ? { signal: deps.signal } : {}),
      maxResponseBytes: METADATA_LIMIT,
      totalTimeoutMs: 20_000,
      retry: { maxAttempts: 3, idempotent: true },
    });
  } catch (err) {
    throw new ProviderUnavailableError(`${label} could not be fetched from ${redacted}`, err);
  }
  if (response.status === 404 || response.status === 405) {
    await response.cancel();
    if (options.allowNotFound) return null;
    throw new ProviderResponseError(`${label} was not published at ${redacted}`);
  }
  if (!response.ok) {
    await response.cancel();
    throw new ProviderRequestError(`${label} request returned HTTP ${response.status} at ${redacted}`, response.status);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderResponseError(`${label} at ${redacted} is not valid JSON`);
  }
}

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Builds the RFC 9728 well-known locations for a resource URL. The path-aware form comes first, as the
 * specification requires, followed by the root form.
 */
export function protectedResourceMetadataUrls(resourceUrl: string): string[] {
  const url = new URL(resourceUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const out: string[] = [];
  if (path && path !== '/') out.push(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  out.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return out;
}

/** RFC 8414 (plus OpenID Connect discovery) locations for an issuer URL, in the order they must be tried. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  const out: string[] = [];
  if (path && path !== '/') {
    out.push(`${url.origin}/.well-known/oauth-authorization-server${path}`);
    out.push(`${url.origin}/.well-known/openid-configuration${path}`);
    out.push(`${url.origin}${path}/.well-known/openid-configuration`);
  } else {
    out.push(`${url.origin}/.well-known/oauth-authorization-server`);
    out.push(`${url.origin}/.well-known/openid-configuration`);
  }
  return out;
}

/** Reads `resource_metadata` from a WWW-Authenticate challenge, as RFC 9728 section 5.1 describes. */
export function resourceMetadataFromChallenge(header: string | null): string | null {
  if (!header) return null;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header) ?? /resource_metadata\s*=\s*([^,\s]+)/i.exec(header);
  if (!match?.[1]) return null;
  try {
    const url = new URL(match[1]);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export async function discoverProtectedResource(deps: FetchDeps, resourceUrl: string, challenge: string | null = null): Promise<ProtectedResourceMetadata | null> {
  const fromChallenge = resourceMetadataFromChallenge(challenge);
  const candidates = fromChallenge ? [fromChallenge, ...protectedResourceMetadataUrls(resourceUrl)] : protectedResourceMetadataUrls(resourceUrl);
  for (const candidate of candidates) {
    const body = await getJson(deps, candidate, 'Protected-resource metadata', { allowNotFound: true });
    if (body === null) continue;
    const parsed = ProtectedResourceMetadata.safeParse(body);
    if (!parsed.success) throw new ProviderResponseError(`Protected-resource metadata at ${redactUrl(candidate)} does not match RFC 9728`);
    return parsed.data;
  }
  return null;
}

export async function discoverAuthorizationServer(deps: FetchDeps, issuer: string): Promise<AuthorizationServerMetadata> {
  for (const candidate of authorizationServerMetadataUrls(issuer)) {
    const body = await getJson(deps, candidate, 'Authorization-server metadata', { allowNotFound: true });
    if (body === null) continue;
    const parsed = AuthorizationServerMetadata.safeParse(body);
    if (!parsed.success) continue;
    return parsed.data;
  }
  throw new ProviderResponseError(`No RFC 8414 authorization-server metadata was published by ${redactUrl(issuer)}`);
}

async function postForm(deps: FetchDeps, url: string, body: URLSearchParams, headers: Record<string, string>, label: string): Promise<unknown> {
  const redacted = redactUrl(url);
  let response;
  try {
    // OAuth token and registration requests are POSTs by specification. They obtain a read credential and
    // are the only non-GET requests this package makes.
    response = await deps.safeFetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: body.toString(),
      ...(deps.signal ? { signal: deps.signal } : {}),
      maxResponseBytes: TOKEN_LIMIT,
      totalTimeoutMs: 20_000,
      redirect: 'error',
    });
  } catch (err) {
    throw new ProviderUnavailableError(`${label} request to ${redacted} failed`, err);
  }
  const text = await response.text();
  if (!response.ok) {
    let code = '';
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string' && /^[a-z_]{1,64}$/.test(parsed.error)) code = parsed.error;
    } catch {
      // The body is not JSON; the status alone is reported.
    }
    if (response.status === 400 && (code === 'invalid_grant' || code === 'invalid_request')) {
      throw new CredentialExpiredError(`The authorization server rejected the grant (${code}). Reconnect the provider.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new CredentialExpiredError(`The authorization server rejected the client credentials at ${redacted}.`);
    }
    throw new ProviderRequestError(`${label} returned HTTP ${response.status}${code ? ` (${code})` : ''} at ${redacted}`, response.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderResponseError(`${label} at ${redacted} is not valid JSON`);
  }
}

async function postJson(deps: FetchDeps, url: string, payload: unknown, label: string): Promise<unknown> {
  const redacted = redactUrl(url);
  let response;
  try {
    response = await deps.safeFetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(deps.signal ? { signal: deps.signal } : {}),
      maxResponseBytes: TOKEN_LIMIT,
      totalTimeoutMs: 20_000,
      redirect: 'error',
    });
  } catch (err) {
    throw new ProviderUnavailableError(`${label} request to ${redacted} failed`, err);
  }
  const text = await response.text();
  if (!response.ok) throw new ProviderRequestError(`${label} returned HTTP ${response.status} at ${redacted}`, response.status);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderResponseError(`${label} at ${redacted} is not valid JSON`);
  }
}

export interface ClientRegistrationOptions {
  clientName: string;
  redirectUris: string[];
  scope: string | null;
  /** Owner-facing URL describing this deployment, optional. */
  clientUri?: string | null;
}

/** RFC 7591 dynamic client registration. Only called when the authorization server advertises the endpoint. */
export async function registerClient(deps: FetchDeps, metadata: AuthorizationServerMetadata, options: ClientRegistrationOptions): Promise<StoredClient> {
  if (!metadata.registration_endpoint) {
    throw new InvalidConfigError('This authorization server does not advertise dynamic client registration. Register a client manually and store its client id.');
  }
  const payload: Record<string, unknown> = {
    client_name: options.clientName,
    redirect_uris: options.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  };
  if (options.scope) payload.scope = options.scope;
  if (options.clientUri) payload.client_uri = options.clientUri;
  const body = await postJson(deps, metadata.registration_endpoint, payload, 'Client registration');
  const parsed = ClientRegistrationResponse.safeParse(body);
  if (!parsed.success) throw new ProviderResponseError('The client-registration response does not match RFC 7591');
  return {
    clientId: parsed.data.client_id,
    clientSecret: parsed.data.client_secret ?? null,
    issuedAt: deps.clock.now().toISOString(),
    issuer: metadata.issuer,
  };
}

export interface BeginAuthorizationOptions {
  /** The MCP server URL this credential is for. Used as the RFC 8707 `resource` indicator. */
  resourceUrl: string;
  redirectUri: string;
  clientName: string;
  /** Requested scope, or null to let the server decide. */
  scope?: string | null;
  /** Challenge header from a 401, when one was seen. */
  challenge?: string | null;
  /** How long the owner has to complete the browser flow. */
  ttlMs?: number;
}

export interface BeginAuthorizationResult {
  authorizationUrl: string;
  expiresAt: string;
  metadata: AuthorizationServerMetadata;
  resourceMetadata: ProtectedResourceMetadata | null;
  registered: boolean;
}

/**
 * Discovers the authorization server, registers a client when needed, and builds the authorization URL.
 * The verifier and state are written to the token store and never returned to the caller.
 */
export async function beginAuthorization(ctx: Pick<AdapterContext, 'safeFetch' | 'clock' | 'signal' | 'logger'>, store: TokenStore, options: BeginAuthorizationOptions): Promise<BeginAuthorizationResult> {
  const deps: FetchDeps = { safeFetch: ctx.safeFetch, clock: ctx.clock, ...(ctx.signal ? { signal: ctx.signal } : {}) };
  const resourceMetadata = await discoverProtectedResource(deps, options.resourceUrl, options.challenge ?? null);
  const issuer = resourceMetadata?.authorization_servers?.[0] ?? new URL(options.resourceUrl).origin;
  const metadata = await discoverAuthorizationServer(deps, issuer);
  const methods = metadata.code_challenge_methods_supported ?? [];
  if (methods.length > 0 && !methods.includes(PKCE_METHOD)) {
    throw new InvalidConfigError(`The authorization server does not support PKCE ${PKCE_METHOD}; FinancialOS will not use a weaker method.`);
  }
  const scope = options.scope ?? (resourceMetadata?.scopes_supported?.length ? resourceMetadata.scopes_supported.join(' ') : null);

  let client = await store.loadClient();
  let registered = false;
  if (client && client.issuer !== metadata.issuer) client = null;
  if (!client) {
    client = await registerClient(deps, metadata, { clientName: options.clientName, redirectUris: [options.redirectUri], scope });
    await store.saveClient(client);
    registered = true;
  }

  const codeVerifier = createCodeVerifier();
  const state = createState();
  const expiresAt = new Date(ctx.clock.now().getTime() + (options.ttlMs ?? 10 * 60_000)).toISOString();
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', client.clientId);
  authorizationUrl.searchParams.set('redirect_uri', options.redirectUri);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', codeChallengeS256(codeVerifier));
  authorizationUrl.searchParams.set('code_challenge_method', PKCE_METHOD);
  authorizationUrl.searchParams.set('resource', resourceMetadata?.resource ?? options.resourceUrl);
  if (scope) authorizationUrl.searchParams.set('scope', scope);

  await store.savePending({
    state,
    codeVerifier,
    redirectUri: options.redirectUri,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    resource: resourceMetadata?.resource ?? options.resourceUrl,
    scope,
    expiresAt,
  });
  ctx.logger.info('oauth authorization started', { issuer: redactUrl(metadata.issuer), registered });
  return { authorizationUrl: authorizationUrl.href, expiresAt, metadata, resourceMetadata, registered };
}

function tokensFrom(body: unknown, clock: Clock, previous: StoredTokens | null): StoredTokens {
  const parsed = TokenResponse.safeParse(body);
  if (!parsed.success) throw new ProviderResponseError('The token response does not match RFC 6749');
  const expiresInRaw = parsed.data.expires_in;
  const expiresIn = typeof expiresInRaw === 'number' ? expiresInRaw : typeof expiresInRaw === 'string' && /^\d{1,7}$/.test(expiresInRaw) ? Number(expiresInRaw) : null;
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: expiresIn === null ? null : new Date(clock.now().getTime() + expiresIn * 1000).toISOString(),
    tokenType: parsed.data.token_type ?? 'Bearer',
    scope: parsed.data.scope ?? previous?.scope ?? null,
  };
}

export interface CompleteAuthorizationInput {
  code: string;
  state: string;
}

/** Exchanges the authorization code. The `state` must match the pending request exactly. */
export async function completeAuthorization(ctx: Pick<AdapterContext, 'safeFetch' | 'clock' | 'signal' | 'logger'>, store: TokenStore, input: CompleteAuthorizationInput): Promise<StoredTokens> {
  const pending = await store.loadPending();
  if (!pending) throw new InvalidConfigError('No authorization is in progress for this connection. Start the connection flow again.');
  if (!statesMatch(pending.state, input.state)) {
    await store.savePending(null);
    throw new InvalidConfigError('The authorization response did not match the request (state mismatch). Start the connection flow again.');
  }
  if (new Date(pending.expiresAt).getTime() <= ctx.clock.now().getTime()) {
    await store.savePending(null);
    throw new InvalidConfigError('The authorization request expired. Start the connection flow again.');
  }
  const deps: FetchDeps = { safeFetch: ctx.safeFetch, clock: ctx.clock, ...(ctx.signal ? { signal: ctx.signal } : {}) };
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.codeVerifier,
    resource: pending.resource,
  });
  const headers: Record<string, string> = {};
  if (pending.clientSecret) headers.authorization = `Basic ${Buffer.from(`${pending.clientId}:${pending.clientSecret}`).toString('base64')}`;
  const body = await postForm(deps, pending.tokenEndpoint, form, headers, 'Token exchange');
  const tokens = tokensFrom(body, ctx.clock, null);
  await store.saveTokens(tokens);
  await store.savePending(null);
  ctx.logger.info('oauth authorization completed', { hasRefreshToken: tokens.refreshToken !== null });
  return tokens;
}

export interface AccessTokenOptions {
  /** Refresh this many milliseconds before the stated expiry. */
  refreshSkewMs?: number;
  tokenEndpoint?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  resource?: string | null;
}

/**
 * Returns a usable access token, refreshing it when it is expired or about to expire. Throws
 * CredentialExpiredError when there is nothing to refresh with, so the worker can ask the owner to reconnect.
 */
export async function getAccessToken(ctx: Pick<AdapterContext, 'safeFetch' | 'clock' | 'signal' | 'logger'>, store: TokenStore, options: AccessTokenOptions = {}): Promise<StoredTokens> {
  const tokens = await store.loadTokens();
  if (!tokens) throw new CredentialExpiredError('This connection has not been authorized yet. Start the connection flow.');
  const skew = options.refreshSkewMs ?? 60_000;
  const expired = tokens.expiresAt !== null && new Date(tokens.expiresAt).getTime() - skew <= ctx.clock.now().getTime();
  if (!expired) return tokens;
  if (!tokens.refreshToken) throw new CredentialExpiredError('The access token expired and the provider issued no refresh token. Reconnect the provider.');
  const pending = await store.loadPending();
  const client = await store.loadClient();
  const tokenEndpoint = options.tokenEndpoint ?? pending?.tokenEndpoint ?? null;
  const clientId = options.clientId ?? client?.clientId ?? pending?.clientId ?? null;
  if (!tokenEndpoint || !clientId) {
    throw new InvalidConfigError('The token endpoint or client id for this connection is not known. Reconnect the provider.');
  }
  const deps: FetchDeps = { safeFetch: ctx.safeFetch, clock: ctx.clock, ...(ctx.signal ? { signal: ctx.signal } : {}) };
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: clientId });
  const resource = options.resource ?? pending?.resource ?? null;
  if (resource) form.set('resource', resource);
  const secret = options.clientSecret ?? client?.clientSecret ?? null;
  const headers: Record<string, string> = {};
  if (secret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
  let body: unknown;
  try {
    body = await postForm(deps, tokenEndpoint, form, headers, 'Token refresh');
  } catch (err) {
    if (err instanceof CredentialExpiredError) throw err;
    if (err instanceof IntegrationError) throw err;
    throw new ProviderUnavailableError('The access token could not be refreshed', err);
  }
  const refreshed = tokensFrom(body, ctx.clock, tokens);
  await store.saveTokens(refreshed);
  ctx.logger.info('oauth token refreshed', {});
  return refreshed;
}

// ---------------------------------------------------------------------------------------------------------
// Provider adapter built on the OAuth flow above plus the Streamable HTTP client
// ---------------------------------------------------------------------------------------------------------

export interface McpAdapterDefinition {
  key: string;
  /** Human label used in messages. */
  label: string;
  /** Default MCP endpoint. The owner may override it in connection config. */
  defaultUrl: string;
  /** Scope string to request, when the provider documents one. */
  scope?: string | null;
  /** Owner-approved extra tool names, beyond what the read-only classifier accepts on its own. */
  extraAllowedTools?: readonly string[];
  /** Tool names refused for this provider regardless of what the server says. */
  deniedTools?: readonly string[];
  /** Notes appended to every test result (for example, that order tools are excluded). */
  standingNotes?: readonly string[];
}

/**
 * Builds a ProviderAdapter for a remote MCP server.
 *
 * MCP contributes agent context, not records of account. Tool output is free-form text produced by a remote
 * server; it is reported to the owner as data and is never turned into balances, transactions, or holdings
 * here. The REST or file method of the same provider remains the source of record.
 */
export function createMcpAdapter(definition: McpAdapterDefinition, storeFactory: (ctx: AdapterContext) => TokenStore): ProviderAdapter {
  return {
    key: definition.key,
    method: 'mcp_oauth',
    readOnly: true,
    async test(ctx: AdapterContext): Promise<ConnectionTestResult> {
      const url = configString(ctx, 'serverUrl') ?? definition.defaultUrl;
      const store = storeFactory(ctx);
      const tokens = await getAccessToken(ctx, store).catch((err: unknown) => {
        if (err instanceof CredentialExpiredError || err instanceof InvalidConfigError) return null;
        throw err;
      });
      const session = await connectMcp(ctx, {
        url,
        accessToken: tokens?.accessToken ?? null,
        policy: {
          ...(definition.extraAllowedTools ? { extraAllowed: definition.extraAllowedTools } : {}),
          ...(definition.deniedTools ? { denied: definition.deniedTools } : {}),
        },
      });
      try {
        const { allowed, denied } = await session.listTools();
        return {
          ok: true,
          detail: `${definition.label} exposed ${allowed.length + denied.length} tool(s); ${allowed.length} passed the read-only check.`,
          grantedScopes: tokens?.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [],
          identity: session.serverInfo ? `${session.serverInfo.name} ${session.serverInfo.version}` : null,
          observations: [
            `Allowed tools: ${allowed.map((t) => t.name).join(', ') || 'none'}`,
            `Refused tools: ${denied.map((d) => `${d.name} (${d.reason})`).join('; ') || 'none'}`,
            ...(definition.standingNotes ?? []),
          ],
        };
      } finally {
        await session.close();
      }
    },
  };
}

/** Opens a session with the read-only policy applied and hands it to `run`, closing it afterwards. */
export async function withMcpSession<T>(
  ctx: AdapterContext,
  definition: Pick<McpAdapterDefinition, 'defaultUrl' | 'extraAllowedTools' | 'deniedTools'>,
  store: TokenStore,
  run: (session: McpSession) => Promise<T>,
): Promise<T> {
  const url = configString(ctx, 'serverUrl') ?? definition.defaultUrl;
  const tokens = await getAccessToken(ctx, store);
  const session = await connectMcp(ctx, {
    url,
    accessToken: tokens.accessToken,
    policy: {
      ...(definition.extraAllowedTools ? { extraAllowed: definition.extraAllowedTools } : {}),
      ...(definition.deniedTools ? { denied: definition.deniedTools } : {}),
    },
  });
  try {
    await session.listTools();
    return await run(session);
  } finally {
    await session.close();
  }
}
