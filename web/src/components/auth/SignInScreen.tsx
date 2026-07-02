"use client";

/**
 * /signin — Google popup on top, divider, then the email form, with three
 * in-page modes (sign in / create account / reset password) toggled by
 * native buttons; native inputs throughout (Radix Select breaks jsdom —
 * project convention is native form elements everywhere).
 *
 * The ?next= param is validated to a same-origin path ("/..." but not
 * "//...") before it's ever passed to router.replace — anything else would
 * be an open redirect. In mock mode auth is a no-op, so the screen just
 * says so and offers a plain Continue into the studio.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AUTH_MODE, useAuth } from "@/lib/auth";

type Mode = "signin" | "signup" | "reset";

const TITLES: Record<Mode, string> = {
  signin: "Sign in",
  signup: "Create account",
  reset: "Reset password",
};

const SUBMIT_LABELS: Record<Mode, string> = {
  signin: "Sign in",
  signup: "Create account",
  reset: "Send reset email",
};

function safeNext(raw: string | null): string {
  if (raw !== null && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/projects";
}

export default function SignInScreen() {
  const {
    user,
    ready,
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
    resetPassword,
  } = useAuth();
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const firebaseSignedIn = AUTH_MODE === "firebase" && ready && user !== null;
  useEffect(() => {
    if (firebaseSignedIn) router.replace("/projects");
  }, [firebaseSignedIn, router]);

  if (AUTH_MODE === "mock") {
    return (
      <section className="mx-auto w-full max-w-sm space-y-4 px-4 py-16">
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="rounded-lg border border-edge bg-surface-1 p-4 text-fg-muted">
          Auth is mocked in this environment.
        </p>
        <Link
          href={next}
          className="block rounded-lg bg-primary px-4 py-2 text-center font-medium text-primary-foreground transition-colors hover:bg-primary/80"
        >
          Continue
        </Link>
      </section>
    );
  }

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
    setNotice(null);
  }

  async function run(action: () => Promise<void>, navigateOnSuccess: boolean) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (navigateOnSuccess) router.replace(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mode === "signin") {
      void run(() => signInWithEmail(email, password), true);
    } else if (mode === "signup") {
      void run(() => signUpWithEmail(email, password), true);
    } else {
      void run(async () => {
        await resetPassword(email);
        setNotice("Password reset email sent — check your inbox.");
      }, false);
    }
  }

  return (
    <section className="mx-auto w-full max-w-sm space-y-5 px-4 py-16">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{TITLES[mode]}</h1>
        <p className="mt-1 text-fg-muted">
          {mode === "reset"
            ? "We'll email you a link to set a new password."
            : "Your projects and conversions live under your account."}
        </p>
      </div>

      {mode !== "reset" && (
        <>
          <button
            type="button"
            disabled={pending}
            onClick={() => void run(signInWithGoogle, true)}
            className="w-full rounded-lg border border-edge bg-surface-2 px-4 py-2 font-medium text-fg transition-colors hover:border-primary/60 disabled:opacity-50"
          >
            Continue with Google
          </button>
          <div className="flex items-center gap-3 text-xs text-fg-muted">
            <span className="h-px flex-1 bg-edge" aria-hidden="true" />
            or
            <span className="h-px flex-1 bg-edge" aria-hidden="true" />
          </div>
        </>
      )}

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="signin-email" className="block text-xs text-fg-muted">
            Email
          </label>
          <input
            id="signin-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-fg outline-none focus:border-primary/60"
          />
        </div>
        {mode !== "reset" && (
          <div className="space-y-1">
            <label
              htmlFor="signin-password"
              className="block text-xs text-fg-muted"
            >
              Password
            </label>
            <input
              id="signin-password"
              type="password"
              required
              minLength={6}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-fg outline-none focus:border-primary/60"
            />
          </div>
        )}

        {error !== null && <p className="text-xs text-destructive">{error}</p>}
        {notice !== null && <p className="text-xs text-chart-2">{notice}</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
        >
          {pending ? "Working…" : SUBMIT_LABELS[mode]}
        </button>
      </form>

      <div className="space-y-1 text-xs text-fg-muted">
        {mode !== "signin" && (
          <p>
            Already have an account?{" "}
            <button
              type="button"
              onClick={() => switchMode("signin")}
              className="text-primary hover:underline"
            >
              Sign in
            </button>
          </p>
        )}
        {mode !== "signup" && (
          <p>
            New here?{" "}
            <button
              type="button"
              onClick={() => switchMode("signup")}
              className="text-primary hover:underline"
            >
              Create account
            </button>
          </p>
        )}
        {mode !== "reset" && (
          <p>
            Forgot your password?{" "}
            <button
              type="button"
              onClick={() => switchMode("reset")}
              className="text-primary hover:underline"
            >
              Reset it
            </button>
          </p>
        )}
      </div>
    </section>
  );
}
