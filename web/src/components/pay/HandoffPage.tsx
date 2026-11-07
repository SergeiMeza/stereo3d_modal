"use client";

/**
 * P8 Hand-off page (`/p/{code}`, spec v6 B17/G2), on the phone or computer
 * a headset sent here. Public and read-only until the button: GET
 * /v1/handoff/{code} says what it pays for; Continue to payment (or, in
 * China, Alipay and WeChat Pay on computers) goes through POST
 * /v1/handoff/{code}/pay. Coming back (?back=1) checks the result.
 */

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { AppIcon } from "@/components/AppIcon";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { GatewayError } from "@/lib/api/client";
import type { HandoffInfo } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useT } from "@/lib/i18n/I18nProvider";
import { SITE_NAME } from "@/lib/site";

import { Success } from "./PaySheet";
import { useSheetFrame } from "./SheetFrame";

/** Injectable for tests (jsdom cannot navigate). */
let navigate = (url: string) => window.location.assign(url);
export function setHandoffNavigateForTests(fn: (url: string) => void): void {
  navigate = fn;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; info: HandoffInfo; opening?: boolean; notFinished?: boolean }
  | { kind: "confirming"; info: HandoffInfo }
  | { kind: "qr"; info: HandoffInfo; qr: string }
  | { kind: "paid" }
  | { kind: "already" }
  | { kind: "expired" }
  | { kind: "bad" }
  | { kind: "limited" };

export function HandoffPage({ code }: { code: string }): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const back = useSearchParams().get("back") === "1";
  const phone = useSheetFrame() === "phone";
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    let tries = 0;
    const read = async (): Promise<void> => {
      try {
        const info = await gateway.getHandoff(code);
        if (!live) return;
        if (info.state === "paid") return setState(back ? { kind: "paid" } : { kind: "already" });
        if (info.state === "expired") return setState({ kind: "expired" });
        if (back && tries < 5) {
          tries += 1;
          setState({ kind: "confirming", info });
          setTimeout(() => void read(), 2000);
          return;
        }
        setState({ kind: "ready", info, notFinished: back });
      } catch (e) {
        if (!live) return;
        setState(
          e instanceof GatewayError && e.status === 429 ? { kind: "limited" } : { kind: "bad" },
        );
      }
    };
    void read();
    return () => {
      live = false;
    };
  }, [gateway, code, back]);

  async function pay(info: HandoffInfo, method?: "alipay" | "wechat_pay"): Promise<void> {
    setState({ kind: "ready", info, opening: true });
    try {
      const r = await gateway.payHandoff(code, method);
      if (r.qr_image_url) return setState({ kind: "qr", info, qr: r.qr_image_url });
      const url = r.url ?? r.redirect_url;
      if (url) return navigate(url);
      setState({ kind: "ready", info });
    } catch (e) {
      if (e instanceof GatewayError && e.code === "already_paid") return setState({ kind: "already" });
      if (e instanceof GatewayError && e.code === "expired") return setState({ kind: "expired" });
      setState({ kind: "ready", info, notFinished: true });
    }
  }

  return (
    <section
      data-testid="handoff-page"
      data-state={state.kind}
      className="mx-auto flex w-full max-w-[440px] flex-1 flex-col gap-5 px-4 py-12"
    >
      <p className="flex items-center gap-2 text-sm font-semibold tracking-tight text-fg">
        <AppIcon className="size-5" />
        {SITE_NAME}
      </p>
      {state.kind === "loading" ? (
        <div className="h-48 animate-pulse rounded-xl bg-surface-2" />
      ) : state.kind === "paid" ? (
        <Success text={t("pay.handoffPage.paid")} />
      ) : state.kind === "already" ? (
        <p className="text-base text-fg">{t("pay.copy.alreadyPaid")}</p>
      ) : state.kind === "expired" ? (
        <p className="text-base text-fg">{t("pay.handoffPage.expired")}</p>
      ) : state.kind === "bad" ? (
        <p className="text-base text-fg">{t("pay.handoffPage.bad")}</p>
      ) : state.kind === "limited" ? (
        <p className="text-base text-fg">{t("pay.handoffPage.limited")}</p>
      ) : state.kind === "confirming" ? (
        <p className="text-base text-fg">{t("pay.copy.confirming")}</p>
      ) : state.kind === "qr" ? (
        <div className="flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img data-testid="wechat-qr" src={state.qr} alt="" className="size-[200px] rounded-lg bg-white p-3" />
          <p className="text-base text-fg tabular-nums">
            {t("pay.china.scanWechat", { amount: formatCents(state.info.amount_cents, t) })}
          </p>
          <p className="text-xs text-fg-muted">{t("pay.copy.chargedInUsd")}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-sm text-fg-muted">{state.info.label}</p>
            <p data-testid="handoff-amount" className="text-4xl font-semibold text-fg tabular-nums">
              {formatCents(state.info.amount_cents, t)}
            </p>
            <p className="text-xs text-fg-muted">{t("pay.copy.refundedIfFails")}</p>
          </div>
          <ul className="flex flex-col gap-1 rounded-lg border border-edge/70 px-3 py-2 text-xs text-fg-muted">
            <li>{t("pay.copy.chargedInUsd")}</li>
            <li>{t("pay.copy.withdrawal")}</li>
          </ul>
          {state.info.email_masked ? (
            <p className="text-xs text-fg-muted">{t("pay.handoffPage.forEmail", { email: state.info.email_masked })}</p>
          ) : null}
          {state.notFinished ? <p className="text-sm text-fg">{t("pay.handoffPage.notFinished")}</p> : null}
          <div className="sticky bottom-4 flex flex-col gap-2">
            {state.info.china ? (
              <>
                <Button size="lg" className="h-12 w-full" disabled={state.opening} onClick={() => void pay(state.info, "alipay")}>
                  {state.opening ? t("pay.handoffPage.opening") : "Alipay"}
                </Button>
                {!phone ? (
                  <Button size="lg" variant="outline" className="h-12 w-full" disabled={state.opening} onClick={() => void pay(state.info, "wechat_pay")}>
                    WeChat Pay
                  </Button>
                ) : null}
              </>
            ) : (
              <Button
                size="lg"
                data-testid="handoff-continue"
                className="h-12 w-full"
                disabled={state.opening}
                onClick={() => void pay(state.info)}
              >
                {state.opening ? t("pay.handoffPage.opening") : t("pay.handoffPage.continue")}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
