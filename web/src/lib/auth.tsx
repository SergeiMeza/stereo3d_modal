"use client";

/**
 * Auth context. NEXT_PUBLIC_AUTH_MODE picks mock or live auth, and live
 * auth has two implementations by region (lib/region.ts):
 *
 * - "mock" (default): fixed dev user + "mock-token", ready immediately,
 *   action methods are no-ops. No network, no Firebase — what local dev
 *   and tests run against (the SDK must stay out of the mock bundle, so
 *   all firebase access goes through the lazy imports in lib/firebase.ts).
 * - "firebase", global: real Firebase auth (same project as mobile). There
 *   is NO anonymous fallback — the web product requires a real account;
 *   getToken rejects when signed out and RequireAuth routes to /signin.
 * - "firebase", China mode: the same Firebase accounts, signed in through
 *   the gateway's /v1/auth/* routes (lib/gatewayAuth.ts), email only. The
 *   Firebase SDK is never loaded: every SDK call below sits behind a
 *   region check made at call time.
 *
 * The region is settled only on the client, so until it is (server render,
 * hydration) live auth reports ready=false, as the SDK did while restoring
 * its session.
 *
 * getToken is referentially stable across renders: useGateway memoizes the
 * client on it, so a re-created getToken would rebuild the client on every
 * user-state change. Firebase error codes are mapped to human messages in
 * one place (friendlyAuthError) so every screen surfaces the same copy.
 */

import type { User } from "firebase/auth";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { track, upgradeSession } from "@/lib/analytics";
import { getFirebaseAuth } from "@/lib/firebase";
import {
  gatewayResetPassword,
  gatewaySession,
  gatewaySignIn,
  gatewaySignOut,
  gatewaySignUp,
  gatewayUpdateDisplayName,
  getGatewayToken,
  refreshGatewaySession,
  reloadGatewaySession,
  REFRESH_MARGIN_MS,
  subscribeGatewaySession,
} from "@/lib/gatewayAuth";
import type { GatewaySession } from "@/lib/gatewayAuth";
import { currentRegion } from "@/lib/region";
import { useRegion } from "@/lib/useRegion";

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerIds: string[];
}

export interface AuthContextValue {
  user: AuthUser | null;
  ready: boolean;
  getToken(): Promise<string>;
  signInWithGoogle(): Promise<void>;
  signInWithEmail(email: string, password: string): Promise<void>;
  signUpWithEmail(email: string, password: string): Promise<void>;
  resetPassword(email: string): Promise<void>;
  signOutUser(): Promise<void>;
  updateDisplayName(name: string): Promise<void>;
}

type AuthMode = "mock" | "firebase";

export const AUTH_MODE: AuthMode =
  process.env.NEXT_PUBLIC_AUTH_MODE === "firebase" ? "firebase" : "mock";

const MOCK_USER: AuthUser = {
  uid: "dev-user",
  email: "dev@example.com",
  displayName: "Dev User",
  photoURL: null,
  providerIds: ["password"],
};

const SIGNED_OUT_MESSAGE = "You are signed out. Sign in to continue.";

// -------------------------------------------------------- error mapping

const FRIENDLY_BY_CODE: Record<string, string> = {
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "No account found with that email.",
  "auth/invalid-email": "That email address is not valid.",
  "auth/email-already-in-use":
    "An account with that email already exists — sign in instead.",
  "auth/weak-password": "Password is too weak — use at least 6 characters.",
  "auth/missing-password": "Enter your password.",
  "auth/popup-closed-by-user":
    "The sign-in window was closed before finishing. Try again.",
  "auth/cancelled-popup-request":
    "The sign-in window was closed before finishing. Try again.",
  "auth/popup-blocked":
    "Your browser blocked the sign-in popup — allow popups and try again.",
  "auth/too-many-requests": "Too many attempts — wait a moment and try again.",
  "auth/network-request-failed":
    "Network error — check your connection and try again.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/requires-recent-login":
    "For security, this action needs a fresh session — sign out, sign in again, then retry.",
  // Gateway sign-in (China mode) — the gateway's stable error codes.
  invalid_credentials: "Incorrect email or password.",
  invalid_email: "That email address is not valid.",
  email_exists: "An account with that email already exists — sign in instead.",
  weak_password: "Password is too weak — use at least 6 characters.",
  missing_password: "Enter your password.",
  too_many_attempts: "Too many attempts — wait a moment and try again.",
  rate_limited: "Too many attempts — wait a moment and try again.",
  user_disabled: "This account has been disabled.",
  operation_not_allowed: "Sign in with your email.",
  invalid_refresh_token: SIGNED_OUT_MESSAGE,
  invalid_token: SIGNED_OUT_MESSAGE,
  signed_out: SIGNED_OUT_MESSAGE,
  network: "Network error — check your connection and try again.",
  auth_unavailable: "Sign-in is unavailable right now. Try again in a moment.",
};

