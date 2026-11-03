import type { SessionProblem } from "./api";

/**
 * Sign-in state for the console (A0). The Firebase implementation lives in
 * firebaseAuth.ts; tests pass a fake.
 */
export type AuthState =
  | { kind: "loading" }
  | {
      kind: "signed_out";
      /** expired: the session ended; enrolled: a factor was just added. */
      notice?: "expired" | "enrolled";
      error?: string;
    }
  /** Google is done; the authenticator code is next. */
  | { kind: "code"; label: string; error?: string }
  /** Signed in with the claim but no second factor yet. */
  | { kind: "enrol"; email: string; hasFactor: boolean; error?: string }
  | { kind: "no_access"; email: string }
  | { kind: "ready"; email: string; uid: string };

export interface Enrolment {
  qrDataUrl: string;
  secretKey: string;
}

export interface AdminAuth {
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  signIn(): Promise<void>;
  submitCode(code: string): Promise<void>;
  startEnrolment(): Promise<Enrolment>;
  finishEnrolment(code: string): Promise<void>;
  /** Fresh sign-in for money actions: "code" when a code is needed next. */
  reauthenticate(): Promise<"done" | "code">;
  submitReauthCode(code: string): Promise<void>;
  getToken(force?: boolean): Promise<string | null>;
  /** The gateway refused the session (expired token, no claim, no MFA). */
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
    case "auth/invalid-verification-code":
    case "auth/invalid-totp-code":
    case "auth/missing-code":
      return "That code didn't work. Enter the current code from your authenticator app.";
    case "auth/operation-not-allowed":
    case "auth/admin-restricted-operation":
    case "auth/unsupported-first-factor":
      return "Second factors aren't turned on for this Firebase project yet (BL-23).";
    case "auth/requires-recent-login":
      return "Sign in again, then add the second factor.";
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
