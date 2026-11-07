"use client";

/**
 * Add an email with a code (gateway 00152): the address, a code to it,
 * then POST /v1/account/emails. Shared by Account → "Add another email"
 * and the plan's "Add an email for your plan" (main, never a hidden Apple
 * address). Another account's address offers "Sign in to that account"
 * with the same code.
 */

import { useState } from "react";
import type { JSX } from "react";

import { CodeInput } from "@/components/auth/CodeInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { errorText } from "@/lib/authErrors";
import { CODE_LENGTH, isAppleRelayEmail } from "@/lib/emailCode";
import { useT } from "@/lib/i18n/I18nProvider";
import { useAppSetAtom } from "@/lib/state/stores";

import { addEmailAtom, EmailInUseError, sendAddEmailCode } from "./emailAtoms";

export function AddEmailForm({
  idPrefix,
  mainChoice,
  forPlan = false,
  prefill = "",
  submitLabel,
  onDone,
  onCancel,
}: {
  idPrefix: string;
  /** offer "Make it my main email" (otherwise forPlan decides) */
  mainChoice: boolean;
  /** the plan's email: made main, a hidden Apple address refused */
  forPlan?: boolean;
  prefill?: string;
  submitLabel?: string;
  onDone?: () => void;
  onCancel?: () => void;
}): JSX.Element {
  const t = useT();
  const gateway = useGateway();
  const { reloadUser, signInWithEmailCode } = useAuth();
  const addEmail = useAppSetAtom(addEmailAtom);
  const [email, setEmail] = useState(prefill);
  const [step, setStep] = useState<"email" | "code">("email");
  const [code, setCode] = useState("");
  const [makeMain, setMakeMain] = useState(forPlan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inUse, setInUse] = useState(false);

  async function send(): Promise<void> {
    const e = email.trim();
    if (!e.includes("@")) {
      setError(t("auth.emails.enterAddress"));
      return;
    }
    if (forPlan && isAppleRelayEmail(e)) {
      setError(t("auth.emails.relayNotMain"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendAddEmailCode(gateway, e);
      setStep("code");
    } catch (x) {
      setError(errorText(x, t, "auth.errors.sendCodeFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(digits: string): Promise<void> {
    setBusy(true);
    setError(null);
    setInUse(false);
    try {
      await addEmail({ client: gateway, email, code: digits, makeMain: forPlan || makeMain, reloadUser });
      setStep("email");
      setEmail("");
      setCode("");
      onDone?.();
    } catch (x) {
      setInUse(x instanceof EmailInUseError);
      setError(errorText(x, t, "auth.errors.didntWork"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid={`${idPrefix}-form`} className="flex flex-col gap-2">
      {step === "email" ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <Label htmlFor={`${idPrefix}-email`}>{t("auth.signIn.emailLabel")}</Label>
          <div className="flex gap-2">
            <Input
              id={`${idPrefix}-email`}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? t("auth.signIn.sending") : t("auth.emails.sendCode")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-fg-muted">{t("auth.emails.codeSentTo", { email: email.trim() })}</p>
          <CodeInput value={code} onChange={setCode} onComplete={(d) => void confirm(d)} disabled={busy} invalid={error !== null} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || code.length !== CODE_LENGTH} onClick={() => void confirm(code)}>
              {busy ? t("auth.emails.checking") : (submitLabel ?? t("auth.emails.add"))}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
            >
              {t("auth.code.back")}
            </Button>
          </div>
        </div>
      )}
      {mainChoice && !forPlan ? (
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            role="switch"
            className="size-4 accent-primary"
            checked={makeMain}
            onChange={(e) => setMakeMain(e.target.checked)}
          />
          {t("auth.emails.makeItMain")}
        </label>
      ) : null}
      {error !== null && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>{error}</span>
          {inUse ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void signInWithEmailCode(email.trim(), code).catch((x: unknown) => setError(errorText(x, t, "auth.errors.didntWorkShort")))}
            >
              {t("auth.emails.signInThere")}
            </Button>
          ) : null}
        </div>
      )}
      {onCancel ? (
        <Button size="sm" variant="ghost" className="self-start" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      ) : null}
    </div>
  );
}
