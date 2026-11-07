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
 * - BL-34: China mode also follows the gateway route (lib/gatewayRoute.ts).
 *   A browser that can't reach the direct host moves to the cn. host and
 *   signs in through the gateway like a visitor placed in China. Calls
 *   that pick a sign-in wait for the route first. Someone signed in
 *   through the SDK when the route moves is signed out on this network,
 *   and the sign-in screen says so (auth.errors.signInAgainHere).
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
import { atom } from "jotai";
import { useEffect, useMemo } from "react";

import { AuthDebugPanel } from "@/components/auth/AuthDebugPanel";
import { track, upgradeSession } from "@/lib/analytics";
import { runAppleFlow, type AppleAuthApi, type AppleOp } from "@/lib/appleSignIn";
import { copyKey, errorText, keyed, keyedError } from "@/lib/authErrors";
import { appStore, useAppAtomValue } from "@/lib/state/stores";
import {
  EmailCodeError,
  RESEND_AFTER_S,
  startEmailCode,
  verifyEmailCode,
} from "@/lib/emailCode";
import type { CodeStart } from "@/lib/emailCode";
import {
  authDebugAtom,
  describeOutcome,
  EMPTY_AUTH_DEBUG,
  readIntent,
  REDIRECT_KEY,
  redirectPending,
  settleRedirect,
  unfinishedError,
  type AuthDebug,
} from "@/lib/authRedirect";
import { firebaseConfig, getFirebaseAuth } from "@/lib/firebase";
import {
  gatewayAdoptSession,
  gatewaySession,
  gatewaySignOut,
  gatewayUpdateDisplayName,
  getGatewayToken,
  refreshGatewaySession,
  reloadGatewaySession,
  REFRESH_MARGIN_MS,
  subscribeGatewaySession,
} from "@/lib/gatewayAuth";
import type { GatewaySession } from "@/lib/gatewayAuth";
import { detectClient, isHeadset } from "@/lib/headset";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN } from "@/lib/i18n/t";
import { passkeySignIn } from "@/lib/passkeys";
import { confirmItsYou } from "@/lib/reauth";
import {
  currentRegion,
  gatewayFetch,
  prepareGatewayRoute,
  recheckDirectGatewayRoute,
} from "@/lib/region";
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
  /** Google through the Firebase SDK (no Google ID token without it on the
   * web yet); Apple and every unlink go through the gateway (EM-02,
   * lib/identities). */
  linkProvider(id: LinkableProvider): Promise<void>;
  /** EM-02: read the signed-in user again after the gateway changed its
   * sign-in methods (Firebase mode; China mode has nothing to read). */
  reloadUser(): Promise<void>;
  /** EM-02 "Sign in to that account": the Apple ID that belongs to
   * another account signs in to it (switches accounts). */
  signInWithAppleToken(idToken: string, rawNonce: string): Promise<void>;
  signInWithGoogle(): Promise<void>;
  /** ADR 0136: sign in with a passkey (the button, or the email field's
   * autofill); throws PasskeyError. */
  signInWithPasskey(opts?: { autofill?: boolean }): Promise<void>;
  /** ADR 0136: a fresh Apple or Google sign-in for the signed-in account
   * (adding a passkey needs one from the last 5 minutes). */
  reauthenticate(id: LinkableProvider): Promise<void>;
  /** Owner 2026-11-06: confirm it's you with a passkey of this account
   * (refuses another account's passkey, never switches accounts). */
  reauthenticateWithPasskey(): Promise<void>;
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

// ------------------------------------------------------- error mapping

/** Each code's message key (auth.errors.*); the message is English, the
 * key lets a screen show it in the reader's language (lib/authErrors). */
