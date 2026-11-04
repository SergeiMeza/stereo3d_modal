import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../App";
import { AdminSession, memoryStorage } from "../lib/adminSession";
import { AdminApi } from "../lib/api";
import type { AdminAuth, AuthState } from "../lib/auth";
import { mockFetch } from "./mockGateway";

/** The console signed in against the mock gateway (overlay checks only). */
export function mount() {
  const state: AuthState = { kind: "passkey", email: "owner@example.com", uid: "owner" };
  const auth: AdminAuth = {
    getState: () => state,
    subscribe: () => () => {},
    signIn: async () => {},
    reauthenticate: async () => {},
    getToken: async () => "mock-token",
    reportProblem: () => {},
    recheck: async () => {},
    signOut: async () => {},
  };
  const session = new AdminSession(memoryStorage());
  session.set("mock-session");
  const api = new AdminApi({ baseUrl: "https://gateway.invalid", getToken: auth.getToken, fetchImpl: mockFetch, session });
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App auth={auth} api={api} />
    </StrictMode>,
  );
}
