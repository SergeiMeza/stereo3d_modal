/**
 * Sign in with Apple, and Add Apple on the account, through Apple's JS
 * (owner 2026-11-05, lib/appleJs.ts), apart from the provider so tests can
 * run it with a stand-in AppleID and auth SDK.
 *
 * Outcomes, each tracked once as `apple_auth {op, outcome}`:
 * - done: signed in (the name from Apple's first answer fills an empty
 *   display name) or linked;
 * - cancelled: the person closed Apple's window, nothing shown;
 * - fallback: Apple's script didn't load, the caller uses the redirect;
 * - pending: the address already has an account (S3D-69), the caller
 *   starts the email-code link;
 * - anything else is thrown for the screen to show.
 */

import { AppleCancelled, AppleJsUnavailable, appleAuthorize, type AppleAnswer } from "@/lib/appleJs";

export type AppleOp = "signin" | "link";
export type AppleOutcome = "success" | "cancel" | "error" | "account_exists" | "fallback";

export type AppleFlowResult<P> =
  | { kind: "done" }
  | { kind: "cancelled" }
  | { kind: "fallback" }
  | { kind: "pending"; pending: P };

export interface AppleUser {
  displayName: string | null;
}

/** The auth SDK calls the flow needs (the real ones come from
 * firebase/auth; tests pass stand-ins). */
export interface AppleAuthApi<U extends AppleUser, R extends { user: U }> {
  credential(answer: AppleAnswer): unknown | Promise<unknown>;
  signInWithCredential(credential: unknown): Promise<R>;
  linkWithCredential(credential: unknown): Promise<R>;
  updateDisplayName(user: U, name: string): Promise<void>;
  /** after a sign-in or a link, e.g. tracking and the session's user */
  settled(result: R, op: AppleOp): void;
}

export async function runAppleFlow<U extends AppleUser, R extends { user: U }, P>(
  op: AppleOp,
  api: AppleAuthApi<U, R>,
  deps: {
    capturePending: (e: unknown) => Promise<P | null>;
    track: (name: string, params: Record<string, string>) => void;
    authorize?: () => Promise<AppleAnswer>;
  },
): Promise<AppleFlowResult<P>> {
  const said = (outcome: AppleOutcome, code?: string) =>
    deps.track("apple_auth", code ? { op, outcome, code } : { op, outcome });
  let answer: AppleAnswer;
  try {
    answer = await (deps.authorize ?? appleAuthorize)();
  } catch (e) {
    if (e instanceof AppleCancelled) {
      said("cancel");
      return { kind: "cancelled" };
    }
    if (e instanceof AppleJsUnavailable) {
      said("fallback");
      return { kind: "fallback" };
    }
    said("error", "apple_js");
    throw e;
  }
  try {
    const credential = await api.credential(answer);
    const result = op === "signin" ? await api.signInWithCredential(credential) : await api.linkWithCredential(credential);
    // Apple sends the name only the first time: keep it if there's none
    if (op === "signin" && answer.name && !result.user.displayName?.trim()) {
      await api.updateDisplayName(result.user, answer.name).catch(() => undefined);
    }
    api.settled(result, op);
    said("success");
    return { kind: "done" };
  } catch (e) {
    const pending = await deps.capturePending(e);
    if (pending) {
      said("account_exists");
      return { kind: "pending", pending };
    }
    const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "unknown";
    said("error", code);
    throw e;
  }
}
