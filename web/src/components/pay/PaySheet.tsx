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
import type { CheckoutHandle, Conversion, ConversionBilling } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { versionOf, type LiveRun } from "@/lib/live/events";
import { useLiveRunById } from "@/lib/live/useLive";
import { useLocalPriceAtCheckout } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";

import { CheckoutPane, type ConfirmResult } from "./CheckoutPane";
import { HandoffSheet } from "./HandoffSheet";
import { checkoutCurrencyLine, declinedChoose, payAndStart } from "./payCopy";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; checkout: CheckoutHandle; publishableKey?: string; notice?: "declined" | "too_many" }
  | { kind: "paying"; checkout: CheckoutHandle; publishableKey?: string }
  | { kind: "waiting" }
  /** key: the success line's message (pay.copy.*) */
  | { kind: "done"; key: string }
  | { kind: "expired" }
  | { kind: "unavailable" };

/** How long the success check shows before the sheet closes. */
export const SUCCESS_CLOSE_MS = 1500;

/** staging 2026-11-05: a confirm that hasn't answered by now re-checks
 * the run instead of spinning. */
export const CONFIRM_TIMEOUT_MS = 60_000;

/** What the run says about a payment in flight: gone (expired or
 * canceled, nothing charged), paid (it's on its way), waiting for the
 * processor, or nothing yet. */
export function runPayOutcome(
  run: Pick<Conversion, "state" | "billing"> | null | undefined,
): "expired" | "paid" | "waiting" | null {
  if (!run) return null;
  if (run.state === "expired" || run.state === "canceled") return "expired";
  if (run.state === "paid" || run.state === "processing" || run.state === "succeeded") return "paid";
  if (run.billing?.status === "waiting_for_payment") return "waiting";
  return null;
}

/** The page's run or the live feed's, whichever is newer (the page's
 * wins a tie). */
function newerRun(
  run: (Pick<Conversion, "state" | "billing"> & Partial<Pick<Conversion, "updated_at">>) | null | undefined,
  live: LiveRun | null,
): Pick<Conversion, "state" | "billing"> | null | undefined {
  if (live?.state === undefined) return run;
  const fromLive = { state: live.state, billing: live.billing };
  if (!run) return fromLive;
  const a = versionOf(run.updated_at);
  const b = live.version ?? versionOf(live.updated_at);
  return Number.isFinite(a) && Number.isFinite(b) && b <= a ? run : fromLive;
}

