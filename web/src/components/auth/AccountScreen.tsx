"use client";

/**
 * /account — profile, sign-in & security (the ways to sign in, S3D-69,
 * and passkeys, ADR 0136), billing explainer, session, danger zone. The UID row
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

import { PasskeysSection } from "@/components/auth/Passkeys";
import { SignInMethods } from "@/components/auth/SignInMethods";
import { UserAvatar } from "@/components/auth/UserAvatar";
import { completeChargeAction } from "@/components/billing/settleAction";
import { ACTIVE_RUNS_LINE, DeleteDues } from "@/components/pay/DeleteDues";
import { formatCents } from "@/components/steps/money";
import { GatewayError } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { useAuth } from "@/lib/auth";
import { useBilling } from "@/lib/billing";
import { FirstTimeHint } from "@/components/onboarding/FirstTimeHint";
import { ResetPlansSurfaces } from "@/components/plans/ResetPlansSurfaces";
import { AppStoreProLine, BusinessEntry } from "@/components/business/BusinessEntry";
import { AccountScheduledChange } from "@/components/billing/PlanChange";
import {
  DeletePlanNotice,
  deletePlanState,
  renewingFromGateway,
  type DeletePlanState,
} from "@/components/auth/deletePlanLine";
import { useProStatus } from "@/lib/pro/usePro";

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
    return ACTIVE_RUNS_LINE;
  }
  return err instanceof Error ? err.message : "Failed to delete account.";
}

export default function AccountScreen() {
  const { user, signOutUser, updateDisplayName } = useAuth();
  const gateway = useGateway();
  const billing = useBilling();
  const pro = useProStatus();
  const router = useRouter();
  // owner 2026-11-06: a renewing plan is cancelled before deleting; read
  // from the billing and Pro atoms (ADR 0138), the button waits for both
  const planKnown = (billing.status !== null || billing.error !== null) && pro !== null;
  const fromAtoms = planKnown ? deletePlanState(billing.status?.plan, pro) : null;
  /** the gateway's 409 plan_renewing, when the page's data was stale */
  const [gatewayRenewing, setGatewayRenewing] = useState<DeletePlanState>(null);
  const planState = fromAtoms?.kind === "ending" ? fromAtoms : (gatewayRenewing ?? fromAtoms);
  const mustCancel = planState?.kind === "renewing";

  const [name, setName] = useState(user?.displayName ?? "");
  const [nameState, setNameState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** P13: what's owed when delete answered 402 balance_due */
  const [dues, setDues] = useState<number | null>(null);
  /** 00081: a prepaid balance to refund before the account goes */
  const [refund, setRefund] = useState<number | null>(null);
  /** 00081: deletion waits for that refund */
  const [pending, setPending] = useState<number | null>(null);

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

  async function onDelete(balanceConfirmed = false) {
    setDeletePending(true);
    setDeleteError(null);
    setDues(null);
    try {
      const r = await deleteWithChallenge(balanceConfirmed);
      if (r.deletion_pending) {
        // 00081: the balance is refunded first; the account goes after
        setDeletePending(false);
        setRefund(null);
        setPending(r.refund_cents ?? 0);
        return;
      }
      await signOutUser();
      router.replace("/");
    } catch (err) {
      setDeletePending(false);
      void billing.refresh();
      const owed =
        err instanceof GatewayError && err.code === "balance_due"
          ? err.details?.amount_cents
          : undefined;
      const cash =
        err instanceof GatewayError && err.code === "balance_remaining"
          ? err.details?.cents
          : undefined;
      if (err instanceof GatewayError && err.code === "plan_renewing") {
        setGatewayRenewing(renewingFromGateway(err.details));
        return;
      }
      if (typeof owed === "number" && owed > 0) setDues(owed);
      else if (typeof cash === "number" && cash > 0) setRefund(cash);
      else setDeleteError(deleteErrorMessage(err));
    }
  }

  /** The bank may ask to confirm the outstanding charge (3DS): confirm it,
   * then try the delete once more. */
  async function deleteWithChallenge(balanceConfirmed: boolean) {
    try {
      return await gateway.deleteAccount({ balance_confirmed: balanceConfirmed });
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
      return gateway.deleteAccount({ balance_confirmed: balanceConfirmed });
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Account</h1>
      <FirstTimeHint id="account" />
      <ResetPlansSurfaces />

      <CardShell title="Profile">
        <div className="flex items-center gap-3">
          <UserAvatar
            photoURL={user.photoURL}
            name={user.displayName ?? user.email}
            className="size-10 text-base"
          />
          <div className="min-w-0">
            <p className="truncate text-fg">{user.email ?? "No email"}</p>
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

      {/* ADR 0136: the ways in, and passkeys */}
      <CardShell title="Sign-in & security">
        <SignInMethods />
        <PasskeysSection />
      </CardShell>

      <BusinessEntry />

      <CardShell title="Billing">
        <p className="text-fg-muted">
          Your card and purchase history are on{" "}
          <Link href="/account/billing" className="text-primary hover:underline">
            Billing
          </Link>
          .
        </p>
        <p className="pt-2 text-fg-muted">
          Invoices with your company name, tax ID and address:{" "}
          <Link href="/account/business-details" className="text-primary hover:underline">
            Business details
          </Link>
          .
        </p>
        <AccountScheduledChange />
        <AppStoreProLine />
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
          <DeletePlanNotice state={planState} />
          {mustCancel ? null : (
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
                  disabled={confirmText !== "DELETE" || deletePending || pending !== null || !planKnown}
                  onClick={() => void onDelete()}
                  className="shrink-0 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
                >
                  {deletePending ? "Deleting…" : "Delete account"}
                </button>
              </div>
            </div>
          )}
          {refund !== null && (
            // 00081: confirm the balance refund, then delete
            <div data-testid="delete-refund" className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-fg">
                We return your {formatCents(refund)} balance to your payment method first.
              </span>
              <button
                type="button"
                disabled={deletePending}
                onClick={() => void onDelete(true)}
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive hover:bg-destructive/20 disabled:opacity-50"
              >
                Refund and delete
              </button>
            </div>
          )}
          {pending !== null && (
            <p data-testid="deletion-pending" className="text-sm text-fg">
              We&apos;re returning your {formatCents(pending)}; your account is deleted once that&apos;s done.
            </p>
          )}
          {dues !== null && (
            // P13: pay what's owed in the settle sheet, then delete again
            <DeleteDues amountCents={dues} onPaid={() => void onDelete()} />
          )}
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
