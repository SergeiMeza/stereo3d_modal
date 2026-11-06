"use client";

/**
 * /account/billing?settle=1 (the coordinator, 2026-11-06): the SVS app
 * links here when deleting the account answered 402 balance_due. Once
 * billing has answered, the Settle sheet opens once and the parameter is
 * dropped; with nothing owed, "Nothing to pay." Signed-out visitors come
 * back here after signing in (RequireAuth keeps the query in ?next).
 */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { useSettle } from "@/components/pay/SettleSheet";
import { useBilling } from "@/lib/billing";
import { outstandingCents } from "@/lib/billingCopy";

export const NOTHING_TO_PAY = "Nothing to pay.";

function settleAsked(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("settle") === "1";
}

function dropSettleParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("settle");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export function SettleFromLink(): JSX.Element | null {
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
      {NOTHING_TO_PAY}
    </p>
  );
}
