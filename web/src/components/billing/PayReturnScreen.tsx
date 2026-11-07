"use client";

/**
 * P4 Return page (`/pay/return`, spec v6 G2): where every redirect comes
 * back — Alipay, PayPal, a bank's page, a hosted payment page.
 *
 * ?conversion=&project= or ?c= (a run) or ?settle= (what the account owed).
 * Checking polls for up to 30 s; then Paid, Not paid, Slow or Expired.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { Success } from "@/components/pay/PaySheet";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";
import { outstandingCents } from "@/lib/billingCopy";
import type { LiveRun } from "@/lib/live/events";
import { applyRun } from "@/lib/live/liveStore";
import { useBillingVersion, useFallbackTick, useLiveRunById } from "@/lib/live/useLive";
import { appStore } from "@/lib/state/stores";
import { useT } from "@/lib/i18n/I18nProvider";
import { SITE_NAME } from "@/lib/site";

/** "Checking your payment…" for up to this long, then Slow */
export const CHECK_MS = 30_000;

type State = "checking" | "paid" | "not_paid" | "slow" | "expired";

/** A pay-now payment the run still asks for after this long didn't go through. */
const LATE_MS = 6000;

/** What the run says about the payment (null: still waiting). */
function runOutcome(run: LiveRun | null, late: boolean): State | null {
  if (run?.state === undefined) return null;
  if (run.state === "expired") return "expired";
  if (run.state === "canceled" || run.state === "failed") return "not_paid";
  if (run.state !== "created") return "paid";
  if (run.billing?.status === "requires_payment" && late) return "not_paid";
  return null;
}

export function PayReturnScreen(): JSX.Element {
  const t = useT();
  const gateway = useGateway();
  const params = useSearchParams();
  // the gateway's session return_url says ?c={run} or ?settle={id}; the
  // web's own links say ?conversion=&project= or ?settle=1
  const id = params.get("conversion") ?? params.get("c");
  const settle = (params.get("settle") ?? "") !== "";
  // a redirect that came back refused says so in the URL
  const refused = params.get("redirect_status") === "failed";
  const [state, setState] = useState<State>(refused ? "not_paid" : "checking");
  const [late, setLate] = useState(false);

  // owner 2026-11-07: the run's payment comes from the live feed, like
  // every status. One read puts it there (the stream may not have named
  // it yet); nothing here polls the run.
  const run = useLiveRunById(id ?? "");
  const project = params.get("project") ?? run?.project_id ?? null;
  useEffect(() => {
    if (settle || !id || refused) return;
    gateway.getConversion(id).then(
      (c) => void applyRun(appStore, c),
      () => undefined,
    );
  }, [gateway, id, settle, refused]);
  if (state === "checking" && !settle) {
    const outcome = !id ? "not_paid" : runOutcome(run, late);
    if (outcome !== null) setState(outcome);
  }

  // a payment the run still asks for after 6 s didn't go through; after
  // 30 s the page says it's slow
  useEffect(() => {
    if (state !== "checking") return;
    // the verdict on a run that still asks for payment uses a fresh read
    // (the stream may be down and the slow poll 15 s apart)
    const lateTimer = setTimeout(() => {
      const read = id && !settle ? gateway.getConversion(id).then((c) => void applyRun(appStore, c)) : Promise.resolve();
      void read.catch(() => undefined).finally(() => setLate(true));
    }, LATE_MS);
    const slowTimer = setTimeout(() => setState((s) => (s === "checking" ? "slow" : s)), CHECK_MS);
    return () => {
      clearTimeout(lateTimer);
      clearTimeout(slowTimer);
    };
  }, [state, gateway, id, settle]);

  // settling what the account owes (owner 2026-11-07): the billing status
  // is read on arrival, again on each billing event from the live feed
  // (billing.updated), and on the slow poll while the stream is down
  const billingVersion = useBillingVersion();
  const fallback = useFallbackTick();
  useEffect(() => {
    if (state !== "checking" || !settle) return;
    let live = true;
    gateway.getBilling().then(
      (b) => {
        if (!live) return;
        if (outstandingCents(b) === 0) setState("paid");
        else if (!b.outstanding?.settling) setState("not_paid");
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // arrival, each billing event, each slow poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, settle, billingVersion, fallback]);

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
          <p className="text-base text-fg">{t("billing.payReturn.checking")}</p>
        </>
      ) : state === "paid" ? (
        <>
          <Success text={settle ? t("pay.copy.settled") : t("billing.payReturn.paidRun")} />
          <Button asChild size="lg" className="h-12 w-full">
            <Link href={settle ? "/projects" : back}>
              {settle ? t("billing.payReturn.backToApp", { app: SITE_NAME }) : t("billing.payReturn.backToProject")}
            </Link>
          </Button>
        </>
      ) : state === "not_paid" ? (
        <>
          <p className="text-base text-fg">{t("billing.payReturn.notPaid")}</p>
          <Button asChild size="lg" className="h-12 w-full">
            <Link href={back}>{t("billing.payReturn.tryAgain")}</Link>
          </Button>
          <Link href={back} className="text-sm text-primary hover:underline">
            {t("billing.payReturn.chooseAnother")}
          </Link>
        </>
      ) : state === "slow" ? (
        <>
          <p className="text-base text-fg">{t("billing.payReturn.slow")}</p>
          <Button asChild size="lg" className="h-12 w-full">
            <Link href={back}>{t("billing.payReturn.backToProject")}</Link>
          </Button>
        </>
      ) : (
        <>
          <p className="text-base text-fg">{t("pay.copy.expiredRun")}</p>
          <Button asChild size="lg" className="h-12 w-full">
            <Link href={back}>{t("billing.payReturn.startAgain")}</Link>
          </Button>
        </>
      )}
    </section>
  );
}
