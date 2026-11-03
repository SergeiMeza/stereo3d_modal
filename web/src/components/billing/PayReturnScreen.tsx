"use client";

/**
 * P4 Return page (`/pay/return`, spec v6 G2): where every redirect comes
 * back — Alipay, PayPal, a bank's page, a hosted payment page.
 *
 * ?conversion=&project= (a run) or ?settle=1 (what the account owed).
 * Checking polls for up to 30 s; then Paid, Not paid, Slow or Expired.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { EXPIRED_RUN, SETTLED } from "@/components/pay/payCopy";
import { Success } from "@/components/pay/PaySheet";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { outstandingCents } from "@/lib/billingCopy";

const POLL_MS = 2000;
/** "Checking your payment…" for up to this long, then Slow */
export const CHECK_MS = 30_000;

type State = "checking" | "paid" | "not_paid" | "slow" | "expired";

export function PayReturnScreen(): JSX.Element {
  const gateway = useGateway();
  const params = useSearchParams();
  const id = params.get("conversion");
  const project = params.get("project");
  const settle = params.get("settle") === "1";
  // a redirect that came back refused says so in the URL
  const refused = params.get("redirect_status") === "failed";
  const [state, setState] = useState<State>(refused ? "not_paid" : "checking");

  useEffect(() => {
    if (state !== "checking") return;
    const started = Date.now();
    let live = true;
    const check = async (): Promise<void> => {
      try {
        if (settle) {
          const b = await gateway.getBilling();
          if (outstandingCents(b) === 0) return setState("paid");
          if (b.outstanding?.settling) return;
          return setState("not_paid");
        }
        if (!id) return setState("not_paid");
        const c = await gateway.getConversion(id);
        if (c.state === "expired") return setState("expired");
        if (c.state === "canceled" || c.state === "failed") return setState("not_paid");
        if (c.state !== "created") return setState("paid");
        if (c.billing?.status === "requires_payment" && Date.now() - started > 6000) {
          return setState("not_paid");
        }
      } catch {
        /* keep checking */
      }
    };
    const t = setInterval(() => {
      if (!live) return;
      if (Date.now() - started > CHECK_MS) {
        clearInterval(t);
        setState((s) => (s === "checking" ? "slow" : s));
        return;
      }
      void check();
    }, POLL_MS);
    void check();
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [gateway, id, settle, state]);

  const back = project ? `/projects/${project}#tab=make` : "/projects";
  return (
    <section
      data-testid="pay-return"
      data-state={state}
      className="mx-auto flex w-full max-w-[440px] flex-1 flex-col items-center justify-center gap-4 px-4 py-20 text-center"
    >
      {state === "checking" ? (
        <>
          <span
            aria-hidden
            className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent"
          />
          <p className="text-base text-fg">Checking your payment…</p>
        </>
      ) : state === "paid" ? (
        <>
          <Success text={settle ? SETTLED : "Payment received. Your 3D video is starting."} />
          <Button asChild size="lg" className="h-12 w-full">
            <Link href={settle ? "/projects" : back}>
              {settle ? "Back to Spatial Video Studio" : "Back to your project"}
            </Link>
          </Button>
        </>
      ) : state === "not_paid" ? (
        <>
          <p className="text-base text-fg">The payment didn&apos;t go through.</p>
          <Button asChild size="lg" className="h-12 w-full">
            <Link href={back}>Try again</Link>
          </Button>
          <Link href={back} className="text-sm text-primary hover:underline">
            Choose another way to pay
          </Link>
        </>
      ) : state === "slow" ? (
        <>
          <p className="text-base text-fg">
            This is taking longer than usual. We&apos;ll start as soon as the payment is
            confirmed.
          </p>
          <Button asChild size="lg" className="h-12 w-full">
            <Link href={back}>Back to your project</Link>
          </Button>
        </>
      ) : (
        <>
          <p className="text-base text-fg">{EXPIRED_RUN}</p>
          <Button asChild size="lg" className="h-12 w-full">
            <Link href={back}>Start again</Link>
          </Button>
        </>
      )}
    </section>
  );
}
