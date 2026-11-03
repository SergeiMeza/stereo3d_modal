"use client";

/**
 * P2 Settle sheet (spec v6 G2/C11): paying what the account owes, from the
 * banner, any "Pay $X to …" button, or account deletion. One payment for
 * the whole amount (POST /v1/billing/settle {ui: elements}).
 *
 * `SettleProvider` lets anything under it open the sheet: `useSettle()`.
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { CheckoutStart } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";

import { CheckoutPane, type ConfirmResult } from "./CheckoutPane";
import { MainButtonArea, StateLine, Success, SUCCESS_CLOSE_MS } from "./PaySheet";
import {
  ALREADY_SETTLED,
  CHARGED_IN_USD,
  CONFIRMING,
  DECLINED,
  EXPIRED,
  PAYING,
  SETTLED,
  SETTLE_FOOT,
  SETTLE_TITLE,
  TOO_MANY,
  UNAVAILABLE,
  paidMoreWaiting,
  settleSubtitle,
} from "./payCopy";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; start: CheckoutStart; notice?: "declined" | "too_many" }
  | { kind: "paying"; start: CheckoutStart }
  | { kind: "confirming" }
  | { kind: "done"; text: string }
  | { kind: "more"; paid: number; owed: number }
  | { kind: "expired" }
  | { kind: "unavailable" };

const SettleContext = createContext<{ openSettle: (then?: () => void) => void }>({
  openSettle: () => {},
});

/** Open the settle sheet from anywhere under SettleProvider. */
export function useSettle(): { openSettle: (then?: () => void) => void } {
  return useContext(SettleContext);
}

export function SettleProvider({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const after = useRef<(() => void) | undefined>(undefined);
  return (
    <SettleContext.Provider
      value={{
        openSettle: (then) => {
          after.current = then;
          setOpen(true);
        },
      }}
    >
      {children}
      {open ? (
        <SettleSheet
          onClose={(paid) => {
            setOpen(false);
            if (paid) after.current?.();
            after.current = undefined;
          }}
        />
      ) : null}
    </SettleContext.Provider>
  );
}

export function SettleSheet({ onClose }: { onClose: (paid: boolean) => void }): JSX.Element {
  const gateway = useGateway();
  const billing = useBilling();
  const big = useSheetFrame() === "headset";
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        if (e.code === "already_paid") done(ALREADY_SETTLED);
        else setPhase({ kind: "unavailable" });
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

  function done(text: string): void {
    setPhase({ kind: "done", text });
    void billing.refresh();
    timer.current = setTimeout(() => onClose(true), SUCCESS_CLOSE_MS);
  }

  async function handle(result: ConfirmResult, start: CheckoutStart): Promise<void> {
    switch (result) {
      case "paid": {
        const after = await billing.refresh();
        const owed = after?.outstanding?.amount_cents ?? 0;
        if (owed > 0) setPhase({ kind: "more", paid: start.amount_cents, owed });
        else done(SETTLED);
        return;
      }
      case "already_paid":
        return done(ALREADY_SETTLED);
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
    const locked = phase.kind === "paying";
    return (
      <CheckoutPane
        clientSecret={start.checkout.client_secret}
        publishableKey={start.publishable_key}
        big={big}
        showSaveLine={false}
        returnQuery="settle=1"
      >
        {(form, formBody) => (
          <SheetFrame
            open
            onClose={() => onClose(false)}
            locked={locked}
            testId="settle-sheet"
            title={SETTLE_TITLE}
            subtitle={start.runs ? settleSubtitle(start.runs) : undefined}
            footer={
              <MainButtonArea
                big={big}
                lines={[CHARGED_IN_USD]}
                button={
                  <Button
                    size="lg"
                    data-testid="settle-main"
                    className={`w-full tabular-nums ${big ? "h-14 text-xl" : "h-12 text-base"}`}
                    disabled={!form.ready || locked}
                    onClick={async () => {
                      setPhase({ kind: "paying", start });
                      await handle(await form.confirm(), start);
                    }}
                  >
                    {locked ? PAYING : `Pay ${formatCents(start.amount_cents)}`}
                  </Button>
                }
                foot={SETTLE_FOOT}
              />
            }
          >
            <div className={`flex flex-col gap-4 ${locked ? "pointer-events-none opacity-60" : ""}`}>
              {notice === "too_many" ? (
                <p data-testid="pay-error" className="text-sm text-red-400">
                  {TOO_MANY}
                </p>
              ) : null}
              {formBody}
              {notice === "declined" ? (
                <p data-testid="pay-error" className="text-sm text-red-400">
                  {form.message ?? DECLINED}
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
      body = <StateLine testId="settle-confirming" text={CONFIRMING} />;
      break;
    case "done":
      body = <Success text={phase.text} />;
      break;
    case "more":
      body = <StateLine testId="settle-more" text={paidMoreWaiting(phase.paid)} />;
      footer = (
        <Button size="lg" className="h-12 w-full" onClick={() => setPhase({ kind: "loading" })}>
          Pay {formatCents(phase.owed)}
        </Button>
      );
      break;
    case "expired":
      body = <StateLine testId="settle-expired" text={EXPIRED} />;
      footer = (
        <Button size="lg" className="h-12 w-full" onClick={() => setPhase({ kind: "loading" })}>
          Try again
        </Button>
      );
      break;
    default:
      body = <StateLine testId="pay-unavailable" text={UNAVAILABLE} />;
  }
  return (
    <SheetFrame
      open
      onClose={() => onClose(phase.kind === "done")}
      testId="settle-sheet"
      title={SETTLE_TITLE}
      footer={footer}
    >
      {body}
    </SheetFrame>
  );
}
