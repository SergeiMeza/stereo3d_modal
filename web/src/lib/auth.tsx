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
 * Sign-in methods (S3D-70): Apple (behind NEXT_PUBLIC_APPLE_SIGNIN=1 until
 * the owner configures it, BL-15; popup on desktop, redirect on phones and
 * headsets), Google (not in China mode), and a one-time email code
 * (lib/emailCode.ts) — no passwords in the UI; older password accounts sign
 * in with a code to the same address. One account per email (S3D-69): when
 * Apple or Google answers that the address already has an account, the
 * credential waits (pendingLink) while the person confirms with an email
 * code, then it is linked onto that account.
 *
 * getToken is referentially stable across renders: useGateway memoizes the
 * client on it, so a re-created getToken would rebuild the client on every
 * user-state change. Firebase error codes are mapped to human messages in
 * one place (friendlyAuthError) so every screen surfaces the same copy.
 */

import type { AuthCredential, User, UserCredential } from "firebase/auth";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { track, upgradeSession } from "@/lib/analytics";
import {
  EmailCodeError,
  RESEND_AFTER_S,
  startEmailCode,
  verifyEmailCode,
} from "@/lib/emailCode";
import type { CodeStart } from "@/lib/emailCode";
import { getFirebaseAuth } from "@/lib/firebase";
import {
  gatewayAdoptSession,
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
import { detectClient, isHeadset } from "@/lib/headset";
import { passkeySignIn } from "@/lib/passkeys";
import { currentRegion, gatewayBaseUrl } from "@/lib/region";
import { useRegion } from "@/lib/useRegion";

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  providerIds: string[];
}

/** Providers a person can add or remove on the account page. */
export type LinkableProvider = "apple.com" | "google.com";

/** Apple or Google answered that this address already has an account: the
 * credential waits until the person confirms with an email code. */
export interface PendingLink {
  email: string;
  providerId: LinkableProvider;
}

export interface AuthContextValue {
  user: AuthUser | null;
  ready: boolean;
  getToken(): Promise<string>;
  /** Sign in with Apple is offered (configured, not China mode). */
  appleEnabled: boolean;
  signInWithApple(): Promise<void>;
  /** Mail a one-time code (S3D-70). */
  sendEmailCode(email: string): Promise<CodeStart>;
  /** Sign in with the code; links a pendingLink for the same address. */
  signInWithEmailCode(email: string, code: string): Promise<void>;
  pendingLink: PendingLink | null;
  clearPendingLink(): void;
  /** What a redirect sign-in or link said when it came back here. */
  redirectError: string | null;
  linkProvider(id: LinkableProvider): Promise<void>;
  unlinkProvider(id: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  /** ADR 0136: sign in with a passkey (the button, or the email field's
   * autofill); throws PasskeyError. */
  signInWithPasskey(opts?: { autofill?: boolean }): Promise<void>;
  /** ADR 0136: a fresh Apple or Google sign-in for the signed-in account
   * (adding a passkey needs one from the last 5 minutes). */
  reauthenticate(id: LinkableProvider): Promise<void>;
  signInWithEmail(email: string, password: string): Promise<void>;
  signUpWithEmail(email: string, password: string): Promise<void>;
  resetPassword(email: string): Promise<void>;
  signOutUser(): Promise<void>;
  updateDisplayName(name: string): Promise<void>;
}

type AuthMode = "mock" | "firebase";

export const AUTH_MODE: AuthMode =
  process.env.NEXT_PUBLIC_AUTH_MODE === "firebase" ? "firebase" : "mock";

/** Sign in with Apple on the web lights up once the owner has set up the
 * Services ID and Firebase's Apple provider (BL-15). */
export const APPLE_SIGNIN = process.env.NEXT_PUBLIC_APPLE_SIGNIN === "1";

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
  // Email codes (S3D-70).
  code_invalid: "That code isn't right.",
  code_expired: "That code has expired. Send a new one.",
  resend_too_soon: "Wait a moment, then send a new code.",
  too_many_codes: "Too many codes for this email. Try again in an hour.",
  // Linking (S3D-69).
  "auth/credential-already-in-use":
    "That sign-in already has its own account. Sign out, then sign in with it to use that account.",
  "auth/provider-already-linked": "That's already linked.",
  "auth/unauthorized-domain": "Sign-in isn't available on this address yet.",
  "auth/operation-not-allowed": "That sign-in isn't available yet.",
  "auth/invalid-custom-token": "Sign-in failed. Send a new code.",
  "auth/no-such-provider": "That sign-in isn't linked.",
};