/** China mode signs in by email only. */
const EMAIL_ONLY_MESSAGE = "Sign in with your email.";

function friendlyAuthError(error: unknown): Error {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const friendly = FRIENDLY_BY_CODE[code];
  if (friendly !== undefined) return new Error(friendly);
  if (error instanceof Error && error.message) return error;
  return new Error("Authentication failed. Try again.");
}

// ------------------------------------------------------------- firebase

function toAuthUser(u: User): AuthUser {
  return {
    uid: u.uid,
    email: u.email,
    displayName: u.displayName,
    photoURL: u.photoURL,
    providerIds: u.providerData.map((p) => p.providerId),
  };
}

/** Current Firebase user after the SDK restored any persisted session. */
async function settledFirebaseUser(): Promise<User | null> {
  const auth = await getFirebaseAuth();
  if (auth.currentUser) return auth.currentUser;
  const { onAuthStateChanged } = await import("firebase/auth");
  return new Promise<User | null>((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      unsubscribe();
      resolve(u);
    });
  });
}

function sessionToAuthUser(s: GatewaySession): AuthUser {
  return {
    uid: s.uid,
    email: s.email,
    displayName: s.displayName,
    photoURL: null,
    providerIds: ["password"],
  };
}

/** Live auth goes through the gateway (China mode). Read at call time. */
function viaGateway(): boolean {
  return currentRegion() === "cn";
}

// Stable getToken implementations (never re-created across renders).
async function getMockToken(): Promise<string> {
  return "mock-token";
}

