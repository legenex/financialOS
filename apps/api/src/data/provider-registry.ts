/**
 * Provider descriptors come from the @financialos/integrations registry, which declares what each
 * adapter can actually do and how far it has been verified.
 *
 * The registry is loaded through a runtime import so the API keeps serving (with an honest empty
 * list) on a deployment where the integrations package has not been built yet. Nothing is invented:
 * a provider that is not declared is simply not offered.
 */
import { ProviderDescriptor } from '@financialos/contracts';

const INTEGRATIONS_MODULE = '@financialos/integrations';

export interface ProviderRegistryResult {
  items: ProviderDescriptor[];
  /** False when the integrations registry could not be loaded on this server. */
  available: boolean;
  note: string | null;
}

function pickDescriptors(module: Record<string, unknown>): unknown[] {
  for (const key of ['PROVIDERS', 'providers', 'PROVIDER_REGISTRY', 'providerRegistry', 'allProviders']) {
    const value = module[key];
    if (Array.isArray(value)) return value;
    if (typeof value === 'function') {
      const called: unknown = (value as () => unknown)();
      if (Array.isArray(called)) return called;
    }
  }
  return [];
}

export async function loadProviderRegistry(): Promise<ProviderRegistryResult> {
  let module: Record<string, unknown>;
  try {
    module = (await import(/* @vite-ignore */ INTEGRATIONS_MODULE)) as Record<string, unknown>;
  } catch {
    return {
      items: [],
      available: false,
      note: 'The provider registry is not installed on this server, so no providers are offered. Imports still work.',
    };
  }
  const raw = pickDescriptors(module);
  const items: ProviderDescriptor[] = [];
  let skipped = 0;
  for (const candidate of raw) {
    const parsed = ProviderDescriptor.safeParse(candidate);
    if (parsed.success) items.push(parsed.data);
    else skipped += 1;
  }
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    items,
    available: true,
    note: skipped > 0 ? `${skipped} provider descriptor(s) did not match the contract and were not offered.` : null,
  };
}

export async function findProvider(key: string): Promise<ProviderDescriptor | null> {
  const registry = await loadProviderRegistry();
  return registry.items.find((p) => p.key === key) ?? null;
}
