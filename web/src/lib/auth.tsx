"use client";

/**
 * Auth context. Two implementations behind NEXT_PUBLIC_AUTH_MODE:
 *
 * - "mock" (default): fixed dev user + "mock-token", ready immediately,
 *   action methods are no-ops. No network, no Firebase — what local dev
 *   and tests run against (the SDK must stay out of the mock bundle, so
 *   all firebase access goes through the lazy imports in lib/firebase.ts).
 * - "firebase": real Firebase auth (same project as mobile). There is NO
 *   anonymous fallback — the web product requires a real account; getToken
 *   rejects when signed out and RequireAuth routes to /signin.
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
  deleteAccount(): Promise<void>;
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
  "auth/too-many-requests":
    "Too many attempts — wait a moment and try again.",
  "auth/network-request-failed":
    "Network error — check your connection and try again.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/requires-recent-login":
    "For security, this action needs a fresh session — sign out, sign in again, then retry.",
};

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

// Stable getToken implementations (never re-created across renders).
async function getMockToken(): Promise<string> {
  return "mock-token";
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(
    AUTH_MODE === "mock" ? MOCK_USER : null,
  );
  const [ready, setReady] = useState(AUTH_MODE === "mock");

  useEffect(() => {
    if (AUTH_MODE !== "firebase") return;
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
  }, []);

  const signInWithGoogle = useCallback(async () => {
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
        const auth = await getFirebaseAuth();
        const { signInWithEmailAndPassword } = await import("firebase/auth");
        await signInWithEmailAndPassword(auth, email, password);
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
        const auth = await getFirebaseAuth();
        const { createUserWithEmailAndPassword } = await import(
          "firebase/auth"
        );
        await createUserWithEmailAndPassword(auth, email, password);
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
      const auth = await getFirebaseAuth();
      const { sendPasswordResetEmail } = await import("firebase/auth");
      await sendPasswordResetEmail(auth, email);
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const signOutUser = useCallback(async () => {
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
      const current = await requireFirebaseUser();
      const { updateProfile } = await import("firebase/auth");
      await updateProfile(current, { displayName: name });
      setUser(toAuthUser(current));
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const deleteAccount = useCallback(async () => {
    try {
      const current = await requireFirebaseUser();
      await current.delete();
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () =>
      AUTH_MODE === "mock"
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
            deleteAccount: mockNoop,
          }
        : {
            user,
            ready,
            getToken: getFirebaseToken,
            signInWithGoogle,
            signInWithEmail,
            signUpWithEmail,
            resetPassword,
            signOutUser,
            updateDisplayName,
            deleteAccount,
          },
    [
      user,
      ready,
      signInWithGoogle,
      signInWithEmail,
      signUpWithEmail,
      resetPassword,
      signOutUser,
      updateDisplayName,
      deleteAccount,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
