"use client";

/**
 * /signin (S3D-70): Apple, Google, or a one-time code to your email. No
 * passwords: an older password account signs in with a code to the same
 * address and lands on the same account.
 *
 * Two steps. Start: Continue with Apple (when configured, BL-15), Continue
 * with Google (not in China mode), or an email → Continue. Code: six slots
 * that submit on the sixth digit (CodeInput), "Send a new code" after 30 s,
 * "Use another email".
 *
 * One account per email (S3D-69): when Apple or Google answers that the
 * address already has an account, the screen sends a code to that address
 * and says what will be linked; the auth context links it once the code is
 * in. The same happens when that answer comes back from an Apple redirect.
 *
 * The ?next= param is validated to a same-origin path ("/..." but not
 * "//...") before it's ever passed to router.replace — anything else would
 * be an open redirect. In mock mode auth is a no-op, so the screen just
 * says so and offers a plain Continue into the studio.
 */

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { CodeInput } from "@/components/auth/CodeInput";
import { AppleLogo, GoogleLogo } from "@/components/auth/ProviderLogos";
import { AccountExistsError, AUTH_MODE, useAuth } from "@/lib/auth";
import type { PendingLink } from "@/lib/auth";
import { CODE_LENGTH, EmailCodeError, RESEND_AFTER_S } from "@/lib/emailCode";
import type { CodeStart } from "@/lib/emailCode";
import { METHOD_LABELS } from "@/lib/signInMethods";
import { useRegion } from "@/lib/useRegion";

