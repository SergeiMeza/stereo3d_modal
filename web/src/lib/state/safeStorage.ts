/**
 * localStorage for atomWithStorage that never throws (ADR 0138): private
 * mode or blocked storage just means nothing is remembered. Only for
 * plain, non-sensitive UI state.
 */

export function safeJSONStorage<T>() {
  return {
    getItem(key: string, initial: T): T {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? initial : (JSON.parse(raw) as T);
      } catch {
        return initial;
      }
    },
    setItem(key: string, value: T): void {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // no memory then
      }
    },
    removeItem(key: string): void {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // nothing to forget
      }
    },
  };
}