const FRIENDLY_BY_CODE: Record<string, string> = {
  "auth/invalid-credential": "incorrectCredentials",
  "auth/wrong-password": "incorrectCredentials",
  "auth/user-not-found": "userNotFound",
  "auth/invalid-email": "invalidEmail",
  "auth/email-already-in-use": "emailExists",
  "auth/weak-password": "weakPassword",
  "auth/missing-password": "missingPassword",
  "auth/popup-closed-by-user": "popupClosed",
  "auth/cancelled-popup-request": "popupClosed",
  "auth/popup-blocked": "popupBlocked",
  "auth/too-many-requests": "tooManyAttempts",
  "auth/network-request-failed": "network",
  "auth/user-disabled": "accountDisabled",
  "auth/requires-recent-login": "recentLogin",
  // Gateway sign-in (China mode) — the gateway's stable error codes.
  invalid_credentials: "incorrectCredentials",
  invalid_email: "invalidEmail",
  email_exists: "emailExists",
  weak_password: "weakPassword",
  missing_password: "missingPassword",
  too_many_attempts: "tooManyAttempts",
  rate_limited: "tooManyAttempts",
  user_disabled: "accountDisabled",
  operation_not_allowed: "emailOnly",
  invalid_refresh_token: "signedOut",
  invalid_token: "signedOut",
  signed_out: "signedOut",
  network: "network",
  auth_unavailable: "authUnavailable",
  // Email codes (S3D-70).
  code_invalid: "codeInvalid",
  code_expired: "codeExpired",
  resend_too_soon: "resendTooSoon",
  too_many_codes: "tooManyCodes",
  // Linking (S3D-69).
  "auth/credential-already-in-use": "credentialInUse",
  "auth/provider-already-linked": "alreadyLinked",
  "auth/unauthorized-domain": "unauthorizedDomain",
  "auth/operation-not-allowed": "providerUnavailable",
  "auth/invalid-custom-token": "customTokenInvalid",
  "auth/no-such-provider": "noSuchProvider",
};

/** China mode signs in by email only. */
const emailOnlyError = (): Error => keyedError("auth.errors.emailOnly");
const signedOutError = (): Error => keyedError("auth.errors.signedOut");
const signInFailedError = (): Error => keyedError("auth.errors.signInFailed");

