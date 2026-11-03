"use client";

/**
 * /account — profile, billing explainer, session, danger zone. The UID row
 * is click-to-copy because it's the support identifier: projects and
 * conversions are keyed to it, so "send us your account ID" must be one
 * click. Deleting the account requires typing DELETE (native input — the
 * usual typed confirmation, not a Radix dialog). The gateway deletes it:
 * it charges what is owed first and refuses while a balance is unpaid or a
 * run is going; a bank's 3DS challenge is completed here and the delete
 * retried once.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import Link from "next/link";

import { UserAvatar } from "@/components/auth/UserAvatar";
import { completeChargeAction } from "@/components/billing/settleAction";
import { formatCents } from "@/components/steps/money";
import { GatewayError } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { useBilling } from "@/lib/billing";

const PROVIDER_LABELS: Record<string, string> = {
  "google.com": "Google",
  password: "Email",
};

function CardShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-edge bg-surface-1 p-4">
      <h2 className="font-medium text-fg">{title}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function deleteErrorMessage(err: unknown): string {
  if (err instanceof GatewayError && err.code === "balance_due") {
    const cents = err.details?.amount_cents;
    const amount =
      typeof cents === "number" && cents > 0 ? ` (${formatCents(cents)})` : "";
    return `Payment needed${amount}: update your payment method on Billing, then delete your account.`;
  }
  if (err instanceof GatewayError && err.code === "active_runs") {
    return "A run is still going. Cancel it or wait for it to finish, then delete your account.";
  }
  return err instanceof Error ? err.message : "Failed to delete account.";
}

export default function AccountScreen() {
  const { user, signOutUser, updateDisplayName } = useAuth();
  const gateway = useGateway();
  const billing = useBilling();
  const router = useRouter();

  const [name, setName] = useState(user?.displayName ?? "");
  const [nameState, setNameState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (user === null) return null;

  async function saveName(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNameState("saving");
    setNameError(null);
    try {
      await updateDisplayName(name.trim());
      setNameState("saved");
    } catch (err) {
      setNameState("idle");
      setNameError(
        err instanceof Error ? err.message : "Failed to update name.",
      );
    }
  }

  async function copyUid() {
    await navigator.clipboard.writeText(user!.uid);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function signOut() {
    await signOutUser();
    router.replace("/");
  }

  async function onDelete() {
    setDeletePending(true);
    setDeleteError(null);
    try {
      await deleteWithChallenge();
      await signOutUser();
      router.replace("/");
    } catch (err) {
      setDeletePending(false);
      void billing.refresh();
      setDeleteError(deleteErrorMessage(err));
    }
  }

  /** The bank may ask to confirm the outstanding charge (3DS): confirm it,
   * then try the delete once more. */
  async function deleteWithChallenge() {
    try {
      await gateway.deleteAccount();
    } catch (err) {
      const d = err instanceof GatewayError ? err.details : undefined;
      if (
        !(err instanceof GatewayError) ||
        err.code !== "balance_due" ||
        d?.requires_action !== true ||
        typeof d.client_secret !== "string" ||
        typeof d.publishable_key !== "string"
      ) {
        throw err;
      }
      const confirmed = await completeChargeAction(
        d.publishable_key,
        d.client_secret,
      );
      if (!confirmed.ok) throw err;
      await gateway.deleteAccount();
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Account</h1>

      <CardShell title="Profile">
        <div className="flex items-center gap-3">
          <UserAvatar
            photoURL={user.photoURL}
            name={user.displayName ?? user.email}
            className="size-10 text-base"
          />
          <div className="min-w-0">
            <p className="truncate text-fg">{user.email ?? "No email"}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {user.providerIds.map((id) => (
                <span
                  key={id}
                  className="rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-xs text-fg-muted"
                >
                  {PROVIDER_LABELS[id] ?? id}
                </span>
              ))}
            </div>
          </div>
        </div>

        <form onSubmit={saveName} className="space-y-1">
          <label htmlFor="account-name" className="block text-xs text-fg-muted">
            Display name
          </label>
          <div className="flex gap-2">
            <input
              id="account-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameState("idle");
              }}
              className="w-full flex-1 rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-fg outline-none focus:border-primary/60"
            />
            <button
              type="submit"
              disabled={nameState === "saving"}
              className="rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-fg transition-colors hover:border-primary/60 disabled:opacity-50"
            >
              {nameState === "saving"
                ? "Saving…"
                : nameState === "saved"
                  ? "Saved"
                  : "Save"}
            </button>
          </div>
          {nameError !== null && (
            <p className="text-xs text-destructive">{nameError}</p>
          )}
        </form>

        <div className="flex items-center justify-between gap-3 border-t border-edge pt-3">
          <div className="min-w-0">
            <p className="text-xs text-fg-muted">
              Account ID — quote this in support requests; projects and
              conversions are keyed to it.
            </p>
            <p className="truncate font-mono text-xs text-fg">{user.uid}</p>
          </div>
          <button
            type="button"
            onClick={() => void copyUid()}
            className="shrink-0 rounded-md border border-edge px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-primary/60 hover:text-fg"
          >
            {copied ? "Copied" : "Copy ID"}
          </button>
        </div>
      </CardShell>

      <CardShell title="Billing">
        <p className="text-fg-muted">
          Your card and purchase history are on{" "}
          <Link href="/account/billing" className="text-primary hover:underline">
            Billing
          </Link>
          .
        </p>
      </CardShell>

      <CardShell title="Session">
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-fg transition-colors hover:border-primary/60"
        >
          Sign out
        </button>
      </CardShell>

      <section className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <h2 className="font-medium text-destructive">Danger zone</h2>
        <div className="mt-3 space-y-3">
          <div className="space-y-1">
            <label
              htmlFor="delete-confirm"
              className="block text-xs text-fg-muted"
            >
              Type DELETE to permanently delete your account
            </label>
            <div className="flex gap-2">
              <input
                id="delete-confirm"
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="w-full flex-1 rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-fg outline-none focus:border-destructive/60"
              />
              <button
                type="button"
                disabled={confirmText !== "DELETE" || deletePending}
                onClick={() => void onDelete()}
                className="shrink-0 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
              >
                {deletePending ? "Deleting…" : "Delete account"}
              </button>
            </div>
          </div>
          {deleteError !== null && (
            <p className="text-xs text-destructive">{deleteError}</p>
          )}
          <p className="text-xs text-fg-muted">
            Anything you still owe is charged to your saved payment method first. Your
            projects, videos and 3D files are removed from your account at
            once; billing records are kept for support.
          </p>
        </div>
      </section>
    </div>
  );
}
