"use client";

/**
 * Gateway 00155: GET /v1/account/identities can say another account uses
 * this account's email (an extra email there, made by Apple or Google),
 * named only by how it signs in. "Sign in to that account" sends a code
 * to the email; the code signs in to the account that holds it.
 */

import { useState } from "react";
import type { JSX } from "react";

import { CodeInput } from "@/components/auth/CodeInput";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/authErrors";
import { CODE_LENGTH } from "@/lib/emailCode";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

import { providersWords } from "./identityState";

export function otherAccountLine(providers: string[], t: Tr = EN): string {
  const how = providersWords(providers.length > 0 ? providers : ["email"], t);
  return t("auth.otherAccount.line", { how });
}

export function OtherAccountNotice({ email, providers }: { email: string; providers: string[] }): JSX.Element {
  const t = useT();
  const { sendEmailCode, signInWithEmailCode } = useAuth();
  const [step, setStep] = useState<"idle" | "code">("idle");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(op: () => Promise<unknown>, next?: "code"): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await op();
      if (next) setStep(next);
    } catch (e) {
      setError(errorText(e, t, "auth.errors.didntWork"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="other-account" className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p className="text-fg">{otherAccountLine(providers, t)}</p>
      {step === "idle" ? (
        <Button size="sm" variant="outline" className="self-start" disabled={busy} onClick={() => void run(() => sendEmailCode(email), "code")}>
          {busy ? t("auth.signIn.sending") : t("auth.emails.signInThere")}
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-fg-muted">{t("auth.emails.codeSentTo", { email })}</p>
          <CodeInput value={code} onChange={setCode} onComplete={(d) => void run(() => signInWithEmailCode(email, d))} disabled={busy} invalid={error !== null} />
          <Button size="sm" className="self-start" disabled={busy || code.length !== CODE_LENGTH} onClick={() => void run(() => signInWithEmailCode(email, code))}>
            {busy ? t("auth.emails.checking") : t("auth.signIn.title")}
          </Button>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
