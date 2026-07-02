"use client";

/**
 * /account — profile, billing explainer, session, danger zone. The UID row
 * is click-to-copy because it's the support identifier: projects and
 * conversions are keyed to it, so "send us your account ID" must be one
 * click. Deleting the account requires typing DELETE (native input — the
 * usual typed confirmation, not a Radix dialog) and surfaces Firebase's
 * requires-recent-login as the friendly re-auth message from lib/auth.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { UserAvatar } from "@/components/auth/UserAvatar";
import { useAuth } from "@/lib/auth";

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

export default function AccountScreen() {
  const { user, signOutUser, updateDisplayName, deleteAccount } = useAuth();
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
      await deleteAccount();
      router.replace("/");
    } catch (err) {
      setDeletePending(false);
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete account.",
      );
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
          Billing is pay-per-conversion. Your card is charged only when a
          conversion succeeds — authorization holds are released automatically
          if a run fails or is cancelled. Receipts arrive by email from
          Stripe. There is no payment method to manage here: card details are
          collected securely at checkout for each conversion.
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
            Uploaded sources and rendered outputs expire automatically; billing
            records are retained for support.
          </p>
        </div>
      </section>
    </div>
  );
}
