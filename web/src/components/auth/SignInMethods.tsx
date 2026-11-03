"use client";

/**
 * Account page: ways to sign in (S3D-69). Email (a code to the account's
 * address) is always on; Apple and Google can be added or removed, never
 * the last way in; an older account's password can only be removed.
 *
 * Adding Apple is how someone who uses Spatial Video Studio with a hidden
 * Apple address gets one account: the relay address never matches their
 * web email, so they link Apple here. If that Apple ID already has its own
 * account, the link is refused and the message says to sign in with it.
 * China mode shows the email only.
 */

import { Mail } from "lucide-react";
import { useState } from "react";
import type { JSX } from "react";

import { AppleLogo, GoogleLogo } from "@/components/auth/ProviderLogos";
import { useAuth } from "@/lib/auth";
import type { LinkableProvider } from "@/lib/auth";
import {
  canRemove,
  METHOD_LABELS,
  signInMethods,
} from "@/lib/signInMethods";
import type { MethodId } from "@/lib/signInMethods";
import { useRegion } from "@/lib/useRegion";

function MethodIcon({ id }: { id: MethodId }): JSX.Element {
  const cls = "size-4";
  if (id === "apple.com") return <AppleLogo className={cls} />;
  if (id === "google.com") return <GoogleLogo className={cls} />;
  return <Mail className={cls} aria-hidden="true" />;
}

export function SignInMethods(): JSX.Element | null {
  const { user, appleEnabled, linkProvider, unlinkProvider, redirectError } =
    useAuth();
  const cn = useRegion() === "cn";
  const [busy, setBusy] = useState<MethodId | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (user === null) return null;

  const methods = signInMethods(user, { apple: appleEnabled && !cn, google: !cn });
  const shown = cn ? methods.filter((m) => m.id === "email") : methods;

  async function run(id: MethodId, action: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const action =
    "shrink-0 rounded-md border border-edge px-2.5 py-1 text-xs transition-colors disabled:opacity-50";
  const shownError = error ?? redirectError;
  return (
    <div data-testid="signin-methods" className="space-y-2">
      <p className="text-xs text-fg-muted">Sign in with</p>
      <ul className="divide-y divide-edge rounded-lg border border-edge">
        {shown.map((m) => {
          const removable = !cn && canRemove(methods, m.id);
          return (
            <li
              key={m.id}
              data-testid={`method-${m.id}`}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg">
                <MethodIcon id={m.id} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg">{METHOD_LABELS[m.id]}</p>
                {m.id === "email" && (
                  <p className="truncate text-xs text-fg-muted">
                    Code to {user.email}
                  </p>
                )}
              </div>
              {m.linked ? (
                removable ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void run(m.id, () => unlinkProvider(m.id))}
                    className={`${action} text-fg-muted hover:border-destructive/60 hover:text-destructive`}
                  >
                    {busy === m.id ? "Removing…" : "Remove"}
                  </button>
                ) : (
                  <span className="text-xs text-fg-muted">On</span>
                )
              ) : (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(m.id, () => linkProvider(m.id as LinkableProvider))
                  }
                  className={`${action} text-fg hover:border-primary/60`}
                >
                  {busy === m.id ? "Adding…" : "Add"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {shownError !== null && (
        <p role="alert" className="text-xs text-destructive">
          {shownError}
        </p>
      )}
    </div>
  );
}
