"use client";

/**
 * REV-14: a top-up whose payment left the page comes back to Billing as
 * /account/billing?topup={id} (the gateway's default return, 988d6c5).
 * Billing then says how it went for that top-up and no other: "Checking
 * your payment…" until its ledger row lands (read on arrival, on each
 * billing event and on the slow poll), then "Added $25.00. Your balance
 * is $40.00."; a refused redirect says it didn't go through; a hosted
 * page's cancel (canceled=1) says nothing. The query is dropped once read.
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { topupDone } from "@/components/pay/payCopy";
import { prepaidOf } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBillingVersion, useFallbackTick } from "@/lib/live/useLive";
import { useT } from "@/lib/i18n/I18nProvider";

import { CHECK_MS, topupEntry } from "./PayReturnScreen";

interface Returned {
  id: string | null;
  failed: boolean;
}

const DROPPED = ["topup", "redirect_status", "payment_intent", "payment_intent_client_secret", "session_id", "canceled"];

function readReturn(): Returned | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const value = q.get("topup") ?? "";
  if (value === "" || q.get("canceled") === "1") return null;
  return { id: value === "1" ? null : value, failed: q.get("redirect_status") === "failed" };
}

function dropReturn(): void {
  const url = new URL(window.location.href);
  for (const key of DROPPED) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export function TopupFromReturn(): JSX.Element | null {
  const t = useT();
  const gateway = useGateway();
  // read once, when the page opens
  const [ret] = useState(readReturn);
  const [openedAt] = useState(() => Date.now());
  const [phase, setPhase] = useState<"checking" | "added" | "failed" | "slow" | null>(() =>
    ret ? (ret.failed ? "failed" : "checking") : null,
  );
  const [added, setAdded] = useState<{ cents: number; balance: number } | null>(null);
  const billingVersion = useBillingVersion();
  const fallback = useFallbackTick();

  useEffect(() => {
    if (ret) dropReturn();
  }, [ret]);

  useEffect(() => {
    if (phase !== "checking" && phase !== "slow") return;
    if (!ret) return;
    let live = true;
    void Promise.all([gateway.getBalanceEntries(), gateway.getBilling()]).then(
      ([page, b]) => {
        if (!live) return;
        const row = topupEntry(page.entries, null, openedAt, ret.id);
        if (!row) return;
        const balance = prepaidOf(b)?.balance_cents ?? row.cents;
        setAdded({ cents: row.cents, balance });
        setPhase("added");
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // arrival, each billing event, each slow poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, billingVersion, fallback]);

  useEffect(() => {
    if (phase !== "checking") return;
    const timer = setTimeout(() => setPhase((p) => (p === "checking" ? "slow" : p)), CHECK_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === null) return null;
  const text =
    phase === "added" && added
      ? topupDone(added.cents, added.balance, t)
      : phase === "failed"
        ? t("billing.payReturn.notPaid")
        : phase === "slow"
          ? t("billing.payReturn.slowTopup")
          : t("billing.payReturn.checking");
  return (
    <p data-testid="topup-return" data-state={phase} role="status" className="text-sm text-fg">
      {text}
    </p>
  );
}
