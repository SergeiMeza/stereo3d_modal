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
import { CHINA_COMING_SOON_KEY, useChinaPaymentsOff } from "@/components/pay/chinaComingSoon";
import { sheetCurrencyLine } from "@/components/pay/payCopy";
import { useSessionExpiry } from "@/components/pay/sessionExpiry";
import {
  MainButtonArea,
  StateLine,
  Success,
  SUCCESS_CLOSE_MS,
} from "@/components/pay/PaySheet";
import { Button } from "@/components/ui/button";
import { SheetFrame, useSheetFrame } from "@/components/ui/sheet-frame";
import { GatewayError } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { useLocalPriceAtCheckout } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import {
  finishProCheckout,
  proCheckoutAtom,
} from "@/lib/pro/checkoutStore";
import { anchorLine, creditShort, proPlanName } from "@/lib/pro/plans";
import type { ProPlan } from "@/lib/pro/plans";

export function ProCheckoutHost(): JSX.Element | null {
  const p = useAppAtomValue(proCheckoutAtom);
  if (!p) return null;
  return <ProStripeSheet key={p.plan.id} plan={p.plan} />;
}

type Phase =
  | { kind: "loading" }
  /** notice: the error line's message key */
  | { kind: "ready"; secret: string; publishableKey?: string; expiresAt?: string; notice?: string }
  | { kind: "paying"; secret: string; publishableKey?: string; expiresAt?: string }
  | { kind: "done" }
  /** BUX-02: the bank is still confirming it; Pro isn't on yet */
  | { kind: "waiting" }
  /** BUX-02: the session timed out, nothing was charged */
  | { kind: "expired" }
  /** key: the error line's message key */
  | { kind: "error"; key: string };

/** "Renews at $5.99 a week until you cancel." */
export function proRenewsLine(plan: ProPlan, t: Tr = EN): string {
  return t("pro.checkout.renews", { price: anchorLine(plan, t) });
}

function ProStripeSheet({ plan }: { plan: ProPlan }): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const localPrice = useLocalPriceAtCheckout();
  const big = useSheetFrame() === "headset";
  const chinaOff = useChinaPaymentsOff();
  const [phase, setPhase] = useState<Phase>(chinaOff ? { kind: "error", key: CHINA_COMING_SOON_KEY } : { kind: "loading" });
  // Start again opens a new payment
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // owner 2026-11-07: China mode with its payments off asks for nothing
    if (chinaOff) return;
    let live = true;
    gateway.startPlan(plan.id).then(
      (r) =>
        live &&
        setPhase({
          kind: "ready",
          secret: r.checkout.client_secret,
          publishableKey: r.publishable_key,
          expiresAt: r.checkout.expires_at,
        }),
      (e: unknown) => {
        if (!live) return;
        const code = e instanceof GatewayError ? e.code : "";
        setPhase({
          kind: "error",
          key:
            code === "china_payments_unavailable"
              ? CHINA_COMING_SOON_KEY
              : code === "plan_active"
                ? "pro.checkout.planActive"
                : "pro.checkout.unavailable",
        });
      },
    );
    return () => {
      live = false;
    };
  }, [gateway, plan.id, chinaOff, attempt]);

  // BUX-02: an idle form past its session's end says it timed out
  useSessionExpiry(
    phase.kind === "ready" ? phase.expiresAt : undefined,
    phase.kind === "ready",
    () => setPhase((p) => (p.kind === "ready" ? { kind: "expired" } : p)),
  );

  function handle(
    r: ConfirmResult,
    s: { secret: string; publishableKey?: string; expiresAt?: string },
  ): void {
    if (r === "paid" || r === "already_paid") {
      setPhase({ kind: "done" });
      setTimeout(() => finishProCheckout("purchased"), SUCCESS_CLOSE_MS);
      return;
    }
    if (r === "redirect") return;
    // BUX-02: neither is a decline
    if (r === "processing") return setPhase({ kind: "waiting" });
    if (r === "expired") return setPhase({ kind: "expired" });
    setPhase({
      kind: "ready",
      ...s,
      notice: r === "too_many" ? "pay.copy.tooMany" : "pay.copy.declined",
    });
  }

  const today = plan.price;
  const title = proPlanName(plan, t);
  // owner 2026-11-07: no intro offers on the web; the credit to start shows
  const credit = creditShort(plan.creditCents, t);
  const perPeriod = anchorLine(plan, t);
  const subtitle = credit ? t("pro.checkout.subtitleWithCredit", { price: perPeriod, credit }) : perPeriod;

  if (phase.kind === "ready" || phase.kind === "paying") {
    const s = { secret: phase.secret, publishableKey: phase.publishableKey, expiresAt: phase.expiresAt };
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
                // owner 2026-11-07 (Option B): Stripe's own amount, in the
                // local currency while the gateway offers it
                lines={[sheetCurrencyLine(localPrice, Math.round(plan.amountMicros / 10_000), t), proRenewsLine(plan, t)]}
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
                      t("pay.copy.paying")
                    ) : (
                      <>
                        <LockIcon className="size-4" aria-hidden />
                        {t("pro.checkout.start", { price: today })}
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
    <SheetFrame
      open
      onClose={() =>
        finishProCheckout(phase.kind === "done" ? "purchased" : "cancelled")
      }
      testId="pro-stripe-sheet"
      title={title}
      footer={
        phase.kind === "expired" ? (
          <Button
            size="lg"
            data-testid="pro-start-again"
            className="h-12 w-full"
            onClick={() => {
              setPhase({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            {t("pay.sheet.startAgain")}
          </Button>
        ) : undefined
      }
    >
      {phase.kind === "done" ? (
        <Success text={t("pro.checkout.success")} />
      ) : phase.kind === "waiting" ? (
        <StateLine testId="pro-stripe-waiting" text={t("pro.checkout.processing")} />
      ) : phase.kind === "expired" ? (
        <StateLine testId="pro-stripe-expired" text={t("pay.copy.timedOut")} />
      ) : phase.kind === "error" ? (
        <StateLine testId="pro-stripe-error" text={t(phase.key)} />
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
