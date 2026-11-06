"use client";

/**
 * Web Pro checkout on our own Stripe subscription (owner 2026-11-04): the
 * gateway opens it (POST /v1/billing/plan {plan: pro_monthly…}) and the
 * payment is taken in our own form, like Business and Studio. The price,
 * any intro and how it renews show before paying; nothing is charged
 * until the person confirms. Mounted once in the layout; useBuyPro opens
 * it.
 */

import { LockIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useAppAtomValue } from "@/lib/state/stores";
import type { JSX } from "react";

import {
  CheckoutPane,
  type ConfirmResult,
} from "@/components/pay/CheckoutPane";
import {
  MainButtonArea,
  StateLine,
  Success,
  SUCCESS_CLOSE_MS,
} from "@/components/pay/PaySheet";
import {
  CHARGED_IN_USD,
  DECLINED,
  PAYING,
  TOO_MANY,
} from "@/components/pay/payCopy";
import { Button } from "@/components/ui/button";
import { SheetFrame, useSheetFrame } from "@/components/ui/sheet-frame";
import { GatewayError } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import {
  finishProCheckout,
  proCheckoutAtom,
} from "@/lib/pro/checkoutStore";
import { creditLine, planName } from "@/lib/pro/plans";
import type { ProPlan } from "@/lib/pro/plans";

export function ProCheckoutHost(): JSX.Element | null {
  const p = useAppAtomValue(proCheckoutAtom);
  if (!p) return null;
  return <ProStripeSheet key={p.plan.id} plan={p.plan} />;
}

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; secret: string; publishableKey?: string; notice?: string }
  | { kind: "paying"; secret: string; publishableKey?: string }
  | { kind: "done" }
  | { kind: "error"; text: string };

const UNIT = { weekly: "week", monthly: "month", yearly: "year" } as const;

/** "Renews at $5.99 a week until you cancel." */
export function proRenewsLine(plan: ProPlan): string {
  return `Renews at ${plan.price} a ${UNIT[plan.kind]} until you cancel.`;
}

function ProStripeSheet({ plan }: { plan: ProPlan }): JSX.Element {
  const gateway = useGateway();
  const big = useSheetFrame() === "headset";
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    gateway.startPlan(plan.id).then(
      (r) =>
        live &&
        setPhase({
          kind: "ready",
          secret: r.checkout.client_secret,
          publishableKey: r.publishable_key,
        }),
      (e: unknown) => {
        if (!live) return;
        const code = e instanceof GatewayError ? e.code : "";
        setPhase({
          kind: "error",
          text:
            code === "plan_active"
              ? "You already have a plan. Manage it in Billing."
              : "Pro isn't available right now. Try again later.",
        });
      },
    );
    return () => {
      live = false;
    };
  }, [gateway, plan.id]);

  function handle(
    r: ConfirmResult,
    s: { secret: string; publishableKey?: string },
  ): void {
    if (r === "paid" || r === "already_paid" || r === "processing") {
      setPhase({ kind: "done" });
      setTimeout(() => finishProCheckout("purchased"), SUCCESS_CLOSE_MS);
      return;
    }
    if (r === "redirect") return;
    setPhase({
      kind: "ready",
      ...s,
      notice: r === "too_many" ? TOO_MANY : DECLINED,
    });
  }

  const today = plan.price;
  const title = `Pro ${planName(plan)}`;
  // owner 2026-11-07: no intro offers on the web; the monthly credit shows
  const credit = creditLine(plan.creditCents);
  const subtitle = `${plan.price} a ${UNIT[plan.kind]}${credit ? `, with ${credit}` : ""}`;

  if (phase.kind === "ready" || phase.kind === "paying") {
    const s = { secret: phase.secret, publishableKey: phase.publishableKey };
    const paying = phase.kind === "paying";
    return (
      <CheckoutPane
        clientSecret={s.secret}
        publishableKey={s.publishableKey}
        big={big}
        showSaveLine={false}
        returnQuery={`plan=${plan.id}`}
      >
        {(form, body) => (
          <SheetFrame
            open
            onClose={() => finishProCheckout("cancelled")}
            locked={paying}
            testId="pro-stripe-sheet"
            title={title}
            subtitle={subtitle}
            footer={
              <MainButtonArea
                big={big}
                lines={[CHARGED_IN_USD, proRenewsLine(plan)]}
                button={
                  <Button
                    size="lg"
                    data-testid="pro-stripe-pay"
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
                        Start Pro · {today}
                      </>
                    )}
                  </Button>
                }
              />
            }
          >
            <div
              className={`flex flex-col gap-4 ${paying ? "pointer-events-none opacity-60" : ""}`}
            >
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
    <SheetFrame
      open
      onClose={() =>
        finishProCheckout(phase.kind === "done" ? "purchased" : "cancelled")
      }
      testId="pro-stripe-sheet"
      title={title}
    >
      {phase.kind === "done" ? (
        <Success text="Pro is on. Every video is cheaper now." />
      ) : phase.kind === "error" ? (
        <StateLine testId="pro-stripe-error" text={phase.text} />
      ) : (
        <div
          data-testid="pay-skeleton"
          className="flex animate-pulse flex-col gap-3"
        >
          <div className="h-12 rounded-lg bg-surface-2" />
          <div className="h-11 rounded-lg bg-surface-2" />
        </div>
      )}
    </SheetFrame>
  );
}
