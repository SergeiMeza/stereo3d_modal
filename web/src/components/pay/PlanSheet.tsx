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
import { useBilling } from "@/lib/billing";
import { proSourceKind, useProStatus, type ProStatus } from "@/lib/pro/usePro";

import { CheckoutPane, type ConfirmResult } from "./CheckoutPane";
import { MainButtonArea, StateLine, Success, SUCCESS_CLOSE_MS } from "./PaySheet";
import { CHARGED_IN_USD, DECLINED, PAYING, TOO_MANY } from "./payCopy";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; secret: string; publishableKey?: string; notice?: string }
  | { kind: "paying"; secret: string; publishableKey?: string }
  | { kind: "done" }
  | { kind: "error"; text: string };

/** "Business is on. $400 of usage is ready." */
export function planStarted(def: PlanDef): string {
  return `${def.name} is on. ${formatCentsShort(def.credit_cents)} of usage is ready.`;
}

/** QA 2026-11-05: the Pro this account already has, before a plan starts
 * (copy only). A web Pro never gets here: Business and Studio are a plan
 * change for it (PlanChangeSheet), credited for the unused Pro. */
export const PRO_UNKNOWN_KEEPS = "Your current Pro keeps running. Cancel it where you bought it if you like.";

export function proNoteFor(pro: ProStatus | null, planName: string): string | null {
  switch (proSourceKind(pro)) {
    case "app_store":
      return "Your App Store Pro keeps running. You can cancel it in your Apple ID settings.";
    case "mac_app_store":
      return "Your Mac App Store Pro keeps running. You can cancel it in your Apple ID settings.";
    case "grant":
      return `Your Pro from Spatial Video Studio keeps running alongside ${planName}.`;
    case "unknown":
    case "web":
      // QA batch 3: a source the gateway doesn't name, or a web Pro that
      // isn't our own Stripe plan (that one never gets here): never a
      // credit line
      return PRO_UNKNOWN_KEEPS;
    default:
      return null;
  }
}

/** "$1,500 of usage every month · cancel any time; it runs to the end of
 * the paid year" (QA 2026-11-05, Terms: a cancelled plan runs to the end
 * of the period you paid for). */
export function planSubtitle(def: PlanDef): string {
  const period = planPrice(def).yearly ? "year" : "month";
  return `${formatCentsShort(def.credit_cents)} of usage every month · cancel any time; it runs to the end of the paid ${period}`;
}

/** The setup welcome's optional link, word for word (BusinessSetup). */
export const COMPANY_LINK = "Add your company details for invoices";

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
  const billing = useBilling();
  const pro = useProStatus();
  const proNote = proNoteFor(pro, def.name);
  const big = useSheetFrame() === "headset";
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    gateway.startPlan(plan).then(
      (r) => live && setPhase({ kind: "ready", secret: r.checkout.client_secret, publishableKey: r.publishable_key }),
      (e: unknown) => {
        if (!live) return;
        const code = e instanceof GatewayError ? e.code : "";
        setPhase({
          kind: "error",
          text:
            code === "plan_active"
              ? "You already have a plan. Cancel it in Billing before choosing another."
              : code === "under_review"
                ? "We're checking a payment on your account. Contact support to continue."
                : "Plans aren't available right now. Try again later.",
        });
      },
    );
    return () => {
      live = false;
    };
  }, [gateway, plan]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function handle(r: ConfirmResult, s: { secret: string; publishableKey?: string }): void {
    if (r === "paid" || r === "already_paid" || r === "processing") {
      setPhase({ kind: "done" });
      void billing.refresh();
      if (!companyLink) timer.current = setTimeout(() => onClose(true), SUCCESS_CLOSE_MS);
      return;
    }
    if (r === "redirect") return;
    setPhase({ kind: "ready", ...s, notice: r === "too_many" ? TOO_MANY : DECLINED });
  }

  // Studio bills yearly (gateway 00089); its usage still comes monthly
  const price = planPrice(def);
  const renewal = new Date();
  if (price.yearly) renewal.setFullYear(renewal.getFullYear() + 1);
  else renewal.setMonth(renewal.getMonth() + 1);
  const title = `${def.name} · ${formatCentsShort(price.cents)} ${price.per}`;
  const subtitle = planSubtitle(def);
  const renewsLine = `${price.yearly ? "Billed yearly" : "Billed monthly"}. Renews on ${renewal.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} until you cancel.`;

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
                lines={[CHARGED_IN_USD, renewsLine]}
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
                      PAYING
                    ) : (
                      <>
                        <LockIcon className="size-4" aria-hidden />
                        Start {def.name} · {formatCents(price.cents)}
                        {price.yearly ? " a year" : ""}
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
                  {form.message ?? phase.notice}
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
          <Success text={planStarted(def)} />
          {companyLink ? (
            <p className="text-center text-sm text-fg-muted">
              <Link
                href="/account/business-details"
                data-testid="plan-company-link"
                className="text-primary hover:underline"
              >
                {COMPANY_LINK}
              </Link>
            </p>
          ) : null}
        </>
      ) : phase.kind === "error" ? (
        <StateLine testId="plan-error" text={phase.text} />
      ) : (
        <div data-testid="pay-skeleton" className="flex animate-pulse flex-col gap-3">
          <div className="h-12 rounded-lg bg-surface-2" />
          <div className="h-11 rounded-lg bg-surface-2" />
        </div>
      )}
    </SheetFrame>
  );
}
