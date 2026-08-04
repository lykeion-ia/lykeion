/**
 * A working `window.localStorage` for tests, which this environment does not
 * otherwise have — `localStorage` under jsdom here is a bare object with none
 * of Storage's methods on it, which is why production code that touches it
 * does so inside a `try` and why the suites that clear it do the same.
 *
 * Anything the app persists to outlive a tab will, without this, read back
 * empty in every test — so the behaviour that depends on it can never be
 * exercised. Only the four methods the app touches are implemented; a fifth
 * arriving should fail loudly rather than quietly answer undefined.
 */
const originalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

export function installLocalStorage(): void {
  const entries = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
      clear: () => entries.clear(),
    },
  });
}

export function restoreLocalStorage(): void {
  if (originalStorage) {
    Object.defineProperty(window, "localStorage", originalStorage);
  }
}
