"use client";

/**
 * D7 pay page (`/pay/{token}`, owner 2026-11-07): the link in a failed
 * payment's mail. Public (works signed out): GET /v1/pay-requests/{token}
 * says what it is and how much (404 pay_link_not_found: not valid); Pay
 * asks POST …/checkout {ui: elements, return_url} for one of
 *
 * - our payment form (CheckoutPane, Adaptive Pricing as everywhere; the
 *   form itself asks the bank when it must). A step-up takes today's
 *   amount this way, then the gateway applies the change;
 * - a renewal's hosted invoice page: the browser goes there;
 * - already paid.
 *
 * 409 pay_link_closed {state} shows that state; 409 payment_in_progress
 * says a payment is already going; 429 is too many tries. It pays the
 * amount the gateway names, and never shows an email.
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { AppIcon } from "@/components/AppIcon";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { GatewayError } from "@/lib/api/client";
import type { PayRequest } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useLocalPriceAtCheckout } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";
import { SITE_NAME } from "@/lib/site";

import { CheckoutPane, type ConfirmResult } from "./CheckoutPane";
import { checkoutCurrencyLine, sheetCurrencyLine } from "./payCopy";
import { StateLine, Success } from "./PaySheet";

/** Injectable for tests (jsdom cannot navigate). */
let navigate = (url: string) => window.location.assign(url);
export function setPayRequestNavigateForTests(fn: (url: string) => void): void {
  navigate = fn;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; info: PayRequest; opening?: boolean; notice?: string }
  | { kind: "form"; info: PayRequest; secret: string; publishableKey?: string; paying?: boolean; notice?: string }
  | { kind: "paid" }
  | { kind: "void" }
  | { kind: "expired" }
  | { kind: "bad" }
  | { kind: "limited" };

function closed(info: PayRequest): State | null {
  if (info.state === "paid") return { kind: "paid" };
  if (info.state === "void") return { kind: "void" };
  if (info.state === "expired") return { kind: "expired" };
  return null;
}

export function PayRequestPage({ token }: { token: string }): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const localPrice = useLocalPriceAtCheckout();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    gateway.getPayRequest(token).then(
      (info) => live && setState(closed(info) ?? { kind: "ready", info }),
      (e: unknown) => {
        if (!live) return;
        setState(e instanceof GatewayError && e.status === 429 ? { kind: "limited" } : { kind: "bad" });
      },
    );
    return () => {
      live = false;
    };
  }, [gateway, token]);

  async function pay(info: PayRequest): Promise<void> {
    setState({ kind: "ready", info, opening: true });
    try {
      const r = await gateway.startPayRequest(token);
      if (r.state === "paid") return setState({ kind: "paid" });
      // the amount the gateway takes now (a step-up's today's amount)
      const now = typeof r.amount_cents === "number" ? { ...info, amount_cents: r.amount_cents } : info;
      if (r.checkout) {
        setState({
          kind: "form",
          info: now,
          secret: r.checkout.client_secret,
          publishableKey: r.publishable_key ?? process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
        });
        return;
      }
      if (r.url) return navigate(r.url);
      setState({ kind: "ready", info, notice: "pay.copy.unavailable" });
    } catch (e) {
      const g = e instanceof GatewayError ? e : null;
      if (g?.code === "pay_link_closed") {
        const closedAs = typeof g.details?.state === "string" ? g.details.state : "";
        const shut = closed({ ...info, state: closedAs as PayRequest["state"] });
        return setState(shut ?? { kind: "expired" });
      }
      if (g?.code === "payment_in_progress") return setState({ kind: "ready", info, notice: "pay.request.inProgress" });
      if (g?.status === 429) return setState({ kind: "ready", info, notice: "pay.handoffPage.limited" });
      setState({ kind: "ready", info, notice: "pay.copy.unavailable" });
    }
  }

  function confirmed(r: ConfirmResult, s: Extract<State, { kind: "form" }>): void {
    if (r === "paid" || r === "already_paid" || r === "processing") return setState({ kind: "paid" });
    if (r === "expired") return setState({ kind: "expired" });
    if (r === "redirect") return;
    setState({ ...s, paying: false, notice: r === "too_many" ? "pay.copy.tooMany" : "pay.copy.declined" });
  }

  const amount = (info: PayRequest) => formatCents(info.amount_cents, t);
  const head = (info: PayRequest) => (
    <div className="flex flex-col gap-1">
      <p data-testid="pay-request-label" className="text-sm text-fg-muted">
        {info.label}
      </p>
      <p data-testid="pay-request-amount" className="text-4xl font-semibold text-fg tabular-nums">
        {amount(info)}
      </p>
    </div>
  );

  return (
    <section
      data-testid="pay-request-page"
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
        <Success text={t("pay.request.paid")} />
      ) : state.kind === "void" ? (
        <p className="text-base text-fg">{t("pay.request.void")}</p>
      ) : state.kind === "expired" ? (
        <p className="text-base text-fg">{t("pay.request.expired")}</p>
      ) : state.kind === "bad" ? (
        <p className="text-base text-fg">{t("pay.request.bad")}</p>
      ) : state.kind === "limited" ? (
        <p className="text-base text-fg">{t("pay.handoffPage.limited")}</p>
      ) : state.kind === "form" ? (
        <CheckoutPane clientSecret={state.secret} publishableKey={state.publishableKey} showSaveLine={false}>
          {(form, body) => (
            <div className="flex flex-col gap-4">
              {head(state.info)}
              {body}
              {state.notice ? <StateLine testId="pay-request-notice" text={t(state.notice)} /> : null}
              {form.message ? <StateLine text={form.message} /> : null}
              <p className="text-xs text-fg-muted">{sheetCurrencyLine(localPrice, state.info.amount_cents, t)}</p>
              <Button
                size="lg"
                data-testid="pay-request-confirm"
                className="h-12 w-full tabular-nums"
                disabled={!form.ready || state.paying === true}
                onClick={async () => {
                  setState({ ...state, paying: true, notice: undefined });
                  confirmed(await form.confirm(), state);
                }}
              >
                {state.paying ? t("pay.copy.paying") : t("pay.request.pay", { amount: amount(state.info) })}
              </Button>
            </div>
          )}
        </CheckoutPane>
      ) : (
        <>
          {head(state.info)}
          {state.notice ? <StateLine testId="pay-request-notice" text={t(state.notice)} /> : null}
          <p className="text-xs text-fg-muted">{checkoutCurrencyLine(localPrice, t)}</p>
          <Button
            size="lg"
            data-testid="pay-request-pay"
            className="sticky bottom-4 h-12 w-full tabular-nums"
            disabled={state.opening === true}
            onClick={() => void pay(state.info)}
          >
            {state.opening ? t("pay.handoffPage.opening") : t("pay.request.pay", { amount: amount(state.info) })}
          </Button>
        </>
      )}
    </section>
  );
}
