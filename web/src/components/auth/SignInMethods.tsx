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
 *
 * EM-02 (owner 2026-11-06): the list, Add Apple and every Remove go
 * through the gateway (/v1/account/identities), for every account and in
 * China mode, where a method the app linked can be removed too. A sign-in
 * that belongs to another account offers "Sign in to that account". Add
 * Google still links through the Firebase SDK: the web has no Google ID
 * token without it yet. Old sign-ins ask "Confirm it's you" (lib/reauth).
 */

import { Mail } from "lucide-react";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { OtherAccountNotice } from "@/components/auth/OtherAccountNotice";
import { AppleLogo, GoogleLogo } from "@/components/auth/ProviderLogos";
import {
  IdentityInUseError,
  identitiesAtom,
  linkAppleAtom,
  loadIdentitiesAtom,
  unlinkIdentityAtom,
} from "@/components/auth/identityAtoms";
import { useGateway } from "@/lib/api/useGateway";
import { prepareApple } from "@/lib/appleJs";
import { useAuth } from "@/lib/auth";
import { billingUidAtom } from "@/lib/billing";
import {
  canRemove,
  fromIdentities,
  METHOD_LABELS,
  signInMethods,
} from "@/lib/signInMethods";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";
import type { MethodId } from "@/lib/signInMethods";
import { useRegion } from "@/lib/useRegion";

function MethodIcon({ id }: { id: MethodId }): JSX.Element {
  const cls = "size-4";
  if (id === "apple.com") return <AppleLogo className={cls} />;
  if (id === "google.com") return <GoogleLogo className={cls} />;
  return <Mail className={cls} aria-hidden="true" />;
}

export function SignInMethods(): JSX.Element | null {
  const { user, appleEnabled, linkProvider, reloadUser, signInWithAppleToken, redirectError } = useAuth();
  const gateway = useGateway();
  const cn = useRegion() === "cn";
  const [busy, setBusy] = useState<MethodId | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** credential_in_use: "Sign in to that account" */
  const [switchTo, setSwitchTo] = useState<(() => Promise<void>) | null>(null);
  // ADR 0138: the gateway's list, for this account
  const state = useAppAtomValue(identitiesAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const identities = state.uid === uid ? state.data : null;
  const loadIdentities = useAppSetAtom(loadIdentitiesAtom);
  const linkApple = useAppSetAtom(linkAppleAtom);
  const unlink = useAppSetAtom(unlinkIdentityAtom);
  useEffect(() => {
    if (user !== null && uid !== null) void loadIdentities(gateway);
  }, [user, uid, loadIdentities, gateway]);
  // until the gateway answers, the session's own list
  const view = identities ? fromIdentities(identities) : user;
  // owner 2026-11-05: Apple's JS loads ahead of an Add Apple tap
  const appleOffered = appleEnabled && !cn && view !== null && !view.providerIds.includes("apple.com");
  useEffect(() => {
    if (appleOffered) prepareApple();
  }, [appleOffered]);
  if (user === null || view === null) return null;

  const methods = signInMethods(view, { apple: appleEnabled && !cn, google: !cn });
  // China mode: no adding Apple or Google, but what the app linked shows
  const shown = cn ? methods.filter((m) => m.id === "email" || m.linked) : methods;
  const passkeys = identities?.passkeys ?? 0;

  async function run(id: MethodId, action: () => Promise<void>) {
    setBusy(id);
    setError(null);
    setSwitchTo(null);
    try {
      await action();
    } catch (e) {
      if (e instanceof IdentityInUseError && e.switchTo) {
        const go = e.switchTo;
        setSwitchTo(() => go);
      }
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  function add(id: MethodId): Promise<void> {
    if (id === "apple.com") {
      return linkApple({ client: gateway, reloadUser, signInWithAppleToken }).then(() => undefined);
    }
    // Google: the Firebase SDK links it; the list is read again after
    return linkProvider("google.com").then(() => loadIdentities(gateway));
  }

  const action =
    "shrink-0 rounded-md border border-edge px-2.5 py-1 text-xs transition-colors disabled:opacity-50";
  const shownError = error ?? redirectError;
  return (
    <div data-testid="signin-methods" className="space-y-2">
      <p className="text-xs text-fg-muted">Sign in with</p>
      {/* gateway 00155: another account holds this email */}
      {identities?.other_account && view.email ? (
        <OtherAccountNotice email={view.email} providers={identities.other_account.providers ?? []} />
      ) : null}
      <ul className="divide-y divide-edge rounded-lg border border-edge">
        {shown.map((m) => {
          const removable = canRemove(methods, m.id, passkeys);
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
                    Code to {view.email}
                  </p>
                )}
              </div>
              {m.linked ? (
                removable ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(m.id, () => unlink({ client: gateway, provider: m.id, reloadUser }))
                    }
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
                  onClick={() => void run(m.id, () => add(m.id))}
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
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>{shownError}</span>
          {switchTo !== null && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                const go = switchTo;
                void run("apple.com", go);
              }}
              className={`${action} text-fg hover:border-primary/60`}
            >
              Sign in to that account
            </button>
          )}
        </div>
      )}
    </div>
  );
}
