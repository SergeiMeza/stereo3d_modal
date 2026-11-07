"use client";

/**
 * P2 Settle sheet (spec v6 G2/C11): paying what the account owes, from the
 * banner, any "Pay $X to …" button, or account deletion. One payment for
 * the whole amount (POST /v1/billing/settle {ui: elements}).
 *
 * `SettleProvider` lets anything under it open the sheet: `useSettle()`.
 */

import { useEffect, useRef, useState } from "react";

import { appStore, useAppAtom } from "@/lib/state/stores";

import { settleOpenAtom } from "./payAtoms";
import type { JSX, ReactNode } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { prepaidOf, type CheckoutStart } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";
import { useLocalPriceAtCheckout } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";

import { CheckoutPane, type ConfirmResult } from "./CheckoutPane";
import { MainButtonArea, payOpenErrorKey, StateLine, Success, SUCCESS_CLOSE_MS } from "./PaySheet";
import { paidMoreWaiting, settleSubtitle, sheetCurrencyLine } from "./payCopy";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; start: CheckoutStart; notice?: "declined" | "too_many" }
  | { kind: "paying"; start: CheckoutStart }
  | { kind: "confirming" }
  /** key: the success line's message */
  | { kind: "done"; key: string }
  | { kind: "more"; paid: number; owed: number }
  | { kind: "expired" }
  /** BUX-05: key, the line for why it couldn't be opened */
  | { kind: "unavailable"; key: string };

/** ADR 0138: the sheet's open state is an app-store atom (payAtoms, no
 * context); what to do once paid is a callback, kept here. */
let afterSettle: (() => void) | undefined;

function openSettle(then?: () => void): void {
  afterSettle = then;
  appStore.set(settleOpenAtom, true);
}

/** Open the settle sheet from anywhere (SettleProvider shows it). */
export function useSettle(): { openSettle: (then?: () => void) => void } {
  return { openSettle };
}

