import { ProviderDescriptor as ProviderDescriptorSchema, type AuthMethod, type ProviderDescriptor } from '@financialos/contracts';
import type { AdapterContext } from './core/context';
import { btcWatchOnlyAdapter } from './adapters/btcWatchOnly';
import { customHttpAdapter } from './adapters/customHttp';
import { customMcpAdapter } from './adapters/customMcp';
import { emailImapAdapter } from './adapters/email';
import { ethWatchOnlyAdapter } from './adapters/ethWatchOnly';
import { ibkrFlexAdapter } from './adapters/ibkrFlex';
import { createMcpAdapter, type TokenStore } from './adapters/mcpOAuth';
import { mercuryAdapter } from './adapters/mercury';
import type { ProviderAdapter } from './adapters/types';
import { aiAnthropicProvider, aiOpenAiCompatibleProvider } from './providers/ai';
import { discoveryProvider, fnbProvider, revolutPersonalProvider, wioBusinessProvider, wioPersonalProvider } from './providers/banks';
import { cryptoBtcProvider, cryptoEthProvider } from './providers/crypto';
import { customHttpProvider, customMcpProvider, documentUploadProvider, emailImapProvider, manualHoldingsProvider } from './providers/custom';
import { ibkrProvider } from './providers/ibkr';
import { mercuryMcpProvider, mercuryProvider } from './providers/mercury';

/**
 * The provider registry.
 *
 * `listProviders()` is what the Connections screen renders: every provider the deployment knows about, each
 * method it offers, what that method can and cannot do, and the exact steps the owner performs outside
 * FinancialOS to make it work. A provider with no working API is listed honestly with its import path rather
 * than left out or given an invented one.
 *
 * `getAdapter(key, method)` returns the code that runs a method, or undefined when the method is descriptive
 * only (a file import the pipeline handles, a manual entry, or a channel that needs onboarding nobody has
 * done). Callers must treat undefined as "not runnable", never as an error to work around.
 */

const PROVIDERS: readonly ProviderDescriptor[] = [
  mercuryProvider,
  mercuryMcpProvider,
  ibkrProvider,
  revolutPersonalProvider,
  wioPersonalProvider,
  wioBusinessProvider,
  discoveryProvider,
  fnbProvider,
  cryptoBtcProvider,
  cryptoEthProvider,
  manualHoldingsProvider,
  customHttpProvider,
  customMcpProvider,
  emailImapProvider,
  aiOpenAiCompatibleProvider,
  aiAnthropicProvider,
  documentUploadProvider,
];

export const MERCURY_MCP_URL = 'https://mcp.mercury.com/mcp';
export const IBKR_MCP_URL = 'https://api.ibkr.com/v1/api/mcp-public';

/** Tool names a provider's MCP server must never be allowed to call, whatever it claims about them. */
const IBKR_DENIED_TOOLS = ['placeOrder', 'submitOrder', 'cancelOrder', 'modifyOrder', 'previewOrder', 'createOrder'];

/**
 * The worker supplies the token store, because tokens live in the database and adapters never touch it.
 * Until a connection is wired up, a store that reports "not authorized yet" is used, which produces a clear
 * CredentialExpiredError rather than a crash.
 */
export type TokenStoreFactory = (ctx: AdapterContext) => TokenStore;

const unauthorizedStore: TokenStoreFactory = () => ({
  loadTokens: async () => null,
  saveTokens: async () => undefined,
  loadClient: async () => null,
  saveClient: async () => undefined,
  loadPending: async () => null,
  savePending: async () => undefined,
});

let tokenStoreFactory: TokenStoreFactory = unauthorizedStore;

/** Installs the worker's token store. Called once at start-up, before any MCP connection is used. */
export function setTokenStoreFactory(factory: TokenStoreFactory): void {
  tokenStoreFactory = factory;
}

export const mercuryMcpAdapter: ProviderAdapter = createMcpAdapter(
  {
    key: 'mercury_mcp',
    label: 'The Mercury MCP server',
    defaultUrl: MERCURY_MCP_URL,
    scope: 'read offline_access',
    standingNotes: [
      'Mercury documents that its hosted MCP issues a read-only token and has read-only access.',
      'MCP output is agent context. Balances and transactions of record come from the Mercury REST connection.',
    ],
  },
  (ctx) => tokenStoreFactory(ctx),
);

