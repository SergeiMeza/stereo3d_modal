"use client";

/**
 * /account/billing?settle=1 (the coordinator, 2026-11-06): the SVS app
 * links here when deleting the account answered 402 balance_due. Once
 * billing has answered, the Settle sheet opens once and the parameter is
 * dropped; with nothing owed, "Nothing to pay." Signed-out visitors come
 * back here after signing in (RequireAuth keeps the query in ?next).
 * The failed-payment mails link with ?pay=1 (BUX-01); both open the sheet.
 * BUX-20: a one-tap settle's bank check comes back with ?settle={id}: paid
 * reads "Paid. Your downloads are back.", still owed opens the sheet
 * (which says when it's still being confirmed).
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

/** "ask": open the sheet; "back": a one-tap settle's bank check returned. */
function settleAsked(): "ask" | "back" | null {
  if (typeof window === "undefined") return null;
  const query = new URLSearchParams(window.location.search);
  if (SETTLE_PARAMS.some((key) => query.get(key) === "1")) return "ask";
  return (query.get("settle") ?? "") !== "" ? "back" : null;
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
      {asked === "back" ? t("pay.copy.settled") : t("billing.settle.nothingToPay")}
    </p>
  );
}
