"use client";

/**
 * Starting a Business or Studio plan (pricing 2026-11): the gateway opens
 * a subscription payment (POST /v1/billing/plan {plan, ui: elements}) and
 * this sheet takes it in our own form, like every other payment.
 */

import { LockIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { planPrice } from "@/components/pricing/planCopy";
import { formatCents, formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { GatewayError } from "@/lib/api/client";
import type { PlanDef } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { awaitPlanCredit } from "@/lib/billing";
import { useLocalPriceAtCheckout } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import { proSourceKind, useProStatus, type ProStatus } from "@/lib/pro/usePro";
import { SITE_NAME } from "@/lib/site";

import { CheckoutPane, type ConfirmResult } from "./CheckoutPane";
import { checkoutEmailAtom } from "./payAtoms";
import { CHINA_COMING_SOON_KEY, useChinaPaymentsOff } from "./chinaComingSoon";
import { checkoutCurrencyLine } from "./payCopy";
import { PlanEmailPrompt } from "@/components/billing/PlanEmailPrompt";
import { useAppAtomValue } from "@/lib/state/stores";
import { MainButtonArea, StateLine, Success, SUCCESS_CLOSE_MS } from "./PaySheet";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

type Phase =
  | { kind: "loading" }
  /** notice: the error line's message key */
  | { kind: "ready"; secret: string; publishableKey?: string; notice?: string }
  | { kind: "paying"; secret: string; publishableKey?: string }
  | { kind: "done" }
  /** key: the error line's message key */
  | { kind: "error"; key: string };

/** "Business is on. $400 of usage is ready." */
export function planStarted(def: PlanDef, t: Tr = EN): string {
  return t("pay.plan.started", { plan: def.name, amount: formatCentsShort(def.credit_cents, t) });
}

/** QA 2026-11-05: the Pro this account already has, before a plan starts
 * (copy only). A web Pro never gets here: Business and Studio are a plan
 * change for it (PlanChangeSheet), credited for the unused Pro. */
export const PRO_UNKNOWN_KEEPS = EN("pay.plan.proUnknownKeeps");

export function proNoteFor(pro: ProStatus | null, planName: string, t: Tr = EN): string | null {
  switch (proSourceKind(pro)) {
    case "app_store":
      return t("pay.plan.proNoteAppStore");
    case "mac_app_store":
      return t("pay.plan.proNoteMacAppStore");
    case "grant":
      return t("pay.plan.proNoteGrant", { app: SITE_NAME, plan: planName });
    case "unknown":
    case "web":
      // QA batch 3: a source the gateway doesn't name, or a web Pro that
      // isn't our own Stripe plan (that one never gets here): never a
      // credit line
      return t("pay.plan.proUnknownKeeps");
    default:
      return null;
  }
}

/** "$1,500 of usage every month · cancel any time; it runs to the end of
 * the paid year" (QA 2026-11-05, Terms: a cancelled plan runs to the end
 * of the period you paid for). */
export function planSubtitle(def: PlanDef, t: Tr = EN): string {
  const amount = formatCentsShort(def.credit_cents, t);
  return planPrice(def).yearly
    ? t("pay.plan.subtitleYearly", { amount })
    : t("pay.plan.subtitleMonthly", { amount });
}

/** The setup welcome's optional link, word for word (BusinessSetup). */
export const COMPANY_LINK = EN("pay.plan.companyLink");

export function PlanSheet({
  plan,
  def,
  onClose,
  companyLink = false,
}: {
  plan: "business" | "studio";
  def: PlanDef;
  onClose: (started: boolean) => void;
  /** /pricing (owner 2026-11-05): no welcome follows, so the success
   * screen carries the welcome's optional company details link and stays
   * until closed */
  companyLink?: boolean;
}): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const localPrice = useLocalPriceAtCheckout();
  const pro = useProStatus();
  const proNote = proNoteFor(pro, def.name, t);
  const big = useSheetFrame() === "headset";
  const chinaOff = useChinaPaymentsOff();
  const [phase, setPhase] = useState<Phase>(chinaOff ? { kind: "error", key: CHINA_COMING_SOON_KEY } : { kind: "loading" });
  const paidEmail = useAppAtomValue(checkoutEmailAtom);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // owner 2026-11-07: China mode with its payments off asks for nothing
    if (chinaOff) return;
    let live = true;
    gateway.startPlan(plan).then(
      (r) => live && setPhase({ kind: "ready", secret: r.checkout.client_secret, publishableKey: r.publishable_key }),
      (e: unknown) => {
        if (!live) return;
        const code = e instanceof GatewayError ? e.code : "";
        setPhase({
          kind: "error",
          key:
            code === "china_payments_unavailable"
              ? CHINA_COMING_SOON_KEY
              : code === "plan_active"
              ? "pay.plan.errorPlanActive"
              : code === "under_review"
                ? "pay.plan.errorUnderReview"
                : "pay.plan.errorUnavailable",
        });
      },
    );
    return () => {
      live = false;
    };
  }, [gateway, plan, chinaOff]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function handle(r: ConfirmResult, s: { secret: string; publishableKey?: string }): void {
    if (r === "paid" || r === "already_paid" || r === "processing") {
      setPhase({ kind: "done" });
      // the plan's usage lands a moment later: read until it shows
      void awaitPlanCredit();
      // the success step stays open while it offers the company link or
      // the plan's email (gateway 00152)
      if (!companyLink) timer.current = setTimeout(() => onClose(true), SUCCESS_CLOSE_MS);
      return;
    }
    if (r === "redirect") return;
    setPhase({ kind: "ready", ...s, notice: r === "too_many" ? "pay.copy.tooMany" : "pay.copy.declined" });
  }

  // Studio bills yearly (gateway 00089); its usage still comes monthly
  const price = planPrice(def, t);
  const renewal = new Date();
  if (price.yearly) renewal.setFullYear(renewal.getFullYear() + 1);
  else renewal.setMonth(renewal.getMonth() + 1);
  const title = t("pay.plan.title", { plan: def.name, price: formatCentsShort(price.cents, t), per: price.per });
  const subtitle = planSubtitle(def, t);
  const renewsDate = renewal.toLocaleDateString(t.locale === "en" ? "en-GB" : t.intl, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const renewsLine = t(price.yearly ? "pay.plan.billedYearly" : "pay.plan.billedMonthly", { date: renewsDate });

  if (phase.kind === "ready" || phase.kind === "paying") {
    const s = { secret: phase.secret, publishableKey: phase.publishableKey };
    const paying = phase.kind === "paying";
    return (
      <CheckoutPane
        clientSecret={s.secret}
        publishableKey={s.publishableKey}
        big={big}
        showSaveLine={false}
        returnQuery={`plan=${plan}`}
      >
        {(form, body) => (
          <SheetFrame
            open
            onClose={() => onClose(false)}
            locked={paying}
            testId="plan-sheet"
            title={title}
            subtitle={subtitle}
            footer={
              <MainButtonArea
                big={big}
                lines={[checkoutCurrencyLine(localPrice, t), renewsLine]}
                button={
                  <Button
                    size="lg"
                    data-testid="plan-main"
                    className={`w-full tabular-nums ${big ? "h-14 text-xl" : "h-12 text-base"}`}
                    disabled={!form.ready || paying}
                    onClick={async () => {
                      setPhase({ kind: "paying", ...s });
                      handle(await form.confirm(), s);
                    }}
                  >
                    {paying ? (
                      t("pay.copy.paying")
                    ) : (
                      <>
                        <LockIcon className="size-4" aria-hidden />
                        {t(price.yearly ? "pay.plan.startYearly" : "pay.plan.start", {
                          plan: def.name,
                          amount: formatCents(price.cents, t),
                        })}
                      </>
                    )}
                  </Button>
                }
              />
            }
          >
            <div className={`flex flex-col gap-4 ${paying ? "pointer-events-none opacity-60" : ""}`}>
              {proNote ? (
                <p data-testid="plan-pro-note" className="text-sm text-fg-muted">
                  {proNote}
                </p>
              ) : null}
              {body}
              {phase.kind === "ready" && phase.notice ? (
                <p data-testid="pay-error" className="text-sm text-red-400">
                  {form.message ?? t(phase.notice)}
                </p>
              ) : null}
            </div>
          </SheetFrame>
        )}
      </CheckoutPane>
    );
  }

  return (
    <SheetFrame open onClose={() => onClose(phase.kind === "done")} testId="plan-sheet" title={title}>
      {phase.kind === "done" ? (
        <>
          <Success text={planStarted(def, t)} />
          {/* gateway 00152: a Business or Studio plan needs a real main email */}
          {plan === "business" || plan === "studio" ? <PlanEmailPrompt load prefill={paidEmail} /> : null}
          {companyLink ? (
            <p className="text-center text-sm text-fg-muted">
              <Link
                href="/account/business-details"
                data-testid="plan-company-link"
                className="text-primary hover:underline"
              >
                {t("pay.plan.companyLink")}
              </Link>
            </p>
          ) : null}
        </>
      ) : phase.kind === "error" ? (
        <StateLine testId="plan-error" text={t(phase.key)} />
      ) : (
        <div data-testid="pay-skeleton" className="flex animate-pulse flex-col gap-3">
          <div className="h-12 rounded-lg bg-surface-2" />
          <div className="h-11 rounded-lg bg-surface-2" />
        </div>
      )}
    </SheetFrame>
  );
}
