/**
 * Test doubles for the browser capabilities in `ExtEnv`.
 *
 * Everything the extension touches at runtime is behind that interface, so the data layer, the
 * pairing state machine and the refresh throttle can be exercised without a browser. The doubles
 * deliberately mirror only what the real APIs guarantee: storage areas are asynchronous key/value
 * maps, `locks.ifAvailable` never waits, and `permissions.request` answers a boolean.
 *
 * This module is never bundled: no entry point imports it.
 */
import type { ExtEnv, LocksLike, PermissionsLike, StorageAreaLike } from './env';

export interface MemoryArea extends StorageAreaLike {
  /** Everything currently stored, for assertions. */
  readonly store: Map<string, unknown>;
  keys(): string[];
  seed(items: Record<string, unknown>): void;
}

export function memoryArea(initial: Record<string, unknown> = {}): MemoryArea {
  const store = new Map<string, unknown>(Object.entries(initial));
  // Structured-clone round trip: chrome.storage stores JSON-like copies, not live references.
  const copy = <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));
  return {
    store,
    keys: () => [...store.keys()].sort(),
    seed(items) {
      for (const [key, value] of Object.entries(items)) store.set(key, copy(value));
    },
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (store.has(key)) out[key] = copy(store.get(key));
      return out;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) store.set(key, copy(value));
    },
    async remove(keys) {
      for (const key of keys) store.delete(key);
    },
  };
}

/** `ifAvailable` semantics: the callback runs with `false` immediately when the lock is held. */
export function memoryLocks(): LocksLike & { readonly held: ReadonlySet<string> } {
  const held = new Set<string>();
  return {
    held,
    async ifAvailable<T>(name: string, callback: (acquired: boolean) => Promise<T>): Promise<T> {
      if (held.has(name)) return callback(false);
      held.add(name);
      try {
        return await callback(true);
      } finally {
        held.delete(name);
      }
    },
  };
}

export interface FakePermissions extends PermissionsLike {
  /** Host patterns Chrome currently grants, e.g. `https://financialos.example.test/*`. */
  readonly granted: Set<string>;
  /** Every `request` call, in order, exactly as the page asked for it. */
  readonly requested: string[][];
  /** Answer for the next requests: `true` allows, `false` is the user pressing Deny. */
  allow: boolean;
  /** When set, `request` rejects, as it does outside a user gesture. */
  failRequest: Error | null;
}

export function fakePermissions(granted: string[] = []): FakePermissions {
  const state: FakePermissions = {
    granted: new Set(granted),
    requested: [],
    allow: true,
    failRequest: null,
    async request({ origins }) {
      state.requested.push([...origins]);
      if (state.failRequest) throw state.failRequest;
      if (!state.allow) return false;
      for (const origin of origins) state.granted.add(origin);
      return true;
    },
    async contains({ origins }) {
      return origins.every((origin) => state.granted.has(origin));
    },
    async remove({ origins }) {
      for (const origin of origins) state.granted.delete(origin);
      return true;
    },
  };
  return state;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON request body, or undefined for a GET. */
  body: unknown;
  init: RequestInit;
}

export type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export interface TestEnv extends ExtEnv {
  local: MemoryArea;
  session: MemoryArea;
  permissions: FakePermissions;
  /** null when `locks: false` was requested, which is how a browser without Web Locks behaves. */
  locks: LocksLike | null;
  /** Every request the extension attempted, including ones that failed. */
  readonly requests: RecordedRequest[];
  /** Replaces the responder. Throwing from a responder looks like an unreachable server. */
  respond(responder: Responder): void;
  setNow(ms: number): void;
  advance(ms: number): void;
}

export const UNREACHABLE: Responder = () => {
  throw new Error('connection refused');
};

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface TestEnvOptions {
  now?: number;
  local?: Record<string, unknown>;
  session?: Record<string, unknown>;
  granted?: string[];
  locks?: boolean;
  version?: string;
}

/** A deterministic ExtEnv: fixed clock, counting random source, real SHA-256. */
export function testEnv(options: TestEnvOptions = {}): TestEnv {
  let now = options.now ?? Date.parse('2026-09-18T09:00:00.000Z');
  let responder: Responder = UNREACHABLE;
  let randomSeed = 1;
  const requests: RecordedRequest[] = [];
  const env: TestEnv = {
    local: memoryArea(options.local ?? {}),
    session: memoryArea(options.session ?? {}),
    permissions: fakePermissions(options.granted ?? []),
    locks: options.locks === false ? null : memoryLocks(),
    requests,
    respond(next) {
      responder = next;
    },
    setNow(ms) {
      now = ms;
    },
    advance(ms) {
      now += ms;
    },
    fetch: async (url, init) => {
      const headers = { ...((init.headers as Record<string, string>) ?? {}) };
      const raw = typeof init.body === 'string' ? init.body : undefined;
      const request: RecordedRequest = {
        url,
        method: init.method ?? 'GET',
        headers,
        body: raw === undefined ? undefined : JSON.parse(raw),
        init,
      };
      requests.push(request);
      return responder(request);
    },
    now: () => now,
    randomBytes: (length) => Uint8Array.from({ length }, () => (randomSeed = (randomSeed * 1103515245 + 12345) % 256)),
    sha256: async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)),
    extensionVersion: options.version ?? '0.1.0',
  };
  return env;
}
