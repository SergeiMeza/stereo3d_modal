/**
 * Sign-in through the gateway (China mode, lib/region.ts). The gateway's
 * /v1/auth/* routes return the same Firebase ID and refresh tokens the JS
 * SDK would hold, so the uid is the same account everywhere and every other
 * gateway route accepts the ID token unchanged.
 *
 * The session lives in localStorage (as the SDK keeps its own) and in a
 * module-level copy that lib/auth.tsx subscribes to. getGatewayToken()
 * refreshes the ID token a few minutes before it expires, one refresh at a
 * time; a refresh the gateway refuses (revoked, disabled, expired) signs
 * the user out, while a network failure keeps the session for a retry.
 */

import { gatewayBaseUrl } from "@/lib/region";

export interface GatewaySession {
  uid: string;
  email: string | null;
  displayName: string | null;
  idToken: string;
  refreshToken: string;
  /** ms since epoch when the ID token expires */
  expiresAt: number;
}

/** What the gateway answers for signin / signup / refresh / profile. */
interface SessionAnswer {
  uid: string;
  email?: string;
  display_name?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export class GatewayAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GatewayAuthError";
  }
}

export const SESSION_STORAGE_KEY = "s3d-auth-session";
/** Refresh this long before the ID token expires. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SIGNED_OUT_MESSAGE = "You are signed out. Sign in to continue.";

// ------------------------------------------------------------- storage

let current: GatewaySession | null | undefined; // undefined: not loaded yet
const listeners = new Set<(s: GatewaySession | null) => void>();

function isSession(v: unknown): v is GatewaySession {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.uid === "string" &&
    s.uid !== "" &&
    typeof s.idToken === "string" &&
    typeof s.refreshToken === "string" &&
    s.refreshToken !== "" &&
    typeof s.expiresAt === "number"
  );
}

function load(): GatewaySession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function store(session: GatewaySession | null): void {
  current = session;
  try {
    if (session === null) window.localStorage.removeItem(SESSION_STORAGE_KEY);
    else
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // storage blocked: the session lasts as long as the tab
  }
  for (const fn of listeners) fn(session);
}

/** The signed-in session, or null. */
export function gatewaySession(): GatewaySession | null {
  if (current === undefined) current = typeof window === "undefined" ? null : load();
  return current;
}

/** Called with every change (sign-in, refresh, sign-out); returns unsubscribe. */
export function subscribeGatewaySession(
  fn: (s: GatewaySession | null) => void,
): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-read storage (another tab signed in or out). */
export function reloadGatewaySession(): void {
  const next = load();
  if (JSON.stringify(next) !== JSON.stringify(current ?? null)) {
    current = next;
    for (const fn of listeners) fn(next);
  }
}

/** Tests: forget the in-memory copy so the next read loads storage. */
export function resetGatewaySessionForTests(): void {
  current = undefined;
  inflightRefresh = null;
  listeners.clear();
}

// ------------------------------------------------------------- network

async function post<T>(
  path: string,
  body: unknown,
  token?: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${gatewayBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GatewayAuthError("network", "network request failed", 0);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON answer
  }
  if (!res.ok) {
    throw new GatewayAuthError(
      typeof parsed.error === "string" ? parsed.error : "auth_unavailable",
      typeof parsed.message === "string"
        ? parsed.message
        : `request failed (${res.status})`,
      res.status,
    );
  }
  return parsed as T;
}

function sessionFrom(
  a: SessionAnswer,
  previous: GatewaySession | null = null,
): GatewaySession {
  const idToken = a.id_token || previous?.idToken || "";
  const refreshToken = a.refresh_token || previous?.refreshToken || "";
  if (!a.uid || !idToken || !refreshToken) {
    throw new GatewayAuthError("auth_unavailable", "incomplete answer", 502);
  }
  const expiresAt = a.id_token
    ? Date.now() + (a.expires_in && a.expires_in > 0 ? a.expires_in : 3600) * 1000
    : (previous?.expiresAt ?? Date.now());
  return {
    uid: a.uid,
    email: a.email || previous?.email || null,
    displayName: a.display_name || previous?.displayName || null,
    idToken,
    refreshToken,
    expiresAt,
  };
}

// ------------------------------------------------------------- actions

export async function gatewaySignIn(
  email: string,
  password: string,
): Promise<GatewaySession> {
  const answer = await post<SessionAnswer>("/v1/auth/signin", {
    email,
    password,
  });
  const session = sessionFrom(answer);
  store(session);
  return session;
}

export async function gatewaySignUp(
  email: string,
  password: string,
): Promise<GatewaySession> {
  const answer = await post<SessionAnswer>("/v1/auth/signup", {
    email,
    password,
  });
  const session = sessionFrom(answer);
  store(session);
  return session;
}

export async function gatewayResetPassword(email: string): Promise<void> {
  await post("/v1/auth/reset", { email });
}

/** Set a new password with the code from the reset email (the site's own
 * reset page). Answers the account's email. Refusals: reset_link_expired,
 * reset_link_invalid, weak_password. */
export async function gatewayConfirmPasswordReset(
  oob: string,
  newPassword: string,
): Promise<{ email: string | null }> {
  const answer = await post<{ email?: string }>("/v1/auth/reset/confirm", {
    oob,
    new_password: newPassword,
  });
  return { email: answer.email || null };
}

export function gatewaySignOut(): void {
  store(null);
}

let inflightRefresh: Promise<GatewaySession> | null = null;

/** A fresh ID token now, one refresh at a time. */
export function refreshGatewaySession(): Promise<GatewaySession> {
  const session = gatewaySession();
  if (session === null) {
    return Promise.reject(
      new GatewayAuthError("signed_out", SIGNED_OUT_MESSAGE, 401),
    );
  }
  inflightRefresh ??= (async () => {
    try {
      const answer = await post<SessionAnswer>("/v1/auth/refresh", {
        refresh_token: session.refreshToken,
      });
      // Signed out (or in as someone else) while this was in flight.
      if (gatewaySession()?.refreshToken !== session.refreshToken) {
        throw new GatewayAuthError("signed_out", SIGNED_OUT_MESSAGE, 401);
      }
      const next = sessionFrom(answer, session);
      store(next);
      return next;
    } catch (e) {
      // Refused for good (revoked, disabled, expired): sign out. A network
      // failure or a busy gateway keeps the session for the next try.
      if (
        e instanceof GatewayAuthError &&
        (e.status === 401 || e.status === 403) &&
        gatewaySession()?.refreshToken === session.refreshToken
      ) {
        store(null);
      }
      throw e;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/** The ID token for gateway calls, refreshed when it is about to expire. */
export async function getGatewayToken(): Promise<string> {
  const session = gatewaySession();
  if (session === null) {
    throw new GatewayAuthError("signed_out", SIGNED_OUT_MESSAGE, 401);
  }
  if (session.expiresAt - Date.now() > REFRESH_MARGIN_MS) return session.idToken;
  return (await refreshGatewaySession()).idToken;
}

export async function gatewayUpdateDisplayName(
  name: string,
): Promise<GatewaySession> {
  const token = await getGatewayToken();
  const answer = await post<SessionAnswer>(
    "/v1/auth/profile",
    { display_name: name },
    token,
  );
  const previous = gatewaySession();
  const next = sessionFrom(answer, previous);
  store({ ...next, displayName: name });
  return gatewaySession() as GatewaySession;
}
