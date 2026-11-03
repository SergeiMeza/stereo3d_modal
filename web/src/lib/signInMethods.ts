/**
 * The account's ways to sign in (S3D-69), for the account page.
 *
 * - Email: a one-time code to the account's address (S3D-70). Always on
 *   while the account has a real address; it is the account's identity, so
 *   it can't be removed. An Apple "Hide My Email" relay address doesn't
 *   count: mail to it only arrives when our sending domain is registered
 *   with Apple.
 * - Apple, Google: linked or not; either can be added, and removed unless it
 *   is the last way in.
 * - Password: only shown while an older account still has one; it can be
 *   removed (the email code replaces it), never added.
 */

import { isAppleRelayEmail } from "@/lib/emailCode";

export type MethodId = "email" | "apple.com" | "google.com" | "password";

export interface SignInMethod {
  id: MethodId;
  linked: boolean;
}

export interface MethodOptions {
  /** offer Apple (configured, not China mode) */
  apple: boolean;
  /** offer Google (not China mode) */
  google: boolean;
}

export function signInMethods(
  user: { email: string | null; providerIds: string[] },
  opts: MethodOptions,
): SignInMethod[] {
  const has = (id: string) => user.providerIds.includes(id);
  const out: SignInMethod[] = [];
  if (user.email && !isAppleRelayEmail(user.email)) {
    out.push({ id: "email", linked: true });
  }
  if (has("apple.com") || opts.apple) {
    out.push({ id: "apple.com", linked: has("apple.com") });
  }
  if (has("google.com") || opts.google) {
    out.push({ id: "google.com", linked: has("google.com") });
  }
  if (has("password")) out.push({ id: "password", linked: true });
  return out;
}

/** A linked method may go unless it's the email or the last way in. */
export function canRemove(methods: SignInMethod[], id: MethodId): boolean {
  if (id === "email") return false;
  const m = methods.find((x) => x.id === id);
  if (!m?.linked) return false;
  return methods.some((x) => x.linked && x.id !== id);
}

export const METHOD_LABELS: Record<MethodId, string> = {
  email: "Email",
  "apple.com": "Apple",
  "google.com": "Google",
  password: "Password",
};
