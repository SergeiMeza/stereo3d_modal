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
import { CODE_LENGTH } from "@/lib/emailCode";

import { providersWords } from "./identityState";

export function otherAccountLine(providers: string[]): string {
  const how = providersWords(providers.length > 0 ? providers : ["email"]);
  return `Another account uses this email (it signs in with ${how}).`;
}

export function OtherAccountNotice({ email, providers }: { email: string; providers: string[] }): JSX.Element {
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
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="other-account" className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p className="text-fg">{otherAccountLine(providers)}</p>
      {step === "idle" ? (
        <Button size="sm" variant="outline" className="self-start" disabled={busy} onClick={() => void run(() => sendEmailCode(email), "code")}>
          {busy ? "Sending…" : "Sign in to that account"}
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-fg-muted">Enter the code we sent to {email}.</p>
          <CodeInput value={code} onChange={setCode} onComplete={(d) => void run(() => signInWithEmailCode(email, d))} disabled={busy} invalid={error !== null} />
          <Button size="sm" className="self-start" disabled={busy || code.length !== CODE_LENGTH} onClick={() => void run(() => signInWithEmailCode(email, code))}>
            {busy ? "Checking…" : "Sign in"}
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
