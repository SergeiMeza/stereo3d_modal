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
 *
 * Back from a payment that left the page (`?done=1`, Stripe adds
 * `redirect_status`), or a payment the form reports as processing, the
 * page reads "Processing…" and polls the GET until the link closes, with
 * no Pay button: the webhook may not have closed it yet (REV-06).
 * `redirect_status=failed` shows the decline beside Pay.
 */

import { useEffect, useRef, useState } from "react";
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

/** How often a processing payment is read again: every 3 s for the
 * first 2 minutes, then every 15 s with "being confirmed" (tests shorten
 * them). */
let poll = { fastMs: 3_000, slowAfterMs: 120_000, slowMs: 15_000 };
export function setPayRequestPollForTests(p: Partial<typeof poll>): void {
  poll = { fastMs: 3_000, slowAfterMs: 120_000, slowMs: 15_000, ...p };
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; info: PayRequest; opening?: boolean; notice?: string }
  | { kind: "form"; info: PayRequest; secret: string; publishableKey?: string; paying?: boolean; notice?: string }
  | { kind: "processing"; slow?: boolean }
  | { kind: "paid" }
  | { kind: "void" }
  | { kind: "expired" }
  | { kind: "bad" }
  | { kind: "loadFailed" }
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

  // REV-12: a failed read can be tried again (a deploy, the network)
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams(window.location.search);
    // Stripe: succeeded | processing | failed; a hosted page's cancel adds canceled=1
    const redirect = q.get("redirect_status");
    const returned = q.get("done") === "1" && q.get("canceled") !== "1" && redirect !== "failed";
    gateway.getPayRequest(token).then(
      (info) => {
        if (!live) return;
        const shut = closed(info);
        if (shut) return setState(shut);
        if (returned) return setState({ kind: "processing" });
        setState({ kind: "ready", info, ...(redirect === "failed" ? { notice: "pay.copy.declined" } : {}) });
      },
      (e: unknown) => {
        if (!live) return;
        const g = e instanceof GatewayError ? e : null;
        if (g?.status === 429) return setState({ kind: "limited" });
        // only an unknown link isn't valid; anything else can be tried again
        if (g?.status === 404 && g.code === "pay_link_not_found") return setState({ kind: "bad" });
        setState({ kind: "loadFailed" });
      },
    );
    return () => {
      live = false;
    };
  }, [gateway, token, attempt]);

  // REV-06: a payment being confirmed is read again until the link closes
  const processing = state.kind === "processing";
  const since = useRef(0);
  useEffect(() => {
    if (!processing) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    since.current = Date.now();
    const next = () => {
      const slow = Date.now() - since.current >= poll.slowAfterMs;
      if (slow) setState((s) => (s.kind === "processing" && !s.slow ? { kind: "processing", slow: true } : s));
      timer = setTimeout(check, slow ? poll.slowMs : poll.fastMs);
    };
    const check = () => {
      gateway.getPayRequest(token).then(
        (info) => {
          if (!live) return;
          const shut = closed(info);
          if (shut) return setState(shut);
          next();
        },
        () => live && next(),
      );
    };
    next();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [processing, gateway, token]);

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
    if (r === "paid" || r === "already_paid") return setState({ kind: "paid" });
    // not paid yet: the bank or the method still has to confirm it
    if (r === "processing") return setState({ kind: "processing" });
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
      ) : state.kind === "processing" ? (
        <div data-testid="pay-request-processing" className="flex flex-col gap-2">
          <p className="text-base font-medium text-fg">{t("pay.request.processing")}</p>
          {state.slow ? <p className="text-sm text-fg-muted">{t("pay.request.confirming")}</p> : null}
        </div>
      ) : state.kind === "paid" ? (
        <Success text={t("pay.request.paid")} />
      ) : state.kind === "void" ? (
        <p className="text-base text-fg">{t("pay.request.void")}</p>
      ) : state.kind === "expired" ? (
        <p className="text-base text-fg">{t("pay.request.expired")}</p>
      ) : state.kind === "bad" ? (
        <p className="text-base text-fg">{t("pay.request.bad")}</p>
      ) : state.kind === "loadFailed" ? (
        <div data-testid="pay-request-load-failed" className="flex flex-col items-start gap-3">
          <p className="text-base text-fg">{t("pay.request.loadFailed")}</p>
          <Button
            variant="outline"
            data-testid="pay-request-retry"
            onClick={() => {
              setState({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            {t("pay.request.tryAgain")}
          </Button>
        </div>
      ) : state.kind === "limited" ? (
        <p className="text-base text-fg">{t("pay.handoffPage.limited")}</p>
      ) : state.kind === "form" ? (
        <CheckoutPane
          clientSecret={state.secret}
          publishableKey={state.publishableKey}
          showSaveLine={false}
          // BUX-03: a wallet pays through the same paying → result path
          onWallet={(result) => {
            const s = state;
            setState({ ...s, paying: true, notice: undefined });
            void result.then((r) => confirmed(r, s));
          }}
        >
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
