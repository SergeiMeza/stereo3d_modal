"use client";

/**
 * P1 Pay sheet and P3 Confirm payment (spec v6 G2): a run that waits for
 * its payment (`billing.status: requires_payment`) is paid here, on the
 * gateway's Checkout Session for that run.
 *
 * - P1 (nothing saved, or a pay-now method): "{Action} · $X", the project
 *   line, wallets, the form, the two lines, **Pay $X and start**.
 * - P3 (`reason` authentication or declined): "Confirm your payment" with
 *   why, the same form and button.
 *
 * Closing while it's open needs no confirmation: the run shows "Waiting for
 * payment…" and **Finish payment** reopens the same payment (P12).
 */

import { CheckIcon, LockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { CheckoutHandle, ConversionBilling } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

import { CheckoutPane, type ConfirmResult } from "./CheckoutPane";
import { HandoffSheet } from "./HandoffSheet";
import {
  ALIPAY_LINE,
  ALREADY_PAID,
  BANK_WANTS,
  CHARGED_IN_USD,
  CONFIRM_TITLE,
  DECLINED,
  declinedChoose,
  EXPIRED_RUN,
  PAID_STARTING,
  PAYING,
  REFUNDED_IF_FAILS,
  TOO_MANY,
  UNAVAILABLE,
  WAITING_CONFIRM,
  WITHDRAWAL_LINE,
  payAndStart,
} from "./payCopy";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; checkout: CheckoutHandle; notice?: "declined" | "too_many" }
  | { kind: "paying"; checkout: CheckoutHandle }
  | { kind: "waiting" }
  | { kind: "done"; text: string }
  | { kind: "expired" }
  | { kind: "unavailable" };

/** How long the success check shows before the sheet closes. */
export const SUCCESS_CLOSE_MS = 1500;