export const ibkrMcpAdapter: ProviderAdapter = createMcpAdapter(
  {
    key: 'ibkr',
    label: 'The IBKR MCP server',
    defaultUrl: IBKR_MCP_URL,
    deniedTools: IBKR_DENIED_TOOLS,
    standingNotes: [
      'Order tools are excluded here. IBKR states that instructions never become orders automatically and that you review and submit every order in an IBKR platform.',
      'IBKR publishes no MCP tool list, transport, or OAuth version, so whatever the server answers is reported as observed, not as documented.',
    ],
  },
  (ctx) => tokenStoreFactory(ctx),
);

interface AdapterKey {
  key: string;
  method: AuthMethod;
}

const ADAPTERS: ReadonlyArray<AdapterKey & { adapter: ProviderAdapter }> = [
  { key: 'mercury', method: 'api_token', adapter: mercuryAdapter },
  { key: 'mercury_mcp', method: 'mcp_oauth', adapter: mercuryMcpAdapter },
  { key: 'ibkr', method: 'flex_web_service', adapter: ibkrFlexAdapter },
  { key: 'ibkr', method: 'mcp_oauth', adapter: ibkrMcpAdapter },
  { key: 'crypto_btc', method: 'watch_only_address', adapter: btcWatchOnlyAdapter },
  { key: 'crypto_eth', method: 'watch_only_address', adapter: ethWatchOnlyAdapter },
  { key: 'custom_http', method: 'custom_http', adapter: customHttpAdapter },
  { key: 'custom_mcp', method: 'mcp_oauth', adapter: customMcpAdapter },
  { key: 'email_imap', method: 'imap', adapter: emailImapAdapter },
];

/** Every provider the deployment knows about, in the order the Connections screen shows them. */
export function listProviders(): ProviderDescriptor[] {
  return PROVIDERS.map((provider) => structuredClone(provider) as ProviderDescriptor);
}

export function getProvider(key: string): ProviderDescriptor | undefined {
  const found = PROVIDERS.find((p) => p.key === key);
  return found ? (structuredClone(found) as ProviderDescriptor) : undefined;
}

/** The adapter that runs a provider method, or undefined when the method is descriptive only. */
export function getAdapter(key: string, method: AuthMethod): ProviderAdapter | undefined {
  return ADAPTERS.find((entry) => entry.key === key && entry.method === method)?.adapter;
}

/** True when the registry declares this provider/method pair at all (with or without an adapter). */
export function hasMethod(key: string, method: AuthMethod): boolean {
  return PROVIDERS.some((p) => p.key === key && p.methods.some((m) => m.method === method));
}

/** Validates every descriptor against the shared contract. Used by tests and by a start-up self-check. */
export function validateRegistry(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const provider of PROVIDERS) {
    if (seen.has(provider.key)) problems.push(`duplicate provider key ${provider.key}`);
    seen.add(provider.key);
    const parsed = ProviderDescriptorSchema.safeParse(provider);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${provider.key}: ${issue.path.join('.')} ${issue.message}`);
    }
    if (provider.methods.length === 0) problems.push(`${provider.key}: has no methods`);
    const methods = new Set<string>();
    for (const method of provider.methods) {
      const id = `${method.method}:${method.label}`;
      if (methods.has(id)) problems.push(`${provider.key}: duplicate method ${id}`);
      methods.add(id);
      if (method.ownerActivationSteps.length === 0) problems.push(`${provider.key}/${method.method}: no owner activation steps`);
      for (const [name, flag] of Object.entries(method.capabilities)) {
        if (!flag.supported && (flag.note === null || flag.note.trim() === '')) {
          problems.push(`${provider.key}/${method.method}: capability ${name} is unsupported without a reason`);
        }
      }
    }
  }
  for (const entry of ADAPTERS) {
    if (!hasMethod(entry.key, entry.method)) problems.push(`adapter ${entry.key}/${entry.method} has no descriptor`);
    if (entry.adapter.readOnly !== true) problems.push(`adapter ${entry.key}/${entry.method} is not marked read-only`);
  }
  return { ok: problems.length === 0, problems };
}
