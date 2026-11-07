"use client";

/**
 * BUX-20: the one-tap button ("Pay US$3.75 with Visa •••• 4242") with
 * Change payment method (Billing's payment methods) and Pay another way
 * (the sheet) under it. Busy from the first tap until the payment ends;
 * one line under it says what happened (confirming, declined, the amount
 * changed). No local-price line: one tap charges US dollars.
 */

import Link from "next/link";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/I18nProvider";

/** Billing's payment methods. */
export const CHANGE_METHOD_HREF = "/account/billing#payment-methods";

export function OneTapBlock({
  label,
  busy,
  disabled = false,
  notice,
  tone = "info",
  big = false,
  onTap,
  onAnotherWay,
  anotherWayDisabled = false,
}: {
  label: string;
  /** a tap is out or being confirmed: spinner, no second tap */
  busy: boolean;
  disabled?: boolean;
  notice?: string | null;
  tone?: "info" | "error";
  big?: boolean;
  onTap: () => void;
  onAnotherWay: () => void;
  anotherWayDisabled?: boolean;
}): JSX.Element {
  const t = useT();
  return (
    <div data-testid="one-tap" className="flex flex-col gap-2">
      <Button
        size="lg"
        data-testid="one-tap-pay"
        className={`w-full tabular-nums ${big ? "h-14 text-xl" : "h-12 text-base"}`}
        disabled={busy || disabled}
        aria-busy={busy}
        onClick={() => {
          if (!busy && !disabled) onTap();
        }}
      >
        {busy ? (
          <>
            <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />{" "}
            {t("pay.copy.paying")}
          </>
        ) : (
          label
        )}
      </Button>
      {notice ? (
        <p
          data-testid="one-tap-notice"
          role="status"
          className={`text-sm ${tone === "error" ? "text-red-400" : "text-fg-muted"}`}
        >
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
        <Link data-testid="one-tap-change" href={CHANGE_METHOD_HREF} className="text-primary hover:underline">
          {t("pay.oneTap.changeMethod")}
        </Link>
        <button
          type="button"
          data-testid="one-tap-another-way"
          disabled={anotherWayDisabled}
          onClick={onAnotherWay}
          className="text-primary hover:underline disabled:opacity-50"
        >
          {t("pay.oneTap.anotherWay")}
        </button>
      </div>
    </div>
  );
}
