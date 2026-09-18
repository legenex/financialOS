/**
 * The small set of browser capabilities the extension uses, behind an interface so that the
 * data layer can be tested without a browser. Only `chrome.storage.local` and
 * `chrome.storage.session` are ever used: synced storage is deliberately not part of this surface.
 */

export interface StorageAreaLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface PermissionsLike {
  request(permissions: { origins: string[] }): Promise<boolean>;
  contains(permissions: { origins: string[] }): Promise<boolean>;
  remove(permissions: { origins: string[] }): Promise<boolean>;
}

export interface LocksLike {
  /** Runs `callback` with `true` when the named lock was free, or `false` without waiting when it is held. */
  ifAvailable<T>(name: string, callback: (acquired: boolean) => Promise<T>): Promise<T>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExtEnv {
  local: StorageAreaLike;
  session: StorageAreaLike;
  permissions: PermissionsLike;
  locks: LocksLike | null;
  fetch: FetchLike;
  now: () => number;
  randomBytes: (length: number) => Uint8Array;
  sha256: (data: Uint8Array) => Promise<Uint8Array>;
  extensionVersion: string;
}

function wrapArea(area: chrome.storage.StorageArea): StorageAreaLike {
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

export function browserEnv(): ExtEnv {
  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return {
    local: wrapArea(chrome.storage.local),
    session: wrapArea(chrome.storage.session),
    // Resolved on every call so the live chrome.permissions object is always used.
    permissions: {
      request: (p) => chrome.permissions.request(p),
      contains: (p) => chrome.permissions.contains(p),
      remove: (p) => chrome.permissions.remove(p),
    },
    locks: lockManager
      ? {
          ifAvailable: (name, callback) =>
            lockManager.request(name, { ifAvailable: true }, (lock) => callback(lock !== null)),
        }
      : null,
    fetch: (url, init) => globalThis.fetch(url, init),
    now: () => Date.now(),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    sha256: async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)),
    extensionVersion: chrome.runtime.getManifest().version,
  };
}
