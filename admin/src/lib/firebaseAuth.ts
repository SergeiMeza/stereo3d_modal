import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserSessionPersistence,
  getAuth,
  getMultiFactorResolver,
  GoogleAuthProvider,
  multiFactor,
  onAuthStateChanged,
  reauthenticateWithPopup,
  setPersistence,
  signInWithPopup,
  signOut as fbSignOut,
  TotpMultiFactorGenerator,
  type Auth,
  type MultiFactorError,
  type MultiFactorResolver,
  type TotpSecret,
  type User,
} from "firebase/auth";
import QRCode from "qrcode";

import type { SessionProblem } from "./api";
import { authErrorMessage, type AdminAuth, type AuthState, type Enrolment } from "./auth";
import { FIREBASE_AUTH_DOMAIN } from "./csp";

/**
 * The shared spatial-video-studio Firebase project, the same public web
 * config as the customer web app (web/src/lib/firebase.ts). This console
 * never changes Firebase settings; it only signs in.
 *
 * Second factor: an authenticator app (TOTP). SMS would need reCAPTCHA
 * scripts, which the console's CSP doesn't allow.
 */
const CONFIG = {
  apiKey: "AIzaSyCZcwCfTeRhsLjmPHXUPMEU7xNUserJESQ",
  authDomain: FIREBASE_AUTH_DOMAIN,
  projectId: "spatial-video-studio",
  appId: "1:151335782809:web:3bc67dc51717ad72a76b08",
};

const ISSUER = "Spatial Video Studio admin";

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
  let resolver: MultiFactorResolver | null = null;
  let reauthResolver: MultiFactorResolver | null = null;
  let secret: TotpSecret | null = null;
  let wasReady = false;
  let pendingNotice: "expired" | "enrolled" | undefined;

  const set = (next: AuthState) => {
    state = next;
    if (next.kind === "ready") wasReady = true;
    listeners.forEach((l) => l());
  };

  const provider = () => {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: "select_account" });
    return p;
  };

  const totpHint = (r: MultiFactorResolver) =>
    r.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);

  async function evaluate(user: User, force = false) {
    const token = await user.getIdTokenResult(force);
    const email = user.email ?? token.claims.email?.toString() ?? "";
    if (token.claims.svs_admin !== true) {
      set({ kind: "no_access", email });
      return;
    }
    const fb = token.claims.firebase as { sign_in_second_factor?: string } | undefined;
    if (!fb?.sign_in_second_factor) {
      // ADR 0135: the passkey is the second step; the authenticator code
      // (enrol) stays one link away on that screen.
      set({
        kind: "passkey",
        email,
        uid: user.uid,
        hasFactor: multiFactor(user).enrolledFactors.length > 0,
      });
      return;
    }
    set({ kind: "ready", email, uid: user.uid });
  }

  void ready.then(() =>
    onAuthStateChanged(auth, (user) => {
      if (!user) {
        const notice = pendingNotice ?? (wasReady ? "expired" : undefined);
        pendingNotice = undefined;
        wasReady = false;
        set({ kind: "signed_out", notice });
        return;
      }
      evaluate(user).catch(() => set({ kind: "signed_out", notice: "expired" }));
    }),
  );

  function startCode(err: unknown, forReauth: boolean): boolean {
    if (errCode(err) !== "auth/multi-factor-auth-required") return false;
    const r = getMultiFactorResolver(auth, err as MultiFactorError);
    if (!totpHint(r)) {
      throw Object.assign(new Error("phone factor"), { code: "svs/phone-factor" });
    }
    if (forReauth) reauthResolver = r;
    else resolver = r;
    return true;
  }

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
        try {
          if (startCode(err, false)) {
            const hint = resolver && totpHint(resolver);
            set({ kind: "code", label: hint?.displayName || "Authenticator app" });
            return;
          }
        } catch {
          set({
            kind: "signed_out",
            error: "This account's second factor is a phone number. The console takes an authenticator app code (BL-23).",
          });
          return;
        }
        set({ kind: "signed_out", error: authErrorMessage(errCode(err)) });
      }
    },

    async submitCode(code) {
      const r = resolver;
      const hint = r && totpHint(r);
      if (!r || !hint) {
        set({ kind: "signed_out", error: "Sign in again." });
        return;
      }
      try {
        await r.resolveSignIn(
          TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.trim()),
        );
        resolver = null; // onAuthStateChanged takes it from here
      } catch (err) {
        set({
          kind: "code",
          label: hint.displayName || "Authenticator app",
          error: authErrorMessage(errCode(err)),
        });
      }
    },

    async startEnrolment(): Promise<Enrolment> {
      const user = auth.currentUser;
      if (!user) throw new Error("Sign in first.");
      try {
        const session = await multiFactor(user).getSession();
        secret = await TotpMultiFactorGenerator.generateSecret(session);
      } catch (err) {
        throw new Error(authErrorMessage(errCode(err)));
      }
      const url = secret.generateQrCodeUrl(user.email ?? "admin", ISSUER);
      const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 208 });
      return { qrDataUrl, secretKey: secret.secretKey };
    },

    async finishEnrolment(code) {
      const user = auth.currentUser;
      if (!user || !secret) throw new Error("Start again.");
      try {
        await multiFactor(user).enroll(
          TotpMultiFactorGenerator.assertionForEnrollment(secret, code.trim()),
          "Authenticator app",
        );
      } catch (err) {
        throw new Error(authErrorMessage(errCode(err)));
      }
      secret = null;
      pendingNotice = "enrolled";
      await fbSignOut(auth);
    },

    async reauthenticate() {
      const user = auth.currentUser;
      if (!user) throw new Error("You're signed out.");
      try {
        await reauthenticateWithPopup(user, provider());
      } catch (err) {
        let needsCode = false;
        try {
          needsCode = startCode(err, true);
        } catch {
          throw new Error("The console takes an authenticator app code (BL-23).");
        }
        if (needsCode) return "code";
        throw new Error(authErrorMessage(errCode(err)));
      }
      await user.getIdToken(true);
      return "done";
    },

    async submitReauthCode(code) {
      const r = reauthResolver;
      const hint = r && totpHint(r);
      if (!r || !hint) throw new Error("Start again.");
      try {
        await r.resolveSignIn(
          TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.trim()),
        );
      } catch (err) {
        throw new Error(authErrorMessage(errCode(err)));
      }
      reauthResolver = null;
      await auth.currentUser?.getIdToken(true);
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
      if (problem === "no_access") {
        set({ kind: "no_access", email: user.email ?? "" });
      } else {
        set({
          kind: "enrol",
          email: user.email ?? "",
          hasFactor: multiFactor(user).enrolledFactors.length > 0,
        });
      }
    },

    async recheck() {
      const user = auth.currentUser;
      if (user) await evaluate(user, true);
    },

    async signOut() {
      wasReady = false;
      await fbSignOut(auth);
    },
  };
}
