import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserSessionPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithPopup,
  setPersistence,
  signInWithPopup,
  signOut as fbSignOut,
  type Auth,
  type User,
} from "firebase/auth";

import type { SessionProblem } from "./api";
import { authErrorMessage, type AdminAuth, type AuthState } from "./auth";
import { FIREBASE_AUTH_DOMAIN } from "./csp";

/**
 * The shared spatial-video-studio Firebase project, the same public web
 * config as the customer web app (web/src/lib/firebase.ts). This console
 * never changes Firebase settings; it only signs in with Google. The second
 * step is the passkey, against the gateway (ADR 0135); Firebase
 * multi-factor and Identity Platform aren't used.
 */
const CONFIG = {
  apiKey: "AIzaSyCZcwCfTeRhsLjmPHXUPMEU7xNUserJESQ",
  authDomain: FIREBASE_AUTH_DOMAIN,
  projectId: "spatial-video-studio",
  appId: "1:151335782809:web:3bc67dc51717ad72a76b08",
};

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

export function createFirebaseAuth(): AdminAuth {
  const app = getApps().length ? getApp() : initializeApp(CONFIG);
  const auth: Auth = getAuth(app);
  const ready = setPersistence(auth, browserSessionPersistence).catch(() => {});

  let state: AuthState = { kind: "loading" };
  const listeners = new Set<() => void>();
  let wasSignedIn = false;
  let pendingNotice: "expired" | undefined;

  const set = (next: AuthState) => {
    state = next;
    if (next.kind === "passkey") wasSignedIn = true;
    listeners.forEach((l) => l());
  };

  const provider = () => {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: "select_account" });
    return p;
  };

  async function evaluate(user: User, force = false) {
    const token = await user.getIdTokenResult(force);
    const email = user.email ?? token.claims.email?.toString() ?? "";
    if (token.claims.svs_admin !== true) {
      set({ kind: "no_access", email });
      return;
    }
    set({ kind: "passkey", email, uid: user.uid });
  }

  void ready.then(() =>
    onAuthStateChanged(auth, (user) => {
      if (!user) {
        const notice = pendingNotice ?? (wasSignedIn ? "expired" : undefined);
        pendingNotice = undefined;
        wasSignedIn = false;
        set({ kind: "signed_out", notice });
        return;
      }
      evaluate(user).catch(() => set({ kind: "signed_out", notice: "expired" }));
    }),
  );

  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },

    async signIn() {
      await ready;
      try {
        await signInWithPopup(auth, provider());
      } catch (err) {
        set({ kind: "signed_out", error: authErrorMessage(errCode(err)) });
      }
    },

    async reauthenticate() {
      const user = auth.currentUser;
      if (!user) throw new Error("You're signed out.");
      try {
        await reauthenticateWithPopup(user, provider());
      } catch (err) {
        throw new Error(authErrorMessage(errCode(err)));
      }
      await user.getIdToken(true);
    },

    async getToken(force = false) {
      await ready;
      const user = auth.currentUser;
      return user ? user.getIdToken(force) : null;
    },

    reportProblem(problem: SessionProblem) {
      const user = auth.currentUser;
      if (problem === "invalid_token" || !user) {
        pendingNotice = "expired";
        void fbSignOut(auth);
        return;
      }
      set({ kind: "no_access", email: user.email ?? "" });
    },

    async recheck() {
      const user = auth.currentUser;
      if (user) await evaluate(user, true);
    },

    async signOut() {
      wasSignedIn = false;
      await fbSignOut(auth);
    },
  };
}