/** Live mode: the gateway session in China mode, else the SDK user. */
async function getLiveToken(): Promise<string> {
  if (viaGateway()) {
    try {
      return await getGatewayToken();
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }
  return getFirebaseToken();
}

async function getFirebaseToken(): Promise<string> {
  const user = await settledFirebaseUser();
  if (!user) throw new Error(SIGNED_OUT_MESSAGE);
  return user.getIdToken();
}

async function requireFirebaseUser(): Promise<User> {
  const user = await settledFirebaseUser();
  if (!user) throw new Error(SIGNED_OUT_MESSAGE);
  return user;
}

// ------------------------------------------------------- mock behaviors

async function mockNoop(): Promise<void> {}

async function mockSignOut(): Promise<void> {
  console.warn("auth: signOut is a no-op in mock mode");
}

// -------------------------------------------------------------- context

const AuthContext = createContext<AuthContextValue | null>(null);

type ActiveMode = "mock" | "firebase" | "gateway" | "pending";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const region = useRegion();
  const mode: ActiveMode =
    AUTH_MODE === "mock"
      ? "mock"
      : region === null
        ? "pending"
        : region === "cn"
          ? "gateway"
          : "firebase";

  const [user, setUser] = useState<AuthUser | null>(
    AUTH_MODE === "mock" ? MOCK_USER : null,
  );
  const [ready, setReady] = useState(AUTH_MODE === "mock");

  useEffect(() => {
    if (mode !== "firebase") return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      const auth = await getFirebaseAuth();
      const { onAuthStateChanged } = await import("firebase/auth");
      if (cancelled) return;
      unsubscribe = onAuthStateChanged(auth, (u) => {
        setUser(u ? toAuthUser(u) : null);
        setReady(true);
      });
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [mode]);

  // China mode: mirror the gateway session, refresh the ID token a few
  // minutes before it expires, and follow sign-ins/outs in other tabs.
  useEffect(() => {
    if (mode !== "gateway") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = (s: GatewaySession | null) => {
      setUser(s ? sessionToAuthUser(s) : null);
      setReady(true);
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (s === null) return;
      const wait = Math.max(0, s.expiresAt - Date.now() - REFRESH_MARGIN_MS);
      timer = setTimeout(() => {
        void refreshGatewaySession().catch(() => {});
      }, wait);
    };
    const unsubscribe = subscribeGatewaySession(follow);
    follow(gatewaySession());
    const onStorage = () => reloadGatewaySession();
    window.addEventListener("storage", onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener("storage", onStorage);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [mode]);

  const signInWithGoogle = useCallback(async () => {
    if (viaGateway()) throw new Error(EMAIL_ONLY_MESSAGE);
    try {
      const auth = await getFirebaseAuth();
      const { GoogleAuthProvider, getAdditionalUserInfo, signInWithPopup } =
        await import("firebase/auth");
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      const isNewUser = getAdditionalUserInfo(result)?.isNewUser === true;
      track(isNewUser ? "sign_up" : "login", { method: "google" });
      if (isNewUser) upgradeSession("new-account");
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      try {
        if (viaGateway()) {
          await gatewaySignIn(email, password);
        } else {
          const auth = await getFirebaseAuth();
          const { signInWithEmailAndPassword } = await import("firebase/auth");
          await signInWithEmailAndPassword(auth, email, password);
        }
        track("login", { method: "password" });
      } catch (e) {
        throw friendlyAuthError(e);
      }
    },
    [],
  );

  const signUpWithEmail = useCallback(
    async (email: string, password: string) => {
      try {
        if (viaGateway()) {
          await gatewaySignUp(email, password);
        } else {
          const auth = await getFirebaseAuth();
          const { createUserWithEmailAndPassword } =
            await import("firebase/auth");
          await createUserWithEmailAndPassword(auth, email, password);
        }
        track("sign_up", { method: "password" });
        upgradeSession("new-account");
      } catch (e) {
        throw friendlyAuthError(e);
      }
    },
    [],
  );

  const resetPassword = useCallback(async (email: string) => {
    try {
      if (viaGateway()) {
        await gatewayResetPassword(email);
        return;
      }
      const auth = await getFirebaseAuth();
      const { sendPasswordResetEmail } = await import("firebase/auth");
      await sendPasswordResetEmail(auth, email);
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const signOutUser = useCallback(async () => {
    if (viaGateway()) {
      gatewaySignOut();
      return;
    }
    try {
      const auth = await getFirebaseAuth();
      const { signOut } = await import("firebase/auth");
      await signOut(auth);
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const updateDisplayName = useCallback(async (name: string) => {
    try {
      if (viaGateway()) {
        await gatewayUpdateDisplayName(name);
        return;
      }
      const current = await requireFirebaseUser();
      const { updateProfile } = await import("firebase/auth");
      await updateProfile(current, { displayName: name });
      setUser(toAuthUser(current));
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () =>
      mode === "mock"
        ? {
            user,
            ready,
            getToken: getMockToken,
            signInWithGoogle: mockNoop,
            signInWithEmail: mockNoop,
            signUpWithEmail: mockNoop,
            resetPassword: mockNoop,
            signOutUser: mockSignOut,
            updateDisplayName: mockNoop,
          }
        : {
            user,
            ready,
            getToken: getLiveToken,
            signInWithGoogle,
            signInWithEmail,
            signUpWithEmail,
            resetPassword,
            signOutUser,
            updateDisplayName,
          },
    [
      mode,
      user,
      ready,
      signInWithGoogle,
      signInWithEmail,
      signUpWithEmail,
      resetPassword,
      signOutUser,
      updateDisplayName,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