export function PaySheet({
  conversionId,
  amountCents,
  action,
  subtitle,
  thumb,
  billing,
  publishableKey,
  projectId,
  note,
  onClose,
  run,
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
  /** the gateway's Stripe key, when the run's create response carried it */
  publishableKey?: string;
  /** for the return page after a redirect */
  projectId?: string;
  /** one small muted line under the form (personal use without a plan) */
  note?: string;
  /** paid = the run is on its way; open = closed with the payment open */
  onClose: (outcome: "paid" | "open") => void;
  /** the run as the page has it: while paying, an expired or paid run
   * ends the wait (staging 2026-11-05); the live feed's is newer */
  run?: (Pick<Conversion, "state" | "billing"> & Partial<Pick<Conversion, "updated_at">>) | null;
}): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const localPrice = useLocalPriceAtCheckout();
  const frame = useSheetFrame();
  const big = frame === "headset";
  // The form needs the gateway's publishable key: Stripe given an empty
  // one never shows the form (staging, 2026-11-05). The run's billing
  // block doesn't always carry it (Finish payment reads the run back), so
  // without a key we go through pay-now, which reuses the open session and
  // returns it. The mock gateway's sessions need no key.
  const [phase, setPhase] = useState<Phase>(() => {
    const key = publishableKey ?? billing?.publishable_key;
    const checkout = billing?.checkout;
    return checkout && (key || checkout.client_secret.startsWith("cs_mock_"))
      ? { kind: "ready", checkout, publishableKey: key }
      : { kind: "loading" };
  });
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // P7: a headset can hand the payment to a phone or computer
  const [handoff, setHandoff] = useState(false);

  // the open payment, when the run didn't carry it (Finish payment)
  useEffect(() => {
    if (phase.kind !== "loading") return;
    let live = true;
    gateway
      .payNowCheckout(conversionId)
      .then((s) => live && setPhase({ kind: "ready", checkout: s.checkout, publishableKey: s.publishable_key }))
      .catch((e: { code?: string }) => {
        if (!live) return;
        if (e.code === "already_paid") setPhase({ kind: "done", key: "pay.copy.alreadyPaid" });
        else if (e.code === "expired") setPhase({ kind: "expired" });
        else setPhase({ kind: "unavailable" });
      });
    return () => {
      live = false;
    };
  }, [phase.kind, conversionId, gateway]);

  // the success check shows, then the sheet closes
  useEffect(() => {
    if (phase.kind !== "done") return;
    const timer = setTimeout(() => onCloseRef.current("paid"), SUCCESS_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [phase.kind]);

  // staging 2026-11-05: while paying (or waiting for the processor) the
  // run can end the wait: expired or canceled shows Start again, paid or
  // processing finishes. The run comes from the live feed (owner
  // 2026-11-07), the prop until it says anything. Adjusted during render.
  const liveRun = useLiveRunById(conversionId);
  const current = newerRun(run, liveRun);
  const watched = phase.kind === "paying" || phase.kind === "waiting" ? runPayOutcome(current) : null;
  if (watched === "expired") setPhase({ kind: "expired" });
  else if (watched === "paid") setPhase({ kind: "done", key: "pay.copy.paidStarting" });
  else if (watched === "waiting" && phase.kind === "paying") setPhase({ kind: "waiting" });

  // and a confirm that never answers goes back to the form after a minute
  // (anything the run said meanwhile has already ended the wait above)
  useEffect(() => {
    if (phase.kind !== "paying") return;
    const back: Phase = { kind: "ready", checkout: phase.checkout, publishableKey: phase.publishableKey };
    const timer = setTimeout(() => setPhase((p) => (p.kind === "paying" ? back : p)), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // the phase object changes only with its kind while paying
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  async function startAgain(): Promise<void> {
    setPhase({ kind: "loading" });
    try {
      const s = await gateway.payNowCheckout(conversionId, true);
      setPhase({ kind: "ready", checkout: s.checkout, publishableKey: s.publishable_key });
    } catch {
      setPhase({ kind: "unavailable" });
    }
  }

  function handle(result: ConfirmResult, checkout: CheckoutHandle, publishableKey?: string): void {
    if (result === "redirect") return; // the browser is leaving for /pay/return
    const next: Phase =
      result === "paid"
        ? { kind: "done", key: "pay.copy.paidStarting" }
        : result === "already_paid"
          ? { kind: "done", key: "pay.copy.alreadyPaid" }
          : result === "processing"
            ? { kind: "waiting" }
            : result === "expired"
              ? { kind: "expired" }
              : { kind: "ready", checkout, publishableKey, notice: result === "too_many" ? "too_many" : "declined" };
    // a late answer (after the run or the safety re-check moved on) only
    // counts when it settles the payment
    setPhase((p) =>
      p.kind === "paying" || (p.kind === "ready" && next.kind !== "ready") ? next : p,
    );
  }

  const confirmTitle = billing?.reason === "authentication" || billing?.reason === "declined";
  const title = confirmTitle
    ? t("pay.copy.confirmTitle")
    : t("pay.sheet.title", { action, amount: formatCents(amountCents, t) });
  const why =
    billing?.reason === "authentication"
      ? t("pay.copy.bankWants")
      : billing?.reason === "declined"
        ? declinedChoose(billing.declined_method_label ?? t("pay.copy.paymentMethod"), t)
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
        publishableKey={phase.publishableKey}
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
                  // owner 2026-11-07 (Option B): the local price while the
                  // gateway offers it, else "Charged in US dollars"
                  lines={[checkoutCurrencyLine(localPrice, t), t("pay.copy.withdrawal")]}
                  extra={alipay ? t("pay.copy.alipayLine") : undefined}
                  button={
                    elsewhereFirst ? (
                      <Button
                        size="lg"
                        data-testid="pay-other-device"
                        className="h-14 w-full text-xl"
                        onClick={() => setHandoff(true)}
                      >
                        {t("pay.sheet.payOtherDevice")}
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
                        const key = phase.publishableKey;
                        setPhase({ kind: "paying", checkout, publishableKey: key });
                        handle(await form.confirm(), checkout, key);
                      }}
                    >
                      {locked ? (
                        <>
                          <Spinner /> {t("pay.copy.paying")}
                        </>
                      ) : alipay ? (
                        t("pay.sheet.continueAlipay")
                      ) : (
                        <>
                          <LockIcon className="size-4" aria-hidden />
                          {payAndStart(amountCents, t)}
                        </>
                      )}
                    </Button>
                    )
                  }
                  foot={t("pay.copy.refundedIfFails")}
                  after={
                    elsewhereFirst ? (
                      <button
                        type="button"
                        data-testid="pay-here-instead"
                        onClick={form.openCards}
                        className="w-full py-3 text-center text-xl text-primary hover:underline"
                      >
                        {t("pay.sheet.payHereInstead")}
                      </button>
                    ) : big ? (
                      <button
                        type="button"
                        data-testid="pay-other-device"
                        disabled={locked}
                        onClick={() => setHandoff(true)}
                        className="w-full py-3 text-center text-xl text-primary hover:underline"
                      >
                        {t("pay.sheet.payOtherDevice")}
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
                    {t("pay.copy.tooMany")}
                  </p>
                ) : null}
                {formBody}
                {note ? (
                  <p data-testid="pay-note" className="text-xs text-fg-muted">
                    {note}
                  </p>
                ) : null}
                {notice === "declined" ? (
                  <p data-testid="pay-error" className="text-sm text-red-400">
                    {form.message ?? t("pay.copy.declined")}
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
    body = <StateLine testId="pay-waiting" text={t("pay.copy.waitingConfirm")} />;
  } else if (phase.kind === "done") {
    body = <Success text={t(phase.key)} />;
  } else if (phase.kind === "expired") {
    body = <StateLine testId="pay-expired" text={t("pay.copy.expiredRun")} />;
    footer = (
      <Button size="lg" className="h-12 w-full" onClick={() => void startAgain()}>
        {t("pay.sheet.startAgain")}
      </Button>
    );
  } else {
    body = <StateLine testId="pay-unavailable" text={t("pay.copy.unavailable")} />;
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
