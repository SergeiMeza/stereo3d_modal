/**
 * The passkey session (ADR 0135): the gateway's X-Admin-Session token with
 * its expires_at and last_assertion_at, kept in sessionStorage only
 * (closing the tab ends it, like the Firebase session) and sent on every
 * admin call. The session ends a little before expires_at, so the console
 * asks for the passkey before a call can fail. Storage can be missing or
 * throw (private windows, blocked site data); the session then lives in
 * memory.
 */

const KEY = "svs_admin_session";
/** Ask for the passkey this long before the gateway's expiry. */
export const SESSION_MARGIN_MS = 2 * 60_000;

export interface SessionInfo {
  token: string;
  /** RFC 3339; absent when the gateway didn't say */
  expires_at?: string;
  last_assertion_at?: string;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class AdminSession {
  private info: SessionInfo | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly storage: Store | null;
  private readonly now: () => number;

  constructor(storage?: Store | null, now: () => number = Date.now) {
    this.storage = storage === undefined ? safeSessionStorage() : storage;
    this.now = now;
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(KEY) ?? null;
    } catch {
      raw = null;
    }
    const info = parse(raw);
    if (info && this.live(info)) {
      this.info = info;
      this.arm();
    } else if (raw) {
      this.remove();
    }
  }

  /** The token, or null when there is none or it's about to expire. */
  get = (): string | null => (this.info && this.live(this.info) ? this.info.token : null);

  details = (): SessionInfo | null => this.info;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  set(token: string, extra: Omit<SessionInfo, "token"> = {}) {
    this.info = { token, ...extra };
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.info));
    } catch {
      // memory only
    }
    this.arm();
    this.emit();
  }

  clear() {
    if (this.info === null) return;
    this.info = null;
    this.disarm();
    this.remove();
    this.emit();
  }

  private live(info: SessionInfo): boolean {
    if (!info.expires_at) return true;
    const t = Date.parse(info.expires_at);
    return Number.isNaN(t) || t - SESSION_MARGIN_MS > this.now();
  }

  private arm() {
    this.disarm();
    const t = this.info?.expires_at ? Date.parse(this.info.expires_at) : NaN;
    if (Number.isNaN(t)) return;
    // setTimeout caps at ~24.8 days; sessions last hours
    const wait = Math.min(Math.max(0, t - SESSION_MARGIN_MS - this.now()), 2_000_000_000);
    this.timer = setTimeout(() => this.clear(), wait);
  }

  private disarm() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private remove() {
    try {
      this.storage?.removeItem(KEY);
    } catch {
      // nothing stored
    }
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

function parse(raw: string | null): SessionInfo | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SessionInfo;
    if (v && typeof v.token === "string" && v.token) return v;
  } catch {
    // an older plain token
    return { token: raw };
  }
  return null;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** An in-memory storage, for tests. */
export function memoryStorage(): Store {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}
