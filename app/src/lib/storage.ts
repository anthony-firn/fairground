/** Device-local settings and state. Storage can be unavailable (private windows), so every call tolerates failure. */
const PREFIX = 'fairground.';
let changed: (() => void) | undefined;

/** Called after every save; the vault uses it to keep a signed-in account in sync. */
export function onChange(listener: () => void): void {
  changed = listener;
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    changed?.();
  } catch {
    // Settings simply won't persist.
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Nothing to remove.
  }
}
