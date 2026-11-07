"use client";

/**
 * /account/billing?settle=1 (the coordinator, 2026-11-06): the SVS app
 * links here when deleting the account answered 402 balance_due. Once
 * billing has answered, the Settle sheet opens once and the parameter is
 * dropped; with nothing owed, "Nothing to pay." Signed-out visitors come
 * back here after signing in (RequireAuth keeps the query in ?next).
 * The failed-payment mails link with ?pay=1 (BUX-01); both open the sheet.
 */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { useSettle } from "@/components/pay/SettleSheet";
import { useBilling } from "@/lib/billing";
import { outstandingCents } from "@/lib/billingCopy";
import { useT } from "@/lib/i18n/I18nProvider";

/** English (tests); the page reads billing.settle.nothingToPay. */
export const NOTHING_TO_PAY = "Nothing to pay.";

/** The query keys that ask for the Settle sheet: the app's and the mails'. */
const SETTLE_PARAMS = ["settle", "pay"] as const;

function settleAsked(): boolean {
  if (typeof window === "undefined") return false;
  const query = new URLSearchParams(window.location.search);
  return SETTLE_PARAMS.some((key) => query.get(key) === "1");
}

function dropSettleParam(): void {
  const url = new URL(window.location.href);
  for (const key of SETTLE_PARAMS) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export function SettleFromLink(): JSX.Element | null {
  const t = useT();
  const { status } = useBilling();
  const { openSettle } = useSettle();
  // read once, when the page opens
  const [asked] = useState(settleAsked);
  const handled = useRef(false);
  const owed = status ? outstandingCents(status) : null;

  useEffect(() => {
    if (!asked || handled.current || owed === null) return;
    handled.current = true;
    dropSettleParam();
    if (owed > 0) openSettle();
  }, [asked, owed, openSettle]);

  if (!asked || owed === null || owed > 0) return null;
  return (
    <p role="status" data-testid="settle-nothing" className="text-sm text-fg-muted">
      {t("billing.settle.nothingToPay")}
    </p>
  );
}
