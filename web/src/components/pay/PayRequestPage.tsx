"use client";

/**
 * D7 pay page (`/pay/{token}`, owner 2026-11-07): the link in a failed
 * payment's mail. Public (works signed out): GET /v1/pay-requests/{token}
 * says what it is and how much; Pay asks POST …/checkout for one of
 *
 * - our payment form (CheckoutPane, Adaptive Pricing as everywhere);
 * - the hosted invoice page (invoices): the browser goes there;
 * - a step-up's bank confirmation (3DS): confirmed here, or on the hosted
 *   invoice page when the bank doesn't confirm.
 *
 * It pays that exact amount, and never shows an email.
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { AppIcon } from "@/components/AppIcon";
import { completeChargeAction } from "@/components/billing/settleAction";
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
  | { kind: "bank"; info: PayRequest }
  /** the bank didn't confirm: the hosted invoice page can */
  | { kind: "bankFailed"; info: PayRequest; invoiceUrl?: string }
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
      if (r.checkout) {
        setState({ kind: "form", info, secret: r.checkout.client_secret, publishableKey: r.publishable_key });
        return;
      }
      if (r.url) return navigate(r.url);
      if (r.state === "requires_action" && r.client_secret) {
        setState({ kind: "bank", info });
        const key = r.publishable_key ?? process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
        const done = await completeChargeAction(key, r.client_secret);
        setState(done.ok ? { kind: "paid" } : { kind: "bankFailed", info, invoiceUrl: r.hosted_invoice_url });
        return;
      }
      setState({ kind: "ready", info, notice: "pay.copy.unavailable" });
    } catch (e) {
      const code = e instanceof GatewayError ? e.code : "";
      if (code === "already_paid") return setState({ kind: "paid" });
      if (code === "expired") return setState({ kind: "expired" });
      if (code === "void") return setState({ kind: "void" });
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
      ) : state.kind === "bank" ? (
        <>
          {head(state.info)}
          <StateLine testId="pay-request-bank" text={t("pay.request.confirmWithBank")} />
        </>
      ) : state.kind === "bankFailed" ? (
        <>
          {head(state.info)}
          <StateLine testId="pay-request-bank-failed" text={t("pay.request.bankDidntConfirm")} />
          {state.invoiceUrl ? (
            <Button asChild size="lg" className="h-12 w-full">
              <a data-testid="pay-request-invoice" href={state.invoiceUrl} target="_blank" rel="noreferrer">
                {t("pay.request.payOnInvoice")}
              </a>
            </Button>
          ) : null}
        </>
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
          <p className="text-xs text-fg-muted">
            {state.info.kind === "stepup" || state.info.kind === "invoice"
              ? t("pay.copy.chargedInUsd")
              : checkoutCurrencyLine(localPrice, t)}
          </p>
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
