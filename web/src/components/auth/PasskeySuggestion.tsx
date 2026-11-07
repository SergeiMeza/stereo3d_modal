"use client";

/**
 * After a sign-in with Apple, Google or an email code: one dismissible
 * line, "Add a passkey to sign in faster next time" (ADR 0136). It never
 * blocks anything. It shows once per account until it's dismissed or a
 * passkey is added: the dismissal is kept on the gateway (account settings
 * `dismissed.passkey_suggestion`), the "just signed in" mark in this tab
 * (sessionStorage, set by /signin). Only where the browser can make a
 * passkey and the account has none.
 */

import { KeyRound, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";

import { AddPasskeyDialog } from "@/components/auth/Passkeys";
import { usePasskeysSupported } from "@/components/auth/PasskeySignIn";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n/I18nProvider";
import { markPasskeySuggestion, passkeySuggestionMarked, SUGGESTION_DISMISSED_KEY } from "@/lib/passkeys";
import { useAccountSettings } from "@/lib/useAccountSettings";
import { useRegion } from "@/lib/useRegion";

const noSubscribe = () => () => {};

export function PasskeySuggestion(): JSX.Element | null {
  const tr = useT();
  const { user } = useAuth();
  const gateway = useGateway();
  const { settings, update } = useAccountSettings();
  const supported = usePasskeysSupported();
  const cn = useRegion() === "cn";
  const marked = useSyncExternalStore(noSubscribe, passkeySuggestionMarked, () => false);
  const [hidden, setHidden] = useState(false);
  const [hasPasskey, setHasPasskey] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const eligible = user !== null && marked && supported && !cn && !hidden;
  const dismissed = settings?.dismissed?.[SUGGESTION_DISMISSED_KEY] !== undefined;

  useEffect(() => {
    if (!eligible) return;
    let stop = false;
    gateway
      .listPasskeys()
      .then((list) => {
        if (!stop) setHasPasskey(list.length > 0);
      })
      .catch(() => {
        if (!stop) setHasPasskey(true); // can't tell: say nothing
      });
    return () => {
      stop = true;
    };
  }, [eligible, gateway]);

  // the "added" line goes after a few seconds
  useEffect(() => {
    if (!added) return;
    const t = setTimeout(() => {
      setAdded(false);
      setHidden(true);
    }, 6000);
    return () => clearTimeout(t);
  }, [added]);

  if (added) {
    return (
      <p role="status" className="mx-4 mt-3 text-sm text-chart-2">
        {tr("auth.passkeySuggestion.added")}
      </p>
    );
  }
  if (!eligible || settings === null || dismissed || hasPasskey !== false) return null;

  const dismiss = () => {
    update({ dismissed: { [SUGGESTION_DISMISSED_KEY]: true } });
    markPasskeySuggestion(false);
    setHidden(true);
  };

  return (
    <div
      data-testid="passkey-suggestion"
      className="mx-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-edge bg-surface-1 px-3 py-2.5"
    >
      <KeyRound className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-fg">{tr("auth.passkeySuggestion.line")}</p>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" onClick={() => setAdding(true)}>
          {tr("auth.passkeys.addTitle")}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={tr("auth.passkeySuggestion.dismiss")} onClick={dismiss}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <AddPasskeyDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={() => {
          markPasskeySuggestion(false);
          setAdded(true);
        }}
      />
    </div>
  );
}
