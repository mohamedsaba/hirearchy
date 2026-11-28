export type PersistedStateScope = 'durable' | 'session';

function safeReadFromStore(
  store: Storage | undefined,
  key: string,
): unknown | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function safeWriteToStore(
  store: Storage | undefined,
  key: string,
  serialized: string,
): boolean {
  if (!store) return false;
  try {
    store.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a persisted JSON value from browser storage safely.
 * For `'durable'` scope, `sessionStorage` is checked before `localStorage` so
 * in-tab updates take precedence while cross-tab and reload recovery work via `localStorage`.
 */
export function readPersistedJson<T>(
  key: string,
  scope: PersistedStateScope = 'durable',
): T | null {
  if (typeof window === 'undefined') return null;

  let sessionVal: unknown = null;
  try {
    sessionVal = safeReadFromStore(window.sessionStorage, key);
  } catch {
    sessionVal = null;
  }
  if (sessionVal !== null) return sessionVal as T;

  if (scope === 'session') return null;

  try {
    const localVal = safeReadFromStore(window.localStorage, key);
    return localVal !== null ? (localVal as T) : null;
  } catch {
    return null;
  }
}

/**
 * Writes a JSON value to `sessionStorage` and, for `'durable'` scope, also
 * mirrors it to `localStorage` for cross-tab and reload recovery.
 */
export function writePersistedJson(
  key: string,
  value: unknown,
  scope: PersistedStateScope = 'durable',
): boolean {
  if (typeof window === 'undefined') return false;

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }

  let wroteSession = false;
  try {
    wroteSession = safeWriteToStore(window.sessionStorage, key, serialized);
  } catch {
    wroteSession = false;
  }

  if (scope === 'session') return wroteSession;

  let wroteLocal = false;
  try {
    wroteLocal = safeWriteToStore(window.localStorage, key, serialized);
  } catch {
    wroteLocal = false;
  }

  return wroteSession || wroteLocal;
}

/**
 * Removes a persisted key from both `sessionStorage` and `localStorage`.
 */
export function removePersistedKey(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage privacy / quota errors
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage privacy / quota errors
  }
}