export function PaySheet({
  conversionId,
  amountCents,
  action,
  subtitle,
  thumb,
  billing,
  projectId,
  onClose,
}: {
  conversionId: string;
  amountCents: number;
  /** "Make 3D", "Preview this moment" */
  action: string;
  /** "{Project} · {what} · {quality}" */
  subtitle?: string;
  thumb?: string;
  /** the run's billing: its open payment and why it waits */
  billing?: ConversionBilling;
  /** for the return page after a redirect */
  projectId?: string;
  /** paid = the run is on its way; open = closed with the payment open */
  onClose: (outcome: "paid" | "open") => void;
}): JSX.Element {
  const gateway = useGateway();
  const frame = useSheetFrame();
  const big = frame === "headset";
  const [phase, setPhase] = useState<Phase>(() =>
    billing?.checkout ? { kind: "ready", checkout: billing.checkout } : { kind: "loading" },
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // P7: a headset can hand the payment to a phone or computer
  const [handoff, setHandoff] = useState(false);

  // the open payment, when the run didn't carry it (Finish payment)
  useEffect(() => {
    if (phase.kind !== "loading") return;
    let live = true;
    gateway
      .payNowCheckout(conversionId)
      .then((s) => live && setPhase({ kind: "ready", checkout: s.checkout }))
      .catch((e: { code?: string }) => {
        if (!live) return;
        if (e.code === "already_paid") finish(ALREADY_PAID);
        else if (e.code === "expired") setPhase({ kind: "expired" });
        else setPhase({ kind: "unavailable" });
      });
    return () => {
      live = false;
    };
    // finish is stable for this sheet's life
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, conversionId, gateway]);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  function finish(text: string): void {
    setPhase({ kind: "done", text });
    closeTimer.current = setTimeout(() => onClose("paid"), SUCCESS_CLOSE_MS);
  }

  async function startAgain(): Promise<void> {
    setPhase({ kind: "loading" });
    try {
      const s = await gateway.payNowCheckout(conversionId, true);
      setPhase({ kind: "ready", checkout: s.checkout });
    } catch {
      setPhase({ kind: "unavailable" });
    }
  }

  function handle(result: ConfirmResult, checkout: CheckoutHandle): void {
    switch (result) {
      case "paid":
        return finish(PAID_STARTING);
      case "already_paid":
        return finish(ALREADY_PAID);
      case "processing":
        return setPhase({ kind: "waiting" });
      case "expired":
        return setPhase({ kind: "expired" });
      case "redirect":
        return; // the browser is leaving for /pay/return
      case "too_many":
        return setPhase({ kind: "ready", checkout, notice: "too_many" });
      default:
        return setPhase({ kind: "ready", checkout, notice: "declined" });
    }
  }

  const confirmTitle = billing?.reason === "authentication" || billing?.reason === "declined";
  const title = confirmTitle ? CONFIRM_TITLE : `${action} · ${formatCents(amountCents)}`;
  const why =
    billing?.reason === "authentication"
      ? BANK_WANTS
      : billing?.reason === "declined"
        ? declinedChoose(billing.declined_method_label ?? "payment method")
        : null;
  const locked = phase.kind === "paying";

  if (handoff) {
    return (
      <HandoffSheet
        conversionId={conversionId}
        onPayHere={() => {
          setHandoff(false);
          // the hand-off replaced the payment: open a fresh one here
          void startAgain();
        }}
        onClose={(paid) => onClose(paid ? "paid" : "open")}
      />
    );
  }

  let body: ReactNode;
  let footer: ReactNode = null;
  if (phase.kind === "ready" || phase.kind === "paying") {
    const checkout = phase.checkout;
    const notice = phase.kind === "ready" ? phase.notice : undefined;
    return (
      <CheckoutPane
        clientSecret={checkout.client_secret}
        big={big}
        collapseCards={big}
        returnQuery={`conversion=${encodeURIComponent(conversionId)}${
          projectId ? `&project=${encodeURIComponent(projectId)}` : ""
        }`}
      >
        {(form, formBody) => {
          const alipay = form.selected === "alipay";
          // spec B13: a headset with no wallet here leads with paying on
          // another device; "Pay here instead" shows the card fields
          const elsewhereFirst = big && form.wallets === false && !form.cardsOpen;
          return (
            <SheetFrame
              open
              onClose={() => onClose("open")}
              locked={locked}
              testId="pay-sheet"
              title={title}
              subtitle={confirmTitle ? undefined : subtitle}
              media={thumb ? <Thumb src={thumb} big={big} /> : undefined}
              footer={
                <MainButtonArea
                  big={big}
                  lines={[CHARGED_IN_USD, WITHDRAWAL_LINE]}
                  extra={alipay ? ALIPAY_LINE : undefined}
                  button={
                    elsewhereFirst ? (
                      <Button
                        size="lg"
                        data-testid="pay-other-device"
                        className="h-14 w-full text-xl"
                        onClick={() => setHandoff(true)}
                      >
                        Pay on another device
                      </Button>
                    ) : (
                    <Button
                      size="lg"
                      data-testid="pay-main"
                      className={`w-full tabular-nums ${big ? "h-14 text-xl" : "h-12 text-base"}`}
                      disabled={!form.ready || locked}
                      onClick={async () => {
                        // headset: the card fields first, then pay
                        if (!form.cardsOpen) return form.openCards();
                        setPhase({ kind: "paying", checkout });
                        handle(await form.confirm(), checkout);
                      }}
                    >
                      {locked ? (
                        <>
                          <Spinner /> {PAYING}
                        </>
                      ) : alipay ? (
                        "Continue to Alipay"
                      ) : (
                        <>
                          <LockIcon className="size-4" aria-hidden />
                          {payAndStart(amountCents)}
                        </>
                      )}
                    </Button>
                    )
                  }
                  foot={REFUNDED_IF_FAILS}
                  after={
                    elsewhereFirst ? (
                      <button
                        type="button"
                        data-testid="pay-here-instead"
                        onClick={form.openCards}
                        className="w-full py-3 text-center text-xl text-primary hover:underline"
                      >
                        Pay here instead
                      </button>
                    ) : big ? (
                      <button
                        type="button"
                        data-testid="pay-other-device"
                        disabled={locked}
                        onClick={() => setHandoff(true)}
                        className="w-full py-3 text-center text-xl text-primary hover:underline"
                      >
                        Pay on another device
                      </button>
                    ) : undefined
                  }
                />
              }
            >
              <div className={`flex flex-col gap-4 ${locked ? "pointer-events-none opacity-60" : ""}`}>
                {why ? <p className="text-sm text-fg">{why}</p> : null}
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
          );
        }}
      </CheckoutPane>
    );
  }

  if (phase.kind === "loading") {
    body = (
      <div data-testid="pay-skeleton" className="flex animate-pulse flex-col gap-3">
        <div className="h-12 rounded-lg bg-surface-2" />
        <div className="h-11 rounded-lg bg-surface-2" />
        <div className="h-11 rounded-lg bg-surface-2" />
      </div>
    );
  } else if (phase.kind === "waiting") {
    body = <StateLine testId="pay-waiting" text={WAITING_CONFIRM} />;
  } else if (phase.kind === "done") {
    body = <Success text={phase.text} />;
  } else if (phase.kind === "expired") {
    body = <StateLine testId="pay-expired" text={EXPIRED_RUN} />;
    footer = (
      <Button size="lg" className="h-12 w-full" onClick={() => void startAgain()}>
        Start again
      </Button>
    );
  } else {
    body = <StateLine testId="pay-unavailable" text={UNAVAILABLE} />;
  }
  return (
    <SheetFrame
      open
      onClose={() => onClose(phase.kind === "done" ? "paid" : "open")}
      testId="pay-sheet"
      title={title}
      subtitle={confirmTitle ? undefined : subtitle}
      media={thumb ? <Thumb src={thumb} big={big} /> : undefined}
      footer={footer}
    >
      {body}
    </SheetFrame>
  );
}

/** The lines above the main button, the button, and its footnote. */
export function MainButtonArea({
  lines,
  extra,
  button,
  foot,
  after,
  big = false,
}: {
  lines: string[];
  extra?: string;
  button: ReactNode;
  foot?: string;
  /** a text button under it (headset: Pay on another device) */
  after?: ReactNode;
  big?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <ul
        data-testid="pay-lines"
        className={`flex flex-col gap-1 rounded-lg border border-edge/70 px-3 py-2 text-fg-muted ${
          big ? "text-lg" : "text-xs"
        }`}
      >
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
        {extra ? <li className="text-fg">{extra}</li> : null}
      </ul>
      {button}
      {foot ? (
        <p className={`text-center text-fg-muted ${big ? "text-lg" : "text-xs"}`}>{foot}</p>
      ) : null}
      {after}
    </div>
  );
}

export function Success({ text }: { text: string }): JSX.Element {
  return (
    <div data-testid="pay-success" className="flex flex-col items-center gap-3 py-8 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300 motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-300">
        <CheckIcon className="size-7" strokeWidth={2.5} />
      </span>
      <p className="text-base font-medium text-fg">{text}</p>
    </div>
  );
}

export function StateLine({ text, testId }: { text: string; testId?: string }): JSX.Element {
  return (
    <p data-testid={testId} className="py-6 text-center text-sm text-fg">
      {text}
    </p>
  );
}

function Spinner(): JSX.Element {
  return (
    <span
      aria-hidden
      className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

function Thumb({ src, big }: { src: string; big: boolean }): JSX.Element {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className={`shrink-0 rounded-md object-cover ${big ? "h-14 w-24" : "h-10 w-16"}`}
    />
  );
}