function friendlyAuthError(error: unknown): Error {
  if (error instanceof AccountExistsError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const friendly = FRIENDLY_BY_CODE[code];
  const key = friendly !== undefined ? `auth.errors.${friendly}` : undefined;
  if (error instanceof EmailCodeError) {
    // keep retryAfter / attemptsLeft for the code screen
    const out = new EmailCodeError(
      error.code,
      key !== undefined ? EN(key) : error.message,
      error.status,
      error.retryAfter,
      error.attemptsLeft,
    );
    return key !== undefined ? keyed(out, key) : copyKey(out, error);
  }
  if (key !== undefined) return keyedError(key);
  if (error instanceof Error && error.message) return error;
  return keyedError("auth.errors.failed");
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

/** Live mode: the gateway session in China mode, else the SDK user. The
 * route settles first (BL-34): it decides which of the two. */
async function getLiveToken(): Promise<string> {
  await prepareGatewayRoute();
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
  if (!user) throw signedOutError();
  return user.getIdToken();
}

async function requireFirebaseUser(): Promise<User> {
  const user = await settledFirebaseUser();
  if (!user) throw signedOutError();
  return user;
}

// ------------------------------------------ Apple, linking, redirects

/** Thrown by Apple/Google sign-in when the address already has an account
 * (S3D-69); the screen asks for an email code, then the link completes. */
export class AccountExistsError extends Error {
  constructor(public readonly pending: PendingLink) {
    super(EN("auth.errors.accountExists", { email: pending.email }));
    this.name = "AccountExistsError";
    keyed(this, "auth.errors.accountExists", { email: pending.email });
  }
}

const PENDING_KEY = "s3d-pending-link";

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
    await prepareGatewayRoute();
    const token = await getToken();
    await gatewayFetch("/v1/events", {
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

type ActiveMode = "mock" | "firebase" | "gateway" | "pending";

/** ADR 0138: the session's auth state (no token in it: getToken asks
 * Firebase or the gateway session each time), in the app store. */
interface AuthState {
  mode: ActiveMode;
  user: AuthUser | null;
  ready: boolean;
  pendingLink: PendingLink | null;
  redirectError: string | null;
  /** the redirect's error itself, shown in the reader's language */
  redirectFailure?: Error | null;
}

const INITIAL_AUTH: AuthState = {
  mode: AUTH_MODE === "mock" ? "mock" : "pending",
  user: AUTH_MODE === "mock" ? MOCK_USER : null,
  ready: AUTH_MODE === "mock",
  pendingLink: null,
  redirectError: null,
};

export const authStateAtom = atom<AuthState>(INITIAL_AUTH);

function setAuth(patch: Partial<AuthState>): void {
  appStore.set(authStateAtom, (s) => ({ ...s, ...patch }));
}
function setAuthUser(user: AuthUser | null): void {
  setAuth({ user });
}
function setAuthPending(pendingLink: PendingLink | null): void {
  setAuth({ pendingLink });
}

/** Test hook: the auth state as a fresh page load has it. */
export function resetAuthForTests(): void {
  appStore.set(authStateAtom, INITIAL_AUTH);
  appStore.set(authDebugAtom, EMPTY_AUTH_DEBUG);
}

// ------------------------------------------------------------ actions

const signInWithGoogle = async () => {
  if (viaGateway()) throw emailOnlyError();
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
      setAuthPending(p);
      throw new AccountExistsError(p);
    }
    throw friendlyAuthError(e);
  }
};

/** Apple's answer → the apple.com user (owner 2026-11-05: Apple's JS in a
 * popup; the same user and sub as the app, so Pro carries over). */
function appleAuthApi(): AppleAuthApi<User, UserCredential> {
  return {
    credential: async ({ idToken, rawNonce }) => {
      const { OAuthProvider } = await import("firebase/auth");
      return new OAuthProvider("apple.com").credential({ idToken, rawNonce });
    },
    signInWithCredential: async (cred) => {
      const auth = await getFirebaseAuth();
      const { signInWithCredential } = await import("firebase/auth");
      return signInWithCredential(auth, cred as AuthCredential);
    },
    linkWithCredential: async (cred) => {
      const current = await requireFirebaseUser();
      const { linkWithCredential } = await import("firebase/auth");
      try {
        return await linkWithCredential(current, cred as AuthCredential);
      } catch (e) {
        if (errorCode(e) !== "auth/provider-already-linked") throw e;
        return { user: current } as UserCredential;
      }
    },
    updateDisplayName: async (user, name) => {
      const { updateProfile } = await import("firebase/auth");
      await updateProfile(user, { displayName: name });
    },
    settled: (result, op: AppleOp) => {
      if (op === "signin") trackSignIn(result, "apple.com");
      else track("link_provider", { method: "apple.com" });
      void result.user.reload().catch(() => undefined).then(async () => {
        const auth = await getFirebaseAuth();
        setAuthUser(toAuthUser(auth.currentUser ?? result.user));
      });
    },
  };
}

/** Apple's JS first; "fallback" when it couldn't load (use the redirect). */
async function appleViaJs(op: AppleOp): Promise<"done" | "fallback"> {
  let flow: Awaited<ReturnType<typeof runAppleFlow<User, UserCredential, PendingLink>>>;
  try {
    flow = await runAppleFlow(op, appleAuthApi(), {
      capturePending: (e) => capturePending(e, "apple.com"),
      track,
    });
  } catch (e) {
    // an Apple token the auth service refused isn't "incorrect password"
    if (errorCode(e) === "auth/invalid-credential" || errorCode(e) === "auth/missing-or-invalid-nonce") {
      throw keyedError("auth.errors.appleFailed");
    }
    throw e;
  }
  if (flow.kind === "pending") {
    setAuthPending(flow.pending);
    throw new AccountExistsError(flow.pending);
  }
  return flow.kind === "fallback" ? "fallback" : "done";
}

const signInWithApple = async () => {
  if (viaGateway() || !APPLE_SIGNIN) throw emailOnlyError();
  try {
    if ((await appleViaJs("signin")) === "done") return;
  } catch (e) {
    throw friendlyAuthError(e);
  }
  // fallback: Apple's script didn't load
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
      setAuthPending(p);
      throw new AccountExistsError(p);
    }
    throw friendlyAuthError(e);
  }
};

const sendEmailCode = async (email: string) => {
  try {
    return await startEmailCode(email);
  } catch (e) {
    throw friendlyAuthError(e);
  }
};

const signInWithEmailCode = async (email: string, code: string) => {
    try {
      await prepareGatewayRoute();
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
      if (!answer.custom_token) throw signInFailedError();
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
        setAuthPending(null);
        await result.user.reload();
        setAuthUser(toAuthUser(auth.currentUser ?? result.user));
      }
    } catch (e) {
      throw friendlyAuthError(e);
    }
  };

const signInWithPasskey = async (opts?: { autofill?: boolean }) => {
  await prepareGatewayRoute();
  const gw = viaGateway();
  // PasskeyError carries its own plain message (not a Firebase code)
  const answer = await passkeySignIn({ autofill: opts?.autofill, session: gw });
  if (gw) {
    gatewayAdoptSession(answer);
    track("login", { method: "passkey" });
    return;
  }
  if (!answer.custom_token) throw signInFailedError();
  try {
    const auth = await getFirebaseAuth();
    const { signInWithCustomToken } = await import("firebase/auth");
    await signInWithCustomToken(auth, answer.custom_token);
    track("login", { method: "passkey" });
  } catch (e) {
    throw friendlyAuthError(e);
  }
};

