"use client";

/**
 * P6 China mode sheet and P5 WeChat Pay QR (spec v6 B7/G2): no payment
 * form script at all; Alipay and WeChat Pay through the gateway
 * (POST /v1/conversions/{id}/pay-now {method}).
 *
 * - Computer: Alipay · WeChat Pay → Alipay's page (then P4) or the QR (P5).
 * - Phone: Alipay as the main button; WeChat needs a computer, so "Pay on
 *   another device" (P7) with the line saying so.
 * - Headset: Alipay · Pay on another device.
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/lib/api/useGateway";

import { HandoffSheet } from "./HandoffSheet";
import { MainButtonArea, StateLine, Success, SUCCESS_CLOSE_MS } from "./PaySheet";
import { CHARGED_IN_USD, REFUNDED_IF_FAILS, UNAVAILABLE, WAITING_FOR_PAYMENT, WITHDRAWAL_LINE } from "./payCopy";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

/** Injectable for tests (jsdom cannot navigate). */
let navigate = (url: string) => window.location.assign(url);
export function setChinaNavigateForTests(fn: (url: string) => void): void {
  navigate = fn;
}

const POLL_MS = 2000;

export function ChinaPaySheet({
  conversionId,
  projectId,
  amountCents,
  subtitle,
  onClose,
}: {
  conversionId: string;
  projectId?: string;
  amountCents: number;
  subtitle?: string;
  onClose: (paid: boolean) => void;
}): JSX.Element {
  const gateway = useGateway();
  const frame = useSheetFrame();
  const big = frame === "headset";
  const [phase, setPhase] = useState<
    | { kind: "choose"; busy?: "alipay" | "wechat_pay" }
    | { kind: "qr"; qr: string; expires: string }
    | { kind: "paid" }
    | { kind: "expired" }
    | { kind: "unavailable" }
    | { kind: "handoff" }
  >({ kind: "choose" });

  async function pay(method: "alipay" | "wechat_pay"): Promise<void> {
    setPhase({ kind: "choose", busy: method });
    try {
      const back = `${window.location.origin}/pay/return?conversion=${encodeURIComponent(conversionId)}${
        projectId ? `&project=${encodeURIComponent(projectId)}` : ""
      }`;
      const r = await gateway.startPayNow(conversionId, method, back);
      if (r.redirect_url) {
        navigate(r.redirect_url);
        return;
      }
      if (r.qr_image_url) {
        setPhase({ kind: "qr", qr: r.qr_image_url, expires: r.expires_at ?? "" });
        return;
      }
      setPhase({ kind: "unavailable" });
    } catch {
      setPhase({ kind: "unavailable" });
    }
  }

  // P5: wait for the scan
  useEffect(() => {
    if (phase.kind !== "qr") return;
    const t = setInterval(() => {
      if (phase.expires && Date.parse(phase.expires) < Date.now()) {
        setPhase({ kind: "expired" });
        return;
      }
      gateway.getConversion(conversionId).then(
        (c) => {
          if (c.state !== "created") setPhase({ kind: "paid" });
        },
        () => {},
      );
    }, POLL_MS);
    return () => clearInterval(t);
  }, [gateway, conversionId, phase]);

  useEffect(() => {
    if (phase.kind !== "paid") return;
    const t = setTimeout(() => onClose(true), SUCCESS_CLOSE_MS);
    return () => clearTimeout(t);
  }, [phase.kind, onClose]);

  if (phase.kind === "handoff") {
    return (
      <HandoffSheet
        conversionId={conversionId}
        computerOnly={frame === "phone"}
        onPayHere={() => setPhase({ kind: "choose" })}
        onClose={onClose}
      />
    );
  }

  const title = `Pay for your 3D video`;
  const sub = subtitle;
  const textBtn = big ? "py-3 text-xl" : "text-sm";

  if (phase.kind === "qr") {
    return (
      <SheetFrame open onClose={() => onClose(false)} testId="china-sheet" title={title} subtitle={sub}>
        <div className="flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img data-testid="wechat-qr" src={phase.qr} alt="" className="size-[200px] rounded-lg bg-white p-3" />
          <p className="text-base text-fg tabular-nums">Scan with WeChat to pay {formatCents(amountCents)}</p>
          <p className="text-xs text-fg-muted">{CHARGED_IN_USD}</p>
          <p className="text-xs text-fg-muted">{REFUNDED_IF_FAILS}</p>
          <p className="flex items-center gap-2 text-sm text-fg">
            <span aria-hidden className="size-2 animate-pulse rounded-full bg-primary" />
            {WAITING_FOR_PAYMENT}
          </p>
        </div>
      </SheetFrame>
    );
  }
  if (phase.kind === "paid") {
    return (
      <SheetFrame open onClose={() => onClose(true)} testId="china-sheet" title={title}>
        <Success text="Paid." />
      </SheetFrame>
    );
  }
  if (phase.kind === "expired") {
    return (
      <SheetFrame
        open
        onClose={() => onClose(false)}
        testId="china-sheet"
        title={title}
        footer={
          <Button size="lg" className="h-12 w-full" onClick={() => setPhase({ kind: "choose" })}>
            Start again
          </Button>
        }
      >
        <StateLine text="The code expired." />
      </SheetFrame>
    );
  }

  const busy = phase.kind === "choose" ? phase.busy : undefined;
  const unavailable = phase.kind === "unavailable";
  const handoffButton = (line?: string) => (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        data-testid="pay-other-device"
        onClick={() => setPhase({ kind: "handoff" })}
        className={`text-primary hover:underline ${textBtn}`}
      >
        Pay on another device
      </button>
      {line ? <span className="text-xs text-fg-muted">{line}</span> : null}
    </div>
  );
  const alipay = (
    <Button
      size="lg"
      data-testid="china-alipay"
      className={`w-full ${big ? "h-14 text-xl" : "h-12 text-base"}`}
      disabled={busy !== undefined}
      onClick={() => void pay("alipay")}
    >
      {busy === "alipay" ? "Opening…" : "Alipay"}
    </Button>
  );
  return (
    <SheetFrame
      open
      onClose={() => onClose(false)}
      testId="china-sheet"
      title={title}
      subtitle={sub}
      footer={
        unavailable ? (
          handoffButton()
        ) : (
          <MainButtonArea
            big={big}
            lines={[CHARGED_IN_USD, WITHDRAWAL_LINE]}
            button={
              <div className="flex flex-col gap-2">
                {alipay}
                {frame === "desktop" ? (
                  <Button
                    size="lg"
                    variant="outline"
                    data-testid="china-wechat"
                    className="h-12 w-full text-base"
                    disabled={busy !== undefined}
                    onClick={() => void pay("wechat_pay")}
                  >
                    {busy === "wechat_pay" ? "Opening…" : "WeChat Pay"}
                  </Button>
                ) : frame === "phone" ? (
                  handoffButton("To pay with WeChat, use a computer.")
                ) : (
                  handoffButton("Pay with WeChat on a computer")
                )}
              </div>
            }
            foot={REFUNDED_IF_FAILS}
          />
        )
      }
    >
      {unavailable ? <StateLine testId="pay-unavailable" text={UNAVAILABLE} /> : null}
    </SheetFrame>
  );
}
