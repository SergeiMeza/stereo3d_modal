import type { SessionProblem } from "./api";

/**
 * Sign-in state for the console (A0): Google (Firebase), then the passkey
 * (ADR 0135; the passkey session lives in AdminSession). The Firebase
 * implementation lives in firebaseAuth.ts; tests pass a fake.
 */
export type AuthState =
  | { kind: "loading" }
  | {
      kind: "signed_out";
      /** expired: the session ended. */
      notice?: "expired";
      error?: string;
    }
  /** Google is done and the claim is there; the passkey is next. */
  | { kind: "passkey"; email: string; uid: string }
  | { kind: "no_access"; email: string };

export interface AdminAuth {
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  signIn(): Promise<void>;
  /** A fresh Google sign-in (the first passkey needs one within 5 minutes). */
  reauthenticate(): Promise<void>;
  getToken(force?: boolean): Promise<string | null>;
  /** The gateway refused the Google session (expired token, no claim). */
  reportProblem(problem: SessionProblem): void;
  /** Re-reads the claims (after the owner sets svs_admin). */
  recheck(): Promise<void>;
  signOut(): Promise<void>;
}

/** Messages for Firebase auth error codes, without leaking internals. */
export function authErrorMessage(code: string | undefined): string {
  switch (code) {
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was closed before it finished.";
    case "auth/popup-blocked":
      return "The browser blocked the sign-in window. Allow pop-ups for this site and try again.";
    case "auth/user-mismatch":
      return "That was a different Google account. Sign in with the admin account.";
    case "auth/network-request-failed":
      return "Couldn't reach Google. Check the connection and try again.";
    case "auth/unauthorized-domain":
      return "This domain isn't authorized for sign-in in Firebase (BL-23).";
    default:
      return "Sign-in didn't work. Try again.";
  }
}