const reauthenticate = async (id: LinkableProvider) => {
  if (viaGateway()) throw emailOnlyError();
  try {
    const current = await requireFirebaseUser();
    const provider = await providerFor(id);
    const { reauthenticateWithPopup } = await import("firebase/auth");
    await reauthenticateWithPopup(current, provider);
    await current.getIdToken(true);
  } catch (e) {
    throw friendlyAuthError(e);
  }
};

export const OTHER_ACCOUNT_PASSKEY = EN("auth.errors.otherAccountPasskey");

const reauthenticateWithPasskey = async () => {
  await prepareGatewayRoute();
  const gw = viaGateway();
  const uid = appStore.get(authStateAtom).user?.uid ?? null;
  const answer = await passkeySignIn({ session: gw });
  if (uid === null || answer.uid !== uid) throw keyedError("auth.errors.otherAccountPasskey");
  if (gw) {
    gatewayAdoptSession(answer);
    return;
  }
  if (!answer.custom_token) throw signInFailedError();
  try {
    const auth = await getFirebaseAuth();
    const { signInWithCustomToken } = await import("firebase/auth");
    await signInWithCustomToken(auth, answer.custom_token);
  } catch (e) {
    throw friendlyAuthError(e);
  }
};

/** Firebase asks for a recent sign-in before some account changes: the
 * shared "Confirm it's you" (lib/reauth), then once more. */
async function withRecentSignIn<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (errorCode(e) !== "auth/requires-recent-login") throw e;
    await confirmItsYou();
    return op();
  }
}

const clearPendingLink = () => {
  dropPending();
  setAuthPending(null);
};

const linkProvider = async (id: LinkableProvider) => {
  if (viaGateway()) throw emailOnlyError();
  if (id === "apple.com") {
    try {
      if ((await appleViaJs("link")) === "done") return;
    } catch (e) {
      throw friendlyAuthError(e);
    }
  }
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
      await withRecentSignIn(() => linkWithPopup(current, provider));
      track("link_provider", { method: id });
    } catch (e) {
      if (errorCode(e) !== "auth/provider-already-linked") throw e;
    }
    await current.reload();
    const auth = await getFirebaseAuth();
    setAuthUser(toAuthUser(auth.currentUser ?? current));
  } catch (e) {
    throw friendlyAuthError(e);
  }
};

const reloadUser = async () => {
  if (viaGateway()) return;
  try {
    const current = await requireFirebaseUser();
    await current.reload();
    await current.getIdToken(true);
    const auth = await getFirebaseAuth();
    setAuthUser(toAuthUser(auth.currentUser ?? current));
  } catch (e) {
    throw friendlyAuthError(e);
  }
};

const signInWithAppleToken = async (idToken: string, rawNonce: string) => {
  if (viaGateway()) throw emailOnlyError();
  try {
    const auth = await getFirebaseAuth();
    const { OAuthProvider, signInWithCredential } = await import("firebase/auth");
    trackSignIn(
      await signInWithCredential(auth, new OAuthProvider("apple.com").credential({ idToken, rawNonce })),
      "apple.com",
    );
  } catch (e) {
    throw friendlyAuthError(e);
  }
};

const signOutUser = async () => {
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
};

const updateDisplayName = async (name: string) => {
  try {
    if (viaGateway()) {
      await gatewayUpdateDisplayName(name);
      return;
    }
    const current = await requireFirebaseUser();
    const { updateProfile } = await import("firebase/auth");
    await updateProfile(current, { displayName: name });
    setAuthUser(toAuthUser(current));
  } catch (e) {
    throw friendlyAuthError(e);
  }
};


const LIVE = {
  getToken: getLiveToken,
  signInWithApple,
  sendEmailCode,
  signInWithEmailCode,
  clearPendingLink,
  linkProvider,
  reloadUser,
  signInWithAppleToken,
  signInWithGoogle,
  signInWithPasskey,
  reauthenticate,
  reauthenticateWithPasskey,
  signOutUser,
  updateDisplayName,
};

