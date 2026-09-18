/**
 * Zod compiles fast object parsers with `new Function` unless "jitless" mode is on. Extension pages
 * forbid eval, so the probe would only produce CSP violation reports. Zod keeps its global config
 * on this well-known global object (it reuses an existing one on first import) and reads `jitless`
 * when schemas are constructed, so this module must be evaluated before any contract module.
 * The build verifies that the bundled zod still uses this hook, and a unit test verifies that
 * zod's own `config()` reports jitless mode after this module runs.
 */
type ZodGlobal = typeof globalThis & { __zod_globalConfig?: Record<string, unknown> };

const scope = globalThis as ZodGlobal;
scope.__zod_globalConfig = Object.assign(scope.__zod_globalConfig ?? {}, { jitless: true });

export const ZOD_JITLESS = true;
