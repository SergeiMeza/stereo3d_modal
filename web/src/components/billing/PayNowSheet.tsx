"use client";

/**
 * Paying one run when it starts (S3D-60/61): a pay-now default method
 * (Alipay, WeChat Pay) makes the gateway park the run at "created" with a
 * payment to complete. This small sheet completes it.
 *
 * - Outside China mode: the Payment Element on the run's payment.
 * - China mode: no Payment Element script at all. Alipay and WeChat Pay
 *   through the gateway: Alipay sends the browser to its page and back to
 *   /pay/return; WeChat Pay shows the QR code, "Scan with WeChat to pay
 *   $X", and polls until the run is paid or the code expires (30 min).
 * - If the payment form can't load, one plain sentence; never why.
 *
 * Copy never names the processor, relays or routing.
 */

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { Stripe } from "@stripe/stripe-js";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Conversion, PayNowStart } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { chinaPayments } from "@/lib/paymentRegion";

import { defaultBillingSetup } from "./PaymentSetup";
import { getStripe } from "./stripeLoader";

export const PAID_NOW = "Paid now. Refunded in full if it fails.";
export const PAYMENT_UNAVAILABLE = "Payment isn't available in this region yet.";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const POLL_MS = 3000;

/** Where Alipay brings the browser back to. */
export function payReturnUrl(conv: Conversion): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const q = new URLSearchParams({ conversion: conv.conversion_id });
  if (conv.project_id) q.set("project", conv.project_id);
  return `${origin}/pay/return?${q.toString()}`;
}

function ElementForm({ conv, onPaid }: { conv: Conversion; onPaid: () => void }): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pay(): Promise<void> {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    const r = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: { return_url: payReturnUrl(conv) },
    });
    if (r.error) {
      setError(r.error.message ?? "The payment didn't go through.");
      setBusy(false);
      return;
    }
    onPaid();
  }
  return (
    <div className="flex flex-col gap-3">
      <PaymentElement onReady={() => setReady(true)} />
      <Button onClick={() => void pay()} disabled={!stripe || !ready || busy}>
        {busy ? "Paying…" : `Pay ${formatCents(conv.quote.amount_cents)}`}
      </Button>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </div>
  );
}

function ElementPay({ conv, onPaid }: { conv: Conversion; onPaid: () => void }): JSX.Element {
  const key = conv.billing?.publishable_key;
  // loadStripe once per key (stripeLoader caches); a failed load — e.g.
  // where the script is blocked — reads as one plain sentence
  const [stripe] = useState<Promise<Stripe | null> | null>(() => (key ? getStripe(key) : null));
  const [failed, setFailed] = useState(!key);
  useEffect(() => {
    if (!stripe) return;
    let cancelled = false;
    stripe.then(
      (s) => {
        if (!cancelled && s === null) setFailed(true);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [stripe]);
  if (failed) return <p className="text-sm text-fg-muted">{PAYMENT_UNAVAILABLE}</p>;
  if (!stripe || !conv.billing?.client_secret) {
    return <p className="text-sm text-fg-muted">Loading…</p>;
  }
  return (
    <Elements stripe={stripe} options={{ clientSecret: conv.billing.client_secret }}>
      <ElementForm conv={conv} onPaid={onPaid} />
    </Elements>
  );
}

/** Test mode: one button that completes the mock payment. */
function MockPay({ conv, onPaid }: { conv: Conversion; onPaid: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      data-testid="mock-pay-now"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch(`${GATEWAY}/__mock__/complete-payment/${conv.conversion_id}`, {
          method: "POST",
        });
        onPaid();
      }}
    >
      Pay {formatCents(conv.quote.amount_cents)} (test mode)
    </Button>
  );
}

/** China mode: Alipay or WeChat Pay through the gateway. */
function LocalPay({ conv, onPaid }: { conv: Conversion; onPaid: () => void }): JSX.Element {
  const gateway = useGateway();
  const [wechat, setWechat] = useState<PayNowStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  // WeChat Pay: poll the run until it is paid or the code expires
  useEffect(() => {
    if (!wechat) return;
    const until = wechat.expires_at ? Date.parse(wechat.expires_at) : Date.now() + 30 * 60 * 1000;
    const t = setInterval(() => {
      if (Date.now() > until) {
        setExpired(true);
        clearInterval(t);
        return;
      }
      gateway.getConversion(conv.conversion_id).then(
        (c) => {
          if (c.state !== "created") {
            clearInterval(t);
            onPaid();
          }
        },
        () => {},
      );
    }, POLL_MS);
    return () => clearInterval(t);
  }, [wechat, gateway, conv.conversion_id, onPaid]);

  async function start(method: "alipay" | "wechat_pay"): Promise<void> {
    setBusy(true);
    setError(null);
    setExpired(false);
    try {
      const r = await gateway.startPayNow(conv.conversion_id, method, payReturnUrl(conv));
      if (method === "alipay" && r.redirect_url) {
        window.location.assign(r.redirect_url);
        return;
      }
      setWechat(r);
    } catch {
      setError(PAYMENT_UNAVAILABLE);
    } finally {
      setBusy(false);
    }
  }

  if (wechat?.qr_image_url && !expired) {
    return (
      <div className="flex flex-col items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={wechat.qr_image_url}
          alt="WeChat Pay code"
          data-testid="wechat-qr"
          className="size-48 rounded-md bg-white p-2"
        />
        <p className="text-sm text-fg">
          Scan with WeChat to pay {formatCents(conv.quote.amount_cents)}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {expired ? (
        <p className="text-sm text-fg-muted">The code expired. Choose a way to pay again.</p>
      ) : null}
      <Button disabled={busy} onClick={() => void start("alipay")}>
        Alipay
      </Button>
      <Button variant="outline" disabled={busy} onClick={() => void start("wechat_pay")}>
        WeChat Pay
      </Button>
      {error ? <p className="text-xs text-fg-muted">{error}</p> : null}
    </div>
  );
}

export function PayNowSheet({
  conversion,
  onPaid,
  onCancel,
}: {
  conversion: Conversion;
  onPaid: () => void;
  onCancel: () => void;
}): JSX.Element {
  const china = chinaPayments();
  const mock = defaultBillingSetup().name === "mock";
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onCancel())}>
      <DialogContent data-testid="pay-now-sheet" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pay {formatCents(conversion.quote.amount_cents)} for this run</DialogTitle>
          <DialogDescription>{PAID_NOW}</DialogDescription>
        </DialogHeader>
        {china ? (
          <LocalPay conv={conversion} onPaid={onPaid} />
        ) : mock ? (
          <MockPay conv={conversion} onPaid={onPaid} />
        ) : (
          <ElementPay conv={conversion} onPaid={onPaid} />
        )}
      </DialogContent>
    </Dialog>
  );
}