/** China mode signs in by email only. */
const EMAIL_ONLY_MESSAGE = "Sign in with your email.";

function friendlyAuthError(error: unknown): Error {
  if (error instanceof AccountExistsError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const friendly = FRIENDLY_BY_CODE[code];
  if (error instanceof EmailCodeError) {
    // keep retryAfter / attemptsLeft for the code screen
    return new EmailCodeError(
      error.code,
      friendly ?? error.message,
      error.status,
      error.retryAfter,
      error.attemptsLeft,
    );
  }
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

// ------------------------------------------ Apple, linking, redirects

/** Thrown by Apple/Google sign-in when the address already has an account
 * (S3D-69); the screen asks for an email code, then the link completes. */
export class AccountExistsError extends Error {
  constructor(public readonly pending: PendingLink) {
    super(`You already have an account with ${pending.email}.`);
    this.name = "AccountExistsError";
  }
}

const PENDING_KEY = "s3d-pending-link";
const REDIRECT_KEY = "s3d-auth-redirect";

/** Redirect on phones and headsets (popups open a new tab or get lost),
 * popup on desktop. */
export function prefersRedirect(): boolean {
  if (typeof window === "undefined") return false;
  if (isHeadset(detectClient())) return true;
  const mq = (q: string) => window.matchMedia?.(q).matches === true;
  return mq("(pointer: coarse)") && !mq("(pointer: fine)");
}

function errorCode(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : "";
}

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let pendingCredential: AuthCredential | null = null;

function savePending(p: PendingLink, cred: AuthCredential): void {
  pendingCredential = cred;
  session()?.setItem(
    PENDING_KEY,
    JSON.stringify({ ...p, credential: cred.toJSON() }),
  );
}

function readPending(): PendingLink | null {
  try {
    const raw = session()?.getItem(PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingLink>;
    return typeof v.email === "string" &&
      (v.providerId === "apple.com" || v.providerId === "google.com")
      ? { email: v.email, providerId: v.providerId }
      : null;
  } catch {
    return null;
  }
}

async function pendingCredentialNow(): Promise<AuthCredential | null> {
  if (pendingCredential) return pendingCredential;
  try {
    const raw = session()?.getItem(PENDING_KEY);
    if (!raw) return null;
    const { credential } = JSON.parse(raw) as { credential?: object };
    if (!credential) return null;
    const { OAuthCredential } = await import("firebase/auth");
    return OAuthCredential.fromJSON(credential);
  } catch {
    return null;
  }
}

function dropPending(): void {
  pendingCredential = null;
  session()?.removeItem(PENDING_KEY);
}

/** The address-already-has-an-account refusal, kept for linking. */
async function capturePending(
  e: unknown,
  providerId: LinkableProvider,
): Promise<PendingLink | null> {
  if (errorCode(e) !== "auth/account-exists-with-different-credential") {
    return null;
  }
  const { GoogleAuthProvider, OAuthProvider } = await import("firebase/auth");
  const err = e as Parameters<typeof OAuthProvider.credentialFromError>[0];
  const email = (err.customData as { email?: string } | undefined)?.email;
  const cred =
    providerId === "google.com"
      ? GoogleAuthProvider.credentialFromError(err)
      : OAuthProvider.credentialFromError(err);
  if (!email || !cred) return null;
  const p = { email, providerId };
  savePending(p, cred);
  return p;
}

async function appleProvider() {
  const { OAuthProvider } = await import("firebase/auth");
  const provider = new OAuthProvider("apple.com");
  provider.addScope("email");
  provider.addScope("name");
  return provider;
}

async function providerFor(id: LinkableProvider) {
  if (id === "apple.com") return appleProvider();
  const { GoogleAuthProvider } = await import("firebase/auth");
  return new GoogleAuthProvider();
}

/** ADR 0136: the gateway counts sign-ins by method for passkey adoption;
 * passkey sign-ins it logs itself. Fire and forget, after the sign-in. */
export type SignInEventMethod = "google" | "apple" | "email" | "password" | "email_code";

export async function postSignInEvent(
  method: SignInEventMethod,
  getToken: () => Promise<string>,
): Promise<void> {
  try {
    const token = await getToken();
    await fetch(`${gatewayBaseUrl()}/v1/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "sign_in", props: { method } }),
    });
  } catch {
    // the count is a nice-to-have; never in the way of a sign-in
  }
}

function logSignInEvent(method: SignInEventMethod): void {
  void postSignInEvent(method, getLiveToken);
}

function trackSignIn(result: UserCredential | null, method: string): void {
  if (!result) return;
  logSignInEvent(method === "apple.com" ? "apple" : method === "google.com" ? "google" : "email");
  void import("firebase/auth").then(({ getAdditionalUserInfo }) => {
    const isNewUser = getAdditionalUserInfo(result)?.isNewUser === true;
    track(isNewUser ? "sign_up" : "login", { method });
    if (isNewUser) upgradeSession("new-account");
  });
}

// ------------------------------------------------------- mock behaviors

async function mockNoop(): Promise<void> {}

async function mockSendCode(): Promise<CodeStart> {
  return { resendAfter: RESEND_AFTER_S };
}

function noop(): void {}

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
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [redirectError, setRedirectError] = useState<string | null>(null);

  // Back from an Apple redirect (phones, headsets): settle its answer.
  useEffect(() => {
    if (mode !== "firebase") return;
    type Intent = { op: string; providerId: LinkableProvider };
    let intent: Intent | null = null;
    try {
      const raw = session()?.getItem(REDIRECT_KEY);
      intent = raw ? (JSON.parse(raw) as Intent) : null;
    } catch {
      intent = null;
    }
    if (intent === null) return;
    session()?.removeItem(REDIRECT_KEY);
    const providerId = intent.providerId;
    const op = intent.op;
    void (async () => {
      const auth = await getFirebaseAuth();
      const { getRedirectResult } = await import("firebase/auth");
      try {
        const result = await getRedirectResult(auth);
        if (op === "signin") trackSignIn(result, providerId);
        if (result?.user) setUser(toAuthUser(result.user));
      } catch (e) {
        const p = await capturePending(e, providerId);
        if (p) setPendingLink(p);
        else setRedirectError(friendlyAuthError(e).message);
      }
    })();
  }, [mode]);

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
        // a link waiting from before a redirect or a reload in this tab
        setPendingLink((p) => p ?? readPending());
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
      logSignInEvent("google");
      if (isNewUser) upgradeSession("new-account");
    } catch (e) {
      const p = await capturePending(e, "google.com");
      if (p) {
        setPendingLink(p);
        throw new AccountExistsError(p);
      }
      throw friendlyAuthError(e);
    }
  }, []);

  const signInWithApple = useCallback(async () => {
    if (viaGateway() || !APPLE_SIGNIN) throw new Error(EMAIL_ONLY_MESSAGE);
    try {
      const auth = await getFirebaseAuth();
      const provider = await appleProvider();
      const { signInWithPopup, signInWithRedirect } =
        await import("firebase/auth");
      if (prefersRedirect()) {
        session()?.setItem(
          REDIRECT_KEY,
          JSON.stringify({ op: "signin", providerId: "apple.com" }),
        );
        await signInWithRedirect(auth, provider);
        return;
      }
      trackSignIn(await signInWithPopup(auth, provider), "apple.com");
    } catch (e) {
      const p = await capturePending(e, "apple.com");
      if (p) {
        setPendingLink(p);
        throw new AccountExistsError(p);
      }
      throw friendlyAuthError(e);
    }
  }, []);

  const sendEmailCode = useCallback(async (email: string) => {
    try {
      return await startEmailCode(email);
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const signInWithEmailCode = useCallback(
    async (email: string, code: string) => {
      try {
        if (viaGateway()) {
          const answer = await verifyEmailCode(email, code, true);
          gatewayAdoptSession(answer);
          track(answer.is_new_user ? "sign_up" : "login", {
            method: "email_code",
          });
          logSignInEvent("email_code");
          if (answer.is_new_user) upgradeSession("new-account");
          return;
        }
        const answer = await verifyEmailCode(email, code, false);
        if (!answer.custom_token) throw new Error("Sign-in failed. Try again.");
        const auth = await getFirebaseAuth();
        const { linkWithCredential, signInWithCustomToken } =
          await import("firebase/auth");
        const result = await signInWithCustomToken(auth, answer.custom_token);
        track(answer.is_new_user ? "sign_up" : "login", {
          method: "email_code",
        });
        logSignInEvent("email_code");
        if (answer.is_new_user) upgradeSession("new-account");
        // S3D-69: Apple/Google said this address had an account; now that
        // the person proved it, link that sign-in onto it.
        const pending = readPending();
        if (
          pending &&
          pending.email.toLowerCase() === email.trim().toLowerCase()
        ) {
          const cred = await pendingCredentialNow();
          if (cred) {
            try {
              await linkWithCredential(result.user, cred);
              track("link_provider", { method: pending.providerId });
            } catch (e) {
              if (errorCode(e) !== "auth/provider-already-linked") {
                console.warn("auth: pending link failed", errorCode(e));
              }
            }
          }
          dropPending();
          setPendingLink(null);
          await result.user.reload();
          setUser(toAuthUser(auth.currentUser ?? result.user));
        }
      } catch (e) {
        throw friendlyAuthError(e);
      }
    },
    [],
  );

  const signInWithPasskey = useCallback(async (opts?: { autofill?: boolean }) => {
    const gw = viaGateway();
    // PasskeyError carries its own plain message (not a Firebase code)
    const answer = await passkeySignIn({ autofill: opts?.autofill, session: gw });
    if (gw) {
      gatewayAdoptSession(answer);
      track("login", { method: "passkey" });
      return;
    }
    if (!answer.custom_token) throw new Error("Sign-in failed. Try again.");
    try {
      const auth = await getFirebaseAuth();
      const { signInWithCustomToken } = await import("firebase/auth");
      await signInWithCustomToken(auth, answer.custom_token);
      track("login", { method: "passkey" });
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const reauthenticate = useCallback(async (id: LinkableProvider) => {
    if (viaGateway()) throw new Error(EMAIL_ONLY_MESSAGE);
    try {
      const current = await requireFirebaseUser();
      const provider = await providerFor(id);
      const { reauthenticateWithPopup } = await import("firebase/auth");
      await reauthenticateWithPopup(current, provider);
      await current.getIdToken(true);
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const clearPendingLink = useCallback(() => {
    dropPending();
    setPendingLink(null);
  }, []);

  const linkProvider = useCallback(async (id: LinkableProvider) => {
    if (viaGateway()) throw new Error(EMAIL_ONLY_MESSAGE);
    try {
      const current = await requireFirebaseUser();
      const provider = await providerFor(id);
      const { linkWithPopup, linkWithRedirect } = await import("firebase/auth");
      if (prefersRedirect()) {
        session()?.setItem(
          REDIRECT_KEY,
          JSON.stringify({ op: "link", providerId: id }),
        );
        await linkWithRedirect(current, provider);
        return;
      }
      try {
        await linkWithPopup(current, provider);
        track("link_provider", { method: id });
      } catch (e) {
        if (errorCode(e) !== "auth/provider-already-linked") throw e;
      }
      await current.reload();
      const auth = await getFirebaseAuth();
      setUser(toAuthUser(auth.currentUser ?? current));
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }, []);

  const unlinkProvider = useCallback(async (id: string) => {
    if (viaGateway()) throw new Error(EMAIL_ONLY_MESSAGE);
    try {
      const current = await requireFirebaseUser();
      const { unlink } = await import("firebase/auth");
      await unlink(current, id);
      track("unlink_provider", { method: id });
      await current.reload();
      const auth = await getFirebaseAuth();
      setUser(toAuthUser(auth.currentUser ?? current));
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
        logSignInEvent("password");
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
        logSignInEvent("password");
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
            appleEnabled: false,
            signInWithApple: mockNoop,
            sendEmailCode: mockSendCode,
            signInWithEmailCode: mockNoop,
            pendingLink: null,
            clearPendingLink: noop,
            redirectError: null,
            linkProvider: mockNoop,
            unlinkProvider: mockNoop,
            signInWithGoogle: mockNoop,
            signInWithPasskey: mockNoop,
            reauthenticate: mockNoop,
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
            appleEnabled: APPLE_SIGNIN && mode === "firebase",
            signInWithApple,
            sendEmailCode,
            signInWithEmailCode,
            pendingLink,
            clearPendingLink,
            redirectError,
            linkProvider,
            unlinkProvider,
            signInWithGoogle,
            signInWithPasskey,
            reauthenticate,
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
      signInWithApple,
      sendEmailCode,
      signInWithEmailCode,
      pendingLink,
      clearPendingLink,
      redirectError,
      linkProvider,
      unlinkProvider,
      signInWithGoogle,
      signInWithPasskey,
      reauthenticate,
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