const MOCK = {
  getToken: getMockToken,
  signInWithApple: mockNoop,
  sendEmailCode: mockSendCode,
  signInWithEmailCode: mockNoop,
  clearPendingLink: noop,
  linkProvider: mockNoop,
  reloadUser: mockNoop,
  signInWithAppleToken: mockNoop,
  signInWithGoogle: mockNoop,
  signInWithPasskey: mockNoop,
  reauthenticate: mockNoop,
  reauthenticateWithPasskey: mockNoop,
  signOutUser: mockSignOut,
  updateDisplayName: mockNoop,
};

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

  // ADR 0138: the session's state lives in the app-store auth atom.
  // BL-34: moving from the SDK to the gateway (the route moved to the cn.
  // host) while signed in through the SDK leaves no session here: say so
  // on the sign-in screen rather than just showing it.
  useEffect(() => {
    const was = appStore.get(authStateAtom);
    if (was.mode === mode) return;
    const lostSession = was.mode === "firebase" && mode === "gateway" && was.user !== null && gatewaySession() === null;
    setAuth(
      lostSession
        ? { mode, redirectError: EN("auth.errors.signInAgainHere"), redirectFailure: keyedError("auth.errors.signInAgainHere") }
        : { mode },
    );
  }, [mode]);

  // BL-34: settle the route as the page starts, and on the relay by
  // choice, ask the direct host again every 6 h (on load and on coming
  // back to the tab); the next page load follows its answer.
  useEffect(() => {
    if (AUTH_MODE === "mock") return;
    void prepareGatewayRoute().then(() => recheckDirectGatewayRoute());
    const onVisible = () => {
      if (document.visibilityState === "visible") void recheckDirectGatewayRoute();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Back from a redirect (the Apple fallback, Google on phones): settle
  // its answer, and say so when an expected one came back empty (owner
  // bug 2026-11-05: iPhone Safari came back to nothing).
  useEffect(() => {
    if (mode !== "firebase") return;
    const store = session();
    const { intent, raw } = readIntent(store);
    const pending = redirectPending(store, window.location.href);
    store?.removeItem(REDIRECT_KEY);
    const debug = (patch: Partial<AuthDebug>) =>
      appStore.set(authDebugAtom, (d) => ({ ...d, ...patch, at: new Date().toISOString() }));
    debug({ intent: raw, pending, ran: false, authDomain: firebaseConfig().authDomain, host: window.location.host });
    void (async () => {
      const auth = await getFirebaseAuth();
      const { getRedirectResult } = await import("firebase/auth");
      const outcome = await settleRedirect<User>({
        intent,
        pending,
        getRedirectResult: () => getRedirectResult(auth),
        currentUser: async () => {
          await auth.authStateReady();
          return auth.currentUser;
        },
      });
      debug({ ran: outcome.kind !== "skipped", outcome: describeOutcome(outcome), currentUser: auth.currentUser !== null });
      switch (outcome.kind) {
        case "user":
          if (intent?.op !== "link") trackSignIn(outcome.result as UserCredential, intent?.providerId ?? outcome.user.providerData[0]?.providerId ?? "");
          setAuthUser(toAuthUser(outcome.user));
          return;
        case "unfinished":
          track("redirect_unfinished", { op: intent?.op ?? "", method: intent?.providerId ?? "" });
          setAuth({ redirectError: outcome.message, redirectFailure: intent ? unfinishedError(intent) : null });
          return;
        case "error": {
          const p = await capturePending(outcome.error, intent?.providerId ?? "apple.com");
          if (p) setAuthPending(p);
          else {
            const failure = friendlyAuthError(outcome.error);
            setAuth({ redirectError: failure.message, redirectFailure: failure });
          }
          return;
        }
        default:
          return;
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
        setAuth({ user: u ? toAuthUser(u) : null, ready: true });
        // a link waiting from before a redirect or a reload in this tab
        if (appStore.get(authStateAtom).pendingLink === null) setAuthPending(readPending());
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
      setAuth({ user: s ? sessionToAuthUser(s) : null, ready: true });
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

  return (
    <>
      {children}
      <AuthDebugPanel />
    </>
  );
}

/** The session's auth: state from the app-store atom, actions as plain
 * functions (ADR 0138: no context). */
export function useAuth(): AuthContextValue {
  const s = useAppAtomValue(authStateAtom);
  const t = useT();
  return useMemo<AuthContextValue>(
    () =>
      s.mode === "mock" || AUTH_MODE === "mock"
        ? { ...MOCK, user: s.user, ready: s.ready, appleEnabled: false, pendingLink: null, redirectError: null }
        : {
            ...LIVE,
            user: s.user,
            ready: s.ready,
            appleEnabled: APPLE_SIGNIN && s.mode === "firebase",
            pendingLink: s.pendingLink,
            redirectError: s.redirectFailure ? errorText(s.redirectFailure, t) : s.redirectError,
          },
    [s, t],
  );
}
