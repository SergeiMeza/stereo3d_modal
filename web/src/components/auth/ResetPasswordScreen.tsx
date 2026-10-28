"use client";

/**
 * /reset-password — sets a new password with the code from the reset email
 * (?oob=, the gateway's /v1/auth/reset/confirm). It works without a
 * session, in either region, and for accounts that so far only used
 * another sign-in method: they get a password too.
 *
 * The code is read once and then dropped from the address bar, so it
 * doesn't linger in history or reach analytics. Native inputs, as on
 * /signin.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { GatewayAuthError, gatewayConfirmPasswordReset } from "@/lib/gatewayAuth";

const MIN_PASSWORD = 6;

const MESSAGES: Record<string, string> = {
  reset_link_expired:
    "This link has expired. Ask for a new one from the sign-in page.",
  reset_link_invalid:
    "This link is not valid or was already used. Ask for a new one from the sign-in page.",
  weak_password: `Choose a longer password: at least ${MIN_PASSWORD} characters.`,
  missing_password: "Enter a new password.",
  too_many_attempts: "Too many attempts. Wait a moment and try again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  user_disabled: "This account has been disabled.",
  network: "Couldn't reach the server. Check your connection and try again.",
};

function messageFor(e: unknown): string {
  if (e instanceof GatewayAuthError) {
    return MESSAGES[e.code] ?? "Something went wrong. Try again in a moment.";
  }
  return "Something went wrong. Try again in a moment.";
}

export default function ResetPasswordScreen() {
  const params = useSearchParams();
  const [oob] = useState(() => params.get("oob")?.trim() || null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkDead, setLinkDead] = useState(false);
  const [doneEmail, setDoneEmail] = useState<string | null | undefined>(
    undefined,
  );

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("oob")) {
        url.searchParams.delete("oob");
        window.history.replaceState(window.history.state, "", url.pathname + url.search);
      }
    } catch {
      // history unavailable: the code simply stays in the address bar
    }
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (oob === null) return;
    if (password.length < MIN_PASSWORD) {
      setError(MESSAGES.weak_password);
      return;
    }
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { email } = await gatewayConfirmPasswordReset(oob, password);
      setDoneEmail(email);
    } catch (err) {
      setError(messageFor(err));
      if (
        err instanceof GatewayAuthError &&
        (err.code === "reset_link_expired" || err.code === "reset_link_invalid")
      ) {
        setLinkDead(true);
      }
    } finally {
      setPending(false);
    }
  }

  const signInLink = (
    <Link
      href="/signin"
      className="block rounded-lg bg-primary px-4 py-2 text-center font-medium text-primary-foreground transition-colors hover:bg-primary/80"
    >
      Go to sign in
    </Link>
  );

  if (doneEmail !== undefined) {
    return (
      <section className="mx-auto w-full max-w-sm space-y-5 px-4 py-16">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Password saved</h1>
          <p className="mt-1 text-fg-muted">
            {doneEmail
              ? `Sign in as ${doneEmail} with your new password.`
              : "Sign in with your new password."}
          </p>
        </div>
        {signInLink}
      </section>
    );
  }

  if (oob === null) {
    return (
      <section className="mx-auto w-full max-w-sm space-y-5 px-4 py-16">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Reset password</h1>
          <p className="mt-1 text-fg-muted">
            {MESSAGES.reset_link_invalid}
          </p>
        </div>
        {signInLink}
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-sm space-y-5 px-4 py-16">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Choose a new password
        </h1>
        <p className="mt-1 text-fg-muted">
          Use at least {MIN_PASSWORD} characters.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="reset-password" className="block text-xs text-fg-muted">
            New password
          </label>
          <input
            id="reset-password"
            type="password"
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-fg outline-none focus:border-primary/60"
          />
        </div>
        <div className="space-y-1">
          <label
            htmlFor="reset-password-confirm"
            className="block text-xs text-fg-muted"
          >
            Confirm new password
          </label>
          <input
            id="reset-password-confirm"
            type="password"
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-fg outline-none focus:border-primary/60"
          />
        </div>

        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending || linkDead}
          className="w-full rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save password"}
        </button>
      </form>

      {linkDead && (
        <p className="text-xs text-fg-muted">
          <Link href="/signin" className="text-primary hover:underline">
            Back to sign in
          </Link>{" "}
          to ask for a new link.
        </p>
      )}
    </section>
  );
}
