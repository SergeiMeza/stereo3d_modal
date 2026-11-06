"use client";

/**
 * The 48-hour deletion at sign-in (owner 2026-11-07, gateway 00166): when
 * the signed-in account is set to be deleted (GET /v1/limits
 * account_deletion), a blocking dialog asks first. "Keep my account"
 * cancels the deletion (POST /v1/account/delete/cancel; it needs a fresh
 * sign-in, which "Confirm it's you" handles if the gateway asks).
 * "Delete it" only signs out: the deletion keeps its original time.
 * Nothing else in the app is usable until they choose. Mounted once, in
 * the layout.
 */

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { deleteAfterDay, deletionPromptAtom } from "@/lib/accountDeletion";
import { GatewayError } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { ReauthCancelledError } from "@/lib/reauth";
import { useAppAtom } from "@/lib/state/stores";

export function DeletionPrompt(): JSX.Element | null {
  const { user, signOutUser } = useAuth();
  const gateway = useGateway();
  const router = useRouter();
  const uid = user?.uid ?? null;
  const [prompt, setPrompt] = useAppAtom(deletionPromptAtom);
  const [busy, setBusy] = useState<"keep" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // on each sign-in, ask whether this account is set to be deleted
  useEffect(() => {
    if (uid === null) {
      setPrompt(null);
      return;
    }
    let cancelled = false;
    gateway
      .getLimits()
      .then((l) => {
        const d = l.account_deletion;
        if (cancelled) return;
        setPrompt(d?.pending_deletion && d.delete_after ? { uid, deleteAfter: d.delete_after } : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [uid, gateway, setPrompt]);

  const open = prompt !== null && prompt.uid === uid;
  if (!open) return null;

  async function keep(): Promise<void> {
    setBusy("keep");
    setError(null);
    try {
      await gateway.cancelAccountDeletion();
      setPrompt(null);
    } catch (e) {
      if (e instanceof GatewayError && e.code === "not_pending_deletion") {
        setPrompt(null); // nothing waits any more
      } else if (!(e instanceof ReauthCancelledError)) {
        setError("We couldn't keep your account just now. Try again.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function leave(): Promise<void> {
    setBusy("delete");
    try {
      await signOutUser();
    } finally {
      setPrompt(null);
      setBusy(null);
      router.replace("/");
    }
  }

  return (
    <AlertDialog open>
      <AlertDialogContent data-testid="deletion-prompt" onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Your account is set to be deleted on {deleteAfterDay(prompt.deleteAfter)}.</AlertDialogTitle>
          <AlertDialogDescription>
            Keep it, and everything stays as it was. Or let it go: we delete it then.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <Button variant="outline" disabled={busy !== null} onClick={() => void leave()}>
            {busy === "delete" ? "Signing out…" : "Delete it"}
          </Button>
          <Button disabled={busy !== null} onClick={() => void keep()} data-testid="deletion-keep">
            {busy === "keep" ? "Keeping…" : "Keep my account"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
