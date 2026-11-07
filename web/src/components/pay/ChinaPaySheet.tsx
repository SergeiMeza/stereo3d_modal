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
import { useLiveRunById } from "@/lib/live/useLive";
import { useT } from "@/lib/i18n/I18nProvider";

import { ChinaComingSoonSheet, isChinaPaymentsUnavailable } from "./chinaComingSoon";
import { HandoffSheet } from "./HandoffSheet";
import { MainButtonArea, StateLine, Success, SUCCESS_CLOSE_MS } from "./PaySheet";
import { SheetFrame, useSheetFrame } from "./SheetFrame";

/** Injectable for tests (jsdom cannot navigate). */
let navigate = (url: string) => window.location.assign(url);
export function setChinaNavigateForTests(fn: (url: string) => void): void {
  navigate = fn;
}


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
  const t = useT();
  const frame = useSheetFrame();
  const big = frame === "headset";
  const [phase, setPhase] = useState<
    | { kind: "choose"; busy?: "alipay" | "wechat_pay" }
    | { kind: "qr"; qr: string; expires: string }
    | { kind: "paid" }
    | { kind: "expired" }
    | { kind: "unavailable" }
    /** owner 2026-11-07: China payments are off (403 china_payments_unavailable) */
    | { kind: "soon" }
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
    } catch (e) {
      setPhase({ kind: isChinaPaymentsUnavailable(e) ? "soon" : "unavailable" });
    }
  }

  // P5: wait for the scan. The run leaves "created" once it's paid, as
  // the live feed says (owner 2026-11-07); the code expires on its own.
  const run = useLiveRunById(conversionId);
  if (phase.kind === "qr" && run?.state !== undefined && run.state !== "created") setPhase({ kind: "paid" });
  useEffect(() => {
    if (phase.kind !== "qr" || !phase.expires) return;
    const left = Date.parse(phase.expires) - Date.now();
    const timer = setTimeout(() => setPhase({ kind: "expired" }), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase.kind !== "paid") return;
    const timer = setTimeout(() => onClose(true), SUCCESS_CLOSE_MS);
    return () => clearTimeout(timer);
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

  const title = t("pay.china.title");
  const sub = subtitle;
  const textBtn = big ? "py-3 text-xl" : "text-sm";

  if (phase.kind === "soon") {
    return <ChinaComingSoonSheet testId="china-sheet" title={title} onClose={() => onClose(false)} />;
  }
  if (phase.kind === "qr") {
    return (
      <SheetFrame open onClose={() => onClose(false)} testId="china-sheet" title={title} subtitle={sub}>
        <div className="flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img data-testid="wechat-qr" src={phase.qr} alt="" className="size-[200px] rounded-lg bg-white p-3" />
          <p className="text-base text-fg tabular-nums">{t("pay.china.scanWechat", { amount: formatCents(amountCents, t) })}</p>
          <p className="text-xs text-fg-muted">{t("pay.copy.chargedInUsd")}</p>
          <p className="text-xs text-fg-muted">{t("pay.copy.refundedIfFails")}</p>
          <p className="flex items-center gap-2 text-sm text-fg">
            <span aria-hidden className="size-2 animate-pulse rounded-full bg-primary" />
            {t("pay.copy.waitingForPayment")}
          </p>
        </div>
      </SheetFrame>
    );
  }
  if (phase.kind === "paid") {
    return (
      <SheetFrame open onClose={() => onClose(true)} testId="china-sheet" title={title}>
        <Success text={t("pay.china.paid")} />
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
            {t("pay.china.startAgain")}
          </Button>
        }
      >
        <StateLine text={t("pay.china.codeExpired")} />
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
        {t("pay.china.payOtherDevice")}
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
      {busy === "alipay" ? t("pay.china.opening") : "Alipay"}
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
            lines={[t("pay.copy.chargedInUsd"), t("pay.copy.withdrawal")]}
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
                    {busy === "wechat_pay" ? t("pay.china.opening") : "WeChat Pay"}
                  </Button>
                ) : frame === "phone" ? (
                  handoffButton(t("pay.china.wechatPhone"))
                ) : (
                  handoffButton(t("pay.china.wechatHeadset"))
                )}
              </div>
            }
            foot={t("pay.copy.refundedIfFails")}
          />
        )
      }
    >
      {unavailable ? <StateLine testId="pay-unavailable" text={t("pay.copy.unavailable")} /> : null}
    </SheetFrame>
  );
}
