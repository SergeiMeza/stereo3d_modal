"use client";

/**
 * Passkey sign-in on /signin (ADR 0136): the "Sign in with a passkey"
 * button, and the email field's autofill (the browser lists the person's
 * passkeys under the field where it can). Both end in the gateway's check
 * and a sign-in with its token (the auth context's signInWithPasskey).
 *
 * The autofill request waits in the background from the moment the page
 * shows; the button's own prompt replaces it (the library cancels the
 * waiting one), and it starts again when the button's attempt ends. A
 * closed prompt says nothing; "isn't registered here" (a passkey from
 * another site of ours, or a removed one) says to sign in another way.
 */

import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/authErrors";
import { useT } from "@/lib/i18n/I18nProvider";
import { cancelPasskeyRequest, passkeyAutofillSupported, passkeysSupported, toPasskeyError } from "@/lib/passkeys";

type SignIn = (opts?: { autofill?: boolean }) => Promise<void>;

const noSubscribe = () => () => {};

/** Whether this browser can sign in with a passkey (false on the server,
 * so the server render and hydration agree). */
export function usePasskeysSupported(): boolean {
  return useSyncExternalStore(noSubscribe, passkeysSupported, () => false);
}

/**
 * Starts the email field's passkey autofill when the browser supports it.
 * Returns whether it's on (the field then needs autocomplete="username
 * webauthn") and a restart for after the button's attempt.
 */
export function usePasskeyAutofill(
  enabled: boolean,
  signIn: SignIn,
  onError: (message: string) => void,
): { autofill: boolean; restart: () => void } {
  const t = useT();
  const [supported, setSupported] = useState(false);
  const live = useRef(true);
  const autofill = enabled && supported;

  useEffect(() => {
    let stop = false;
    void passkeyAutofillSupported().then((ok) => {
      if (!stop) setSupported(ok);
    });
    return () => {
      stop = true;
    };
  }, []);

  const run = useCallback(() => {
    signIn({ autofill: true }).catch((e: unknown) => {
      const err = toPasskeyError(e);
      if (live.current && !err.cancelled) onError(errorText(err, t));
    });
  }, [signIn, onError, t]);

  // once the field carries autocomplete="username webauthn" (this render)
  useEffect(() => {
    live.current = true;
    if (!autofill) return;
    run();
    return () => {
      live.current = false;
      cancelPasskeyRequest();
    };
  }, [autofill, run]);

  const restart = useCallback(() => {
    if (autofill && live.current) run();
  }, [autofill, run]);
  return { autofill, restart };
}

export function PasskeyButton({
  signIn,
  disabled,
  onStart,
  onError,
  onDone,
}: {
  signIn: SignIn;
  disabled?: boolean;
  onStart?: () => void;
  onError: (message: string) => void;
  /** after the attempt, signed in or not (restart the autofill) */
  onDone?: () => void;
}): JSX.Element {
  const t = useT();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    onStart?.();
    try {
      await signIn();
    } catch (e) {
      const err = toPasskeyError(e);
      if (!err.cancelled) onError(errorText(err, t));
    } finally {
      setBusy(false);
      onDone?.();
    }
  }
  return (
    <Button
      type="button"
      variant="outline"
      data-testid="signin-passkey"
      disabled={disabled || busy}
      onClick={() => void go()}
      className="h-11 w-full gap-2.5 text-sm"
    >
      <KeyRound className="size-4" aria-hidden="true" />
      {busy ? t("auth.passkeys.waiting") : t("auth.passkeys.signIn")}
    </Button>
  );
}
