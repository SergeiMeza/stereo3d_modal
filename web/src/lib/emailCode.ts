/**
 * Sign-in with a one-time email code (S3D-70): the gateway's
 * /v1/auth/email/{start,verify}. No password, no link.
 *
 * start mails a 6-digit code (10 minutes, 5 tries); verify answers a
 * Firebase custom token for the JS SDK, or — China mode, where the SDK
 * never loads — the ID and refresh tokens themselves (session: true), the
 * same Session the other /v1/auth/* routes answer. Either way the uid is
 * the account with that email: one account per email (S3D-69).
 */

import { GatewayAuthError } from "@/lib/gatewayAuth";
import { currentRegion, gatewayBaseUrl } from "@/lib/region";

/** Seconds before another code may be asked for. */
export const RESEND_AFTER_S = 30;
export const CODE_LENGTH = 6;

export interface CodeStart {
  /** seconds until "Send a new code" */
  resendAfter: number;
}

/** verify's answer: a custom token (SDK) or a Session (China mode). */
export interface CodeVerifyAnswer {
  uid: string;
  is_new_user?: boolean;
  custom_token?: string;
  email?: string;
  display_name?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** The gateway's refusals, with what the screen needs from details. */
export class EmailCodeError extends GatewayAuthError {
  constructor(
    code: string,
    message: string,
    status: number,
    public readonly retryAfter: number | null = null,
    public readonly attemptsLeft: number | null = null,
  ) {
    super(code, message, status);
    this.name = "EmailCodeError";
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${gatewayBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new EmailCodeError("network", "network request failed", 0);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON answer
  }
  if (!res.ok) {
    const details = (parsed.details ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    throw new EmailCodeError(
      typeof parsed.error === "string" ? parsed.error : "auth_unavailable",
      typeof parsed.message === "string"
        ? parsed.message
        : `request failed (${res.status})`,
      res.status,
      num(details.retry_after),
      num(details.attempts_left),
    );
  }
  return parsed as T;
}

/** The code mail's language (gateway 00145), BCP-47: zh-Hans in China
 * mode, else the site's UI language (the html lang, English today). */
export function codeMailLanguage(): string {
  if (currentRegion() === "cn") return "zh-Hans";
  const lang = typeof document !== "undefined" ? document.documentElement.lang.trim() : "";
  return lang || "en";
}

/** Mail a code to email. */
export async function startEmailCode(email: string): Promise<CodeStart> {
  const a = await post<{ resend_after?: number }>("/v1/auth/email/start", {
    email: email.trim(),
    language: codeMailLanguage(),
  });
  return { resendAfter: a.resend_after ?? RESEND_AFTER_S };
}

/** Check the code; session:true for China mode (tokens, not a custom token). */
export function verifyEmailCode(
  email: string,
  code: string,
  session: boolean,
): Promise<CodeVerifyAnswer> {
  return post<CodeVerifyAnswer>("/v1/auth/email/verify", {
    email: email.trim(),
    code,
    session,
  });
}

/** Digits only, at most six: what a paste or an autofill may carry
 * ("123 456", "123-456", "Your code: 123456"). */
export function codeDigits(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

/** Apple's "Hide My Email" relay addresses. Mail to them only arrives when
 * our sending domain is registered with Apple, so they don't count as an
 * email sign-in method of their own (S3D-69). */
export function isAppleRelayEmail(email: string | null | undefined): boolean {
  return /@privaterelay\.appleid\.com$/i.test(email ?? "");
}