/** Shows the settle sheet while it's open (mounted once, in the layout). */
export function SettleProvider({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useAppAtom(settleOpenAtom);
  return (
    <>
      {children}
      {open ? (
        <SettleSheet
          onClose={(paid) => {
            setOpen(false);
            if (paid) afterSettle?.();
            afterSettle = undefined;
          }}
        />
      ) : null}
    </>
  );
}

export function SettleSheet({ onClose }: { onClose: (paid: boolean) => void }): JSX.Element {
  const gateway = useGateway();
  const billing = useBilling();
  const t = useT();
  const localPrice = useLocalPriceAtCheckout();
  const big = useSheetFrame() === "headset";
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [fromBalance, setFromBalance] = useState<"idle" | "paying" | "failed">("idle");

  useEffect(() => {
    if (phase.kind !== "loading") return;
    let live = true;
    gateway
      .settleCheckout()
      .then((start) => {
        if (!live) return;
        setPhase(
          start.payment_state === "processing" ? { kind: "confirming" } : { kind: "ready", start },
        );
      })
      .catch((e: { code?: string }) => {
        if (!live) return;
        if (e.code === "already_paid") done("pay.copy.alreadySettled");
        else setPhase({ kind: "unavailable", key: payOpenErrorKey(e) });
      });
    return () => {
      live = false;
    };
    // done is stable for this sheet's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, gateway]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function done(key: string): void {
    setPhase({ kind: "done", key });
    void billing.refresh();
    timer.current = setTimeout(() => onClose(true), SUCCESS_CLOSE_MS);
  }

  /** spec v7 N9: pay what's owed from the prepaid balance */
  async function payFromBalance(start: CheckoutStart): Promise<void> {
    setFromBalance("paying");
    try {
      await gateway.settleFromBalance();
      setFromBalance("idle");
      await handle("paid", start);
    } catch {
      setFromBalance("failed");
    }
  }

  async function handle(result: ConfirmResult, start: CheckoutStart): Promise<void> {
    switch (result) {
      case "paid": {
        const after = await billing.refresh();
        const owed = after?.outstanding?.amount_cents ?? 0;
        if (owed > 0) setPhase({ kind: "more", paid: start.amount_cents, owed });
        else done("pay.copy.settled");
        return;
      }
      case "already_paid":
        return done("pay.copy.alreadySettled");
      case "processing":
        void billing.refresh();
        return setPhase({ kind: "confirming" });
      case "expired":
        return setPhase({ kind: "expired" });
      case "redirect":
        return;
      case "too_many":
        return setPhase({ kind: "ready", start, notice: "too_many" });
      default:
        return setPhase({ kind: "ready", start, notice: "declined" });
    }
  }

  if (phase.kind === "ready" || phase.kind === "paying") {
    const start = phase.start;
    const notice = phase.kind === "ready" ? phase.notice : undefined;
    const locked = phase.kind === "paying" || fromBalance === "paying";
    const prepaid = prepaidOf(billing.status);
    const balanceCovers = prepaid !== null && prepaid.available_cents >= start.amount_cents;
    return (
      <CheckoutPane
        clientSecret={start.checkout.client_secret}
        publishableKey={start.publishable_key}
        big={big}
        showSaveLine={false}
        returnQuery="settle=1"
        // BUX-03: a wallet pays through the same paying state and result
        onWallet={(result) => {
          setPhase({ kind: "paying", start });
          void result.then((r) => handle(r, start));
        }}
      >
        {(form, formBody) => (
          <SheetFrame
            open
            onClose={() => onClose(false)}
            locked={locked}
            testId="settle-sheet"
            title={t("pay.copy.settleTitle")}
            subtitle={start.runs ? settleSubtitle(start.runs, t) : undefined}
            footer={
              <MainButtonArea
                big={big}
                lines={[sheetCurrencyLine(localPrice, start.amount_cents, t)]}
                button={
                  <Button
                    size="lg"
                    data-testid="settle-main"
                    variant={balanceCovers ? "outline" : "default"}
                    className={`w-full tabular-nums ${big ? "h-14 text-xl" : "h-12 text-base"}`}
                    disabled={!form.ready || locked}
                    onClick={async () => {
                      setPhase({ kind: "paying", start });
                      await handle(await form.confirm(), start);
                    }}
                  >
                    {locked ? t("pay.copy.paying") : t("pay.settle.pay", { amount: formatCents(start.amount_cents, t) })}
                  </Button>
                }
                foot={t("pay.copy.settleFoot")}
              />
            }
          >
            <div className={`flex flex-col gap-4 ${locked ? "pointer-events-none opacity-60" : ""}`}>
              {balanceCovers ? (
                <div className="flex flex-col gap-2">
                  <Button
                    size="lg"
                    data-testid="settle-balance"
                    className={`w-full tabular-nums ${big ? "h-14 text-xl" : "h-12 text-base"}`}
                    disabled={locked}
                    onClick={() => void payFromBalance(start)}
                  >
                    {fromBalance === "paying"
                      ? t("pay.copy.paying")
                      : t("pay.settle.payFromBalance", { amount: formatCents(start.amount_cents, t) })}
                  </Button>
                  <p className="text-center text-xs text-fg-muted tabular-nums">
                    {t("pay.settle.balance", { amount: formatCents(prepaid.available_cents, t) })}
                  </p>
                  {fromBalance === "failed" ? (
                    <p data-testid="pay-error" className="text-sm text-red-400">
                      {t("balance.copy.settleFailed")}
                    </p>
                  ) : null}
                  <p className="flex items-center gap-3 pt-1 text-xs text-fg-muted">
                    <span className="h-px flex-1 bg-edge" />
                    {t("pay.copy.orPayAnotherWay")}
                    <span className="h-px flex-1 bg-edge" />
                  </p>
                </div>
              ) : null}
              {notice === "too_many" ? (
                <p data-testid="pay-error" className="text-sm text-red-400">
                  {t("pay.copy.tooMany")}
                </p>
              ) : null}
              {formBody}
              {notice === "declined" ? (
                <p data-testid="pay-error" className="text-sm text-red-400">
                  {form.message ?? t("pay.copy.declined")}
                </p>
              ) : null}
            </div>
          </SheetFrame>
        )}
      </CheckoutPane>
    );
  }

  let body: ReactNode;
  let footer: ReactNode = null;
  switch (phase.kind) {
    case "loading":
      body = (
        <div data-testid="pay-skeleton" className="flex animate-pulse flex-col gap-3">
          <div className="h-12 rounded-lg bg-surface-2" />
          <div className="h-11 rounded-lg bg-surface-2" />
        </div>
      );
      break;
    case "confirming":
      body = <StateLine testId="settle-confirming" text={t("pay.copy.confirming")} />;
      break;
    case "done":
      body = <Success text={t(phase.key)} />;
      break;
    case "more":
      body = <StateLine testId="settle-more" text={paidMoreWaiting(phase.paid, t)} />;
      footer = (
        <Button size="lg" className="h-12 w-full" onClick={() => setPhase({ kind: "loading" })}>
          {t("pay.settle.pay", { amount: formatCents(phase.owed, t) })}
        </Button>
      );
      break;
    case "expired":
      body = <StateLine testId="settle-expired" text={t("pay.copy.expired")} />;
      footer = (
        <Button size="lg" className="h-12 w-full" onClick={() => setPhase({ kind: "loading" })}>
          {t("pay.settle.tryAgain")}
        </Button>
      );
      break;
    default:
      body = <StateLine testId="pay-unavailable" text={t(phase.key)} />;
  }
  return (
    <SheetFrame
      open
      onClose={() => onClose(phase.kind === "done")}
      testId="settle-sheet"
      title={t("pay.copy.settleTitle")}
      footer={footer}
    >
      {body}
    </SheetFrame>
  );
}
