/**
 * The passkey session (ADR 0135): the gateway's X-Admin-Session token,
 * kept in sessionStorage only (closing the tab ends it, like the Firebase
 * session) and sent on every admin call. Storage can be missing or throw
 * (private windows, blocked site data); the token then lives in memory.
 */

const KEY = "svs_admin_session";

export class AdminSession {
  private token: string | null;
  private readonly listeners = new Set<() => void>();
  private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

  constructor(storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null) {
    this.storage = storage === undefined ? safeSessionStorage() : storage;
    let t: string | null = null;
    try {
      t = this.storage?.getItem(KEY) ?? null;
    } catch {
      t = null;
    }
    this.token = t;
  }

  get = (): string | null => this.token;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  set(token: string) {
    this.token = token;
    try {
      this.storage?.setItem(KEY, token);
    } catch {
      // memory only
    }
    this.listeners.forEach((l) => l());
  }

  clear() {
    if (this.token === null) return;
    this.token = null;
    try {
      this.storage?.removeItem(KEY);
    } catch {
      // nothing stored
    }
    this.listeners.forEach((l) => l());
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** An in-memory storage, for tests. */
export function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}