function safeNext(raw: string | null): string {
  if (raw !== null && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/projects";
}

const providerButton =
  "flex h-11 w-full items-center justify-center gap-2.5 rounded-lg px-4 font-medium transition-colors disabled:opacity-50";

export default function SignInScreen() {
  const {
    user,
    ready,
    appleEnabled,
    signInWithApple,
    signInWithGoogle,
    sendEmailCode,
    signInWithEmailCode,
    pendingLink,
    clearPendingLink,
    redirectError,
  } = useAuth();
  const router = useRouter();
  const emailOnly = useRegion() === "cn";
  const next = safeNext(useSearchParams().get("next"));

  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"start" | "code">("start");
  const [resendAt, setResendAt] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSentFor = useRef<string | null>(null);

  const signedIn = AUTH_MODE === "firebase" && ready && user !== null;
  useEffect(() => {
    // a pending link finishes on the code step, after which we leave
    if (signedIn && pendingLink === null) router.replace(next);
  }, [signedIn, pendingLink, router, next]);

  // Apple/Google said the address has an account (also after a redirect):
  // send its code once and ask for it.
  useEffect(() => {
    if (pendingLink === null || autoSentFor.current === pendingLink.email) return;
    autoSentFor.current = pendingLink.email;
    setEmail(pendingLink.email);
    void sendTo(pendingLink.email);
    // sendTo is a fresh closure each render; the email is the key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLink]);

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

  async function sendTo(address: string): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      const started: CodeStart = await sendEmailCode(address);
      setResendAt(Date.now() + started.resendAfter * 1000);
      setStep("code");
      return true;
    } catch (e) {
      if (e instanceof EmailCodeError && e.code === "resend_too_soon") {
        // a code is already on its way
        setResendAt(Date.now() + (e.retryAfter ?? RESEND_AFTER_S) * 1000);
        setStep("code");
        return true;
      }
      setError(e instanceof Error ? e.message : "Something went wrong.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function provider(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      // AccountExistsError: the pendingLink effect takes over
      if (!(e instanceof AccountExistsError)) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    } finally {
      setPending(false);
    }
  }

  if (step === "code") {
    return (
      <section className="mx-auto w-full max-w-sm px-4 py-16">
        <EmailCodeStep
          email={email}
          resendAt={resendAt}
          linking={pendingLink}
          onResend={() => sendTo(email)}
          onVerify={async (code) => {
            await signInWithEmailCode(email, code);
            router.replace(next);
          }}
          onBack={() => {
            setStep("start");
            setError(null);
            if (pendingLink) clearPendingLink();
          }}
        />
      </section>
    );
  }

  const shownError = error ?? redirectError;
  return (
    <section className="mx-auto w-full max-w-sm space-y-6 px-4 py-16">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-fg-muted">
          One account for the web and Spatial Video Studio.
        </p>
      </div>

      {!emailOnly && (
        <div className="space-y-2.5">
          {appleEnabled && (
            <button
              type="button"
              data-testid="signin-apple"
              disabled={pending}
              onClick={() => void provider(signInWithApple)}
              className={`${providerButton} bg-white text-black hover:bg-white/90`}
            >
              <AppleLogo className="size-4 -translate-y-px" />
              Continue with Apple
            </button>
          )}
          <button
            type="button"
            data-testid="signin-google"
            disabled={pending}
            onClick={() => void provider(signInWithGoogle)}
            className={`${providerButton} border border-edge bg-surface-2 text-fg hover:border-primary/60`}
          >
            <GoogleLogo className="size-4" />
            Continue with Google
          </button>
        </div>
      )}

      {!emailOnly && (
        <div className="flex items-center gap-3 text-xs text-fg-muted">
          <span className="h-px flex-1 bg-edge" aria-hidden="true" />
          or
          <span className="h-px flex-1 bg-edge" aria-hidden="true" />
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void sendTo(email);
        }}
        className="space-y-2.5"
      >
        <label htmlFor="signin-email" className="sr-only">
          Email
        </label>
        <input
          id="signin-email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          enterKeyHint="go"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-11 w-full rounded-lg border border-edge bg-surface-2 px-3 text-fg outline-none placeholder:text-fg-muted/60 focus:border-primary/60"
        />
        <button
          type="submit"
          disabled={pending || email.trim() === ""}
          className={`${providerButton} bg-primary text-primary-foreground hover:bg-primary/80`}
        >
          {pending ? "Sending…" : "Continue with email"}
        </button>
      </form>

      {shownError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {shownError}
        </p>
      )}

      <p className="text-xs text-fg-muted">
        By continuing, you agree to our{" "}
        <Link href="/terms" className="text-primary hover:underline">
          Terms of Use
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="text-primary hover:underline">
          Privacy Policy
        </Link>
        .
      </p>
    </section>
  );
}

/** "0:23" */
function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The code step, on its own for tests: six slots, submit on the sixth
 * digit, resend after the wait, back to the email. */
export function EmailCodeStep({
  email,
  resendAt,
  linking,
  onResend,
  onVerify,
  onBack,
}: {
  email: string;
  /** ms epoch when "Send a new code" unlocks */
  resendAt: number;
  /** Apple/Google waiting to be linked once the code is in */
  linking: PendingLink | null;
  onResend: () => Promise<boolean>;
  onVerify: (code: string) => Promise<void>;
  onBack: () => void;
}): JSX.Element {
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (now >= resendAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [now, resendAt]);

  async function verify(digits: string) {
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      await onVerify(digits);
    } catch (e) {
      setCode("");
      if (e instanceof EmailCodeError && e.code === "code_invalid") {
        const left = e.attemptsLeft;
        setError(
          left !== null && left <= 2
            ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.`
            : "That code isn't right.",
        );
      } else {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    } finally {
      setVerifying(false);
    }
  }

  const waitMs = resendAt - now;
  return (
    <div className="space-y-6" data-testid="code-step">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 inline-flex items-center gap-1 text-sm text-fg-muted transition-colors hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Use another email
      </button>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="text-fg-muted">
          Enter the code we sent to{" "}
          <span className="break-all text-fg">{email}</span>.
        </p>
        {linking !== null && (
          <p data-testid="code-linking" className="text-sm text-fg-muted">
            You already have an account with this email.{" "}
            {METHOD_LABELS[linking.providerId]} will be added to it.
          </p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === CODE_LENGTH) void verify(code);
        }}
        className="space-y-3"
      >
        <CodeInput
          value={code}
          onChange={(d) => {
            setCode(d);
            if (error) setError(null);
          }}
          onComplete={(d) => void verify(d)}
          disabled={verifying}
          invalid={error !== null}
        />
        {/* Enter / Go on any keyboard submits; the button is for pointers. */}
        <button
          type="submit"
          disabled={verifying || code.length !== CODE_LENGTH}
          className={`${providerButton} bg-primary text-primary-foreground hover:bg-primary/80`}
        >
          {verifying ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice !== null && <p className="text-sm text-chart-2">{notice}</p>}

      <button
        type="button"
        data-testid="code-resend"
        disabled={waitMs > 0 || verifying}
        onClick={() =>
          void onResend().then((ok) => {
            if (ok) {
              setCode("");
              setError(null);
              setNotice("New code sent.");
            }
          })
        }
        className="text-sm text-primary transition-colors hover:underline disabled:text-fg-muted disabled:no-underline"
      >
        {waitMs > 0 ? `Send a new code in ${mmss(waitMs)}` : "Send a new code"}
      </button>
    </div>
  );
}
