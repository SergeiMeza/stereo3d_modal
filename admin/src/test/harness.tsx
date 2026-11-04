import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { App } from "../App";
import { memoryStorage, AdminSession } from "../lib/adminSession";
import { AdminApi } from "../lib/api";
import type { AdminAuth, AuthState } from "../lib/auth";

export const GATEWAY = "https://gw.test";

type Handler = (req: { method: string; path: string; body: unknown; headers: Record<string, string> }) =>
  | { status?: number; json?: unknown; text?: string }
  | Promise<{ status?: number; json?: unknown; text?: string }>;

/** A fetch that answers "METHOD /path" (path without the query) from a table. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, path: u.pathname, body, headers });
    const key = `${method} ${u.pathname}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: "not_found", message: `no route ${key}` }), { status: 404 });
    const r = await h({ method, path: u.pathname + u.search, body, headers });
    if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200, headers: { "Content-Type": "text/csv" } });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

export function apiError(status: number, error: string, message: string, details?: Record<string, unknown>) {
  return { status, json: { success: false, error, message, details } };
}

export class FakeAuth implements AdminAuth {
  state: AuthState;
  listeners = new Set<() => void>();
  tokens = 0;
  reauths = 0;
  problems: string[] = [];

  /** Google done with the claim; with a passkey session (renderApp's
   * default) the console is open. */
  constructor(state: AuthState = { kind: "passkey", email: "owner@example.com", uid: "owner" }) {
    this.state = state;
  }
  set(s: AuthState) {
    this.state = s;
    this.listeners.forEach((l) => l());
  }
  getState = () => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  signIn = vi.fn(async () => {});
  reauthenticate = vi.fn(async () => {
    this.reauths++;
  });
  getToken = vi.fn(async (force?: boolean) => {
    if (force) this.tokens++;
    return `token-${this.tokens}`;
  });
  reportProblem = vi.fn((p: string) => {
    this.problems.push(p);
  });
  recheck = vi.fn(async () => {});
  signOut = vi.fn(async () => {
    this.set({ kind: "signed_out" });
  });
}

/** A passkey session, as after "Use your passkey". */
export function passkeySession(token = "sess_test") {
  const s = new AdminSession(memoryStorage());
  s.set(token);
  return s;
}

/** No passkey session yet: the passkey step shows. */
export function noSession() {
  return new AdminSession(memoryStorage());
}

export function renderApp(
  path: string,
  routes: Record<string, Handler>,
  auth = new FakeAuth(),
  session = passkeySession(),
) {
  const { fetch, calls } = fakeFetch(routes);
  const api = new AdminApi({
    baseUrl: GATEWAY,
    getToken: (f) => auth.getToken(f),
    onSessionProblem: (p) => auth.reportProblem(p),
    fetchImpl: fetch,
    session,
  });
  window.history.replaceState(null, "", path);
  const utils = render(<App auth={auth} api={api} initialPath={path} />);
  return { ...utils, calls, auth, api };
}

/** A Sonner toast's title (toasts live in the aria-live Notifications region). */
export function findToast(text: string | RegExp) {
  return screen.findByText(text, { selector: "[data-sonner-toast] [data-title]" });
}
