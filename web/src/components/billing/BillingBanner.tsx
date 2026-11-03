"use client";

/**
 * P9 account banner (spec v6 G2/C10), on every signed-in workspace page:
 *
 * - Outstanding: "There's a problem with your last payment." · **Pay $X**
 *   (the settle sheet, P2). Downloads and plays read "Pay $X to …" too.
 * - Confirming (a payment for it is in progress): "Confirming your
 *   payment…", no button.
 * - Under review: "We're checking a payment on your account." · **Contact
 *   support**.
 *
 * `openCardUpdate` opens the payment-method portal (Billing's "Manage
 * payment methods").
 */

import { AlertCircleIcon, LockIcon } from "lucide-react";
import type { JSX } from "react";

import { FEEDBACK_EMAIL } from "@/components/FeedbackLink";
import {
  CONFIRMING,
  PAYMENT_PROBLEM as PROBLEM,
  UNDER_REVIEW,
  payToContinue,
} from "@/components/pay/payCopy";
import { useSettle } from "@/components/pay/SettleSheet";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";
import { outstandingCents } from "@/lib/billingCopy";

/** Injectable for tests (jsdom cannot navigate). */
let navigateExternal = (url: string) => window.location.assign(url);
export function setNavigateExternalForTests(fn: (url: string) => void): void {
  navigateExternal = fn;
}

export const PAYMENT_PROBLEM = PROBLEM;

/** Open the payment-method portal; returns an error sentence or null once
 * the browser is on its way. */
export async function openCardUpdate(
  gateway: ReturnType<typeof useGateway>,
): Promise<string | null> {
  try {
    const { url } = await gateway.createBillingPortalSession(window.location.href);
    navigateExternal(url);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Couldn't open the payment method page";
  }
}

/** P14 "Outstanding": the run button while the account owes. */
export function PayToContinue({ size = "lg" }: { size?: "lg" | "default" }): JSX.Element {
  const cents = outstandingCents(useBilling().status);
  const { openSettle } = useSettle();
  return (
    <Button
      size={size}
      data-testid="billing-block"
      className="w-full bg-red-400 text-zinc-950 tabular-nums hover:bg-red-300"
      onClick={() => openSettle()}
    >
      {payToContinue(cents)}
    </Button>
  );
}

export function supportMailto(subject = "Payment on my account"): string {
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

export function BillingBanner(): JSX.Element | null {
  const { status } = useBilling();
  const { openSettle } = useSettle();
  if (!status) return null;
  const owed = outstandingCents(status);
  const settling = status.outstanding?.settling === true;
  const review = status.flow_state === "under_review";
  if (owed <= 0 && !review) return null;

  return (
    <div
      data-testid="billing-banner"
      role="status"
      className="border-b border-red-900/50 bg-red-950/30 px-4 py-2.5"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center gap-3">
        <AlertCircleIcon className="size-4 shrink-0 text-red-300" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-red-100">
          {review ? UNDER_REVIEW : settling ? CONFIRMING : PROBLEM}
        </p>
        {review ? (
          <a
            href={supportMailto()}
            data-testid="billing-support"
            className="shrink-0 text-sm font-medium text-red-200 hover:underline"
          >
            Contact support
          </a>
        ) : !settling ? (
          <Button
            size="sm"
            data-testid="billing-pay"
            onClick={() => openSettle()}
            className="shrink-0 bg-red-400 text-zinc-950 tabular-nums hover:bg-red-300"
          >
            <LockIcon className="size-3.5" aria-hidden />
            Pay {formatCents(owed)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
