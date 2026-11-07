"use client";

/**
 * "Confirm it's you" (owner 2026-11-06: sensitive operations need a fresh
 * sign-in). One sheet for every sensitive request: when the gateway (or
 * Firebase) asks for a recent sign-in, it offers the account's ways in —
 * a passkey of this account, Apple, Google, or a code to the email — and
 * the request is tried once more (lib/reauth). China mode offers the code
 * and passkeys, through the gateway. Mounted once, in the layout.
 */

import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { CodeInput } from "@/components/auth/CodeInput";
import { usePasskeysSupported } from "@/components/auth/PasskeySignIn";
import { AppleLogo, GoogleLogo } from "@/components/auth/ProviderLogos";
import { loadPasskeysAtom, passkeyListAtom } from "@/components/auth/passkeyAtoms";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import type { LinkableProvider } from "@/lib/auth";
import { billingUidAtom } from "@/lib/billing";
import { CODE_LENGTH, isAppleRelayEmail } from "@/lib/emailCode";
import { errorText } from "@/lib/authErrors";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN } from "@/lib/i18n/t";
import { toPasskeyError } from "@/lib/passkeys";
import { finishReauth, reauthOpenAtom } from "@/lib/reauth";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

export const REAUTH_TITLE = EN("auth.reauth.title");

export function ReauthSheet(): JSX.Element {
  const open = useAppAtomValue(reauthOpenAtom);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && finishReauth(false)}>
      <DialogContent data-testid="reauth-sheet" className="sm:max-w-sm">
        {/* mounted per opening, so each one starts fresh */}
        {open ? <ReauthBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ReauthBody(): JSX.Element {
  const t = useT();
  const gateway = useGateway();
  const { user, appleEnabled, reauthenticate, reauthenticateWithPasskey, sendEmailCode, signInWithEmailCode } =
    useAuth();
  const supported = usePasskeysSupported();
  const list = useAppAtomValue(passkeyListAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const loadPasskeys = useAppSetAtom(loadPasskeysAtom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const providers = user?.providerIds ?? [];
  const email = user?.email && !isAppleRelayEmail(user.email) ? user.email : null;
  const listed = list.uid === uid ? list.list : null;
  const hasPasskey = supported && (listed?.length ?? 0) > 0;

  // the passkey option needs the account's list (ADR 0138: the shared atom)
  useEffect(() => {
    if (supported && list.uid !== uid) void loadPasskeys(gateway);
  }, [supported, list.uid, uid, loadPasskeys, gateway]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      finishReauth(true);
    } catch (e) {
      const p = toPasskeyError(e);
      if (!p.cancelled) setError(errorText(e, t, "auth.errors.didntWork"));
    } finally {
      setBusy(false);
    }
  }

  const providerButton = (id: LinkableProvider, label: string, logo: JSX.Element) => (
    <Button type="button" variant="outline" className="h-10 w-full" disabled={busy} onClick={() => void run(() => reauthenticate(id))}>
      {logo}
      {label}
    </Button>
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("auth.reauth.title")}</DialogTitle>
        <DialogDescription>{t("auth.reauth.description")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2.5">
        {hasPasskey && (
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full"
            disabled={busy}
            onClick={() => void run(reauthenticateWithPasskey)}
          >
            <KeyRound className="size-4" aria-hidden />
            {t("auth.reauth.usePasskey")}
          </Button>
        )}
        {providers.includes("apple.com") && appleEnabled &&
          providerButton("apple.com", t("auth.signIn.continueApple"), <AppleLogo className="size-4" />)}
        {providers.includes("google.com") &&
          providerButton("google.com", t("auth.signIn.continueGoogle"), <GoogleLogo className="size-4" />)}
        {email !== null &&
          (codeSent ? (
            <div className="space-y-2">
              <p className="text-xs text-fg-muted">{t("auth.emails.codeSentTo", { email })}</p>
              <CodeInput
                value={code}
                onChange={setCode}
                onComplete={(d) => void run(() => signInWithEmailCode(email, d))}
                disabled={busy}
                invalid={error !== null}
              />
              <Button
                type="button"
                className="w-full"
                disabled={busy || code.length !== CODE_LENGTH}
                onClick={() => void run(() => signInWithEmailCode(email, code))}
              >
                {busy ? t("auth.emails.checking") : t("auth.reauth.confirm")}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="h-10 w-full"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                sendEmailCode(email)
                  .then(() => setCodeSent(true))
                  .catch((e: unknown) => setError(errorText(e, t, "auth.errors.sendCodeFailed")))
                  .finally(() => setBusy(false));
              }}
            >
              {t("auth.reauth.sendCode", { email })}
            </Button>
          ))}
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={() => finishReauth(false)}>
          {t("common.cancel")}
        </Button>
      </DialogFooter>
    </>
  );
}
