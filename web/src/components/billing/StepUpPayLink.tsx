"use client";

/**
 * A step-up the saved payment method couldn't pay (402 with
 * details.pay_url, owner 2026-11-07, D): "Pay $X" to its pay page, which
 * takes today's amount and then the gateway applies the change.
 */

import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";
import { useT } from "@/lib/i18n/I18nProvider";

export function StepUpPayLink({ payUrl, amountCents }: { payUrl: string | null; amountCents: number | null | undefined }): JSX.Element | null {
  const t = useT();
  if (!payUrl) return null;
  return (
    <a
      href={payUrl}
      data-testid="plan-change-pay-link"
      className="inline-flex w-fit items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground tabular-nums hover:bg-primary/85"
    >
      {typeof amountCents === "number" && amountCents > 0
        ? t("pay.request.pay", { amount: formatCents(amountCents, t) })
        : t("billing.issues.payNow")}
    </a>
  );
}
