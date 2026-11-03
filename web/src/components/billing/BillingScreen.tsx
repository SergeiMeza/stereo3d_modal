"use client";

/**
 * Billing (S3D-57), from the account menu: the payment method (card,
 * expiry, Update card through the existing card flow) and the purchase
 * history — one row per card charge as on the statement, with date,
 * amount, card, Paid / Refunded / Failed and the Stripe receipt; a row
 * expands to what it covered. Compact (S3D-45); no balance or limit
 * wording anywhere (S3D-21).
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { openCardUpdate } from "@/components/billing/BillingBanner";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { BillingCharge, BillingChargeItem } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";
import { qualityName } from "@/lib/glossary";

const STATUS: Record<BillingCharge["status"], { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "text-emerald-300" },
  refunded: { label: "Refunded", cls: "text-fg-muted" },
  failed: { label: "Failed", cls: "text-red-300" },
};

function brandName(brand: string): string {
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Kyoto walk · 3D video · 4K" */
export function itemLine(i: BillingChargeItem): string {
  return [
    i.project_name ?? "Untitled project",
    i.step === "production" ? "3D video" : "Preview",
    i.preset ? qualityName(i.preset) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function UpdateCardButton({ label = "Update card" }: { label?: string }): JSX.Element {
  const gateway = useGateway();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const err = await openCardUpdate(gateway);
          if (err !== null) {
            setError(err);
            setBusy(false);
          }
        }}
      >
        {label}
      </Button>
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </span>
  );
}

function ChargeRow({ charge }: { charge: BillingCharge }): JSX.Element {
  const [open, setOpen] = useState(false);
  const s = STATUS[charge.status];
  const single = charge.items.length === 1;
  const amount =
    charge.status === "refunded" ? `−${formatCents(charge.amount_cents)}` : formatCents(charge.amount_cents);
  return (
    <li data-testid={`charge-${charge.charge_id}`} className="border-t border-edge">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span aria-hidden className={`text-fg-muted transition-transform ${open ? "rotate-90" : ""}`}>
            ›
          </span>
          <span className="w-14 shrink-0 text-fg-muted">{shortDate(charge.created_at)}</span>
          <span className="min-w-0 truncate text-fg">
            {single ? itemLine(charge.items[0]) : `${charge.items.length} items`}
          </span>
        </button>
        <span data-testid="charge-amount" className="font-mono text-fg">
          {amount}
        </span>
        {charge.card ? (
          <span className="text-xs text-fg-muted">
            {brandName(charge.card.brand)} •••• {charge.card.last4}
          </span>
        ) : null}
        <span data-testid="charge-status" className={`w-16 text-xs ${s.cls}`}>
          {s.label}
        </span>
        {charge.status === "failed" ? (
          <UpdateCardButton />
        ) : charge.receipt_url ? (
          <a
            href={charge.receipt_url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary hover:underline"
          >
            Receipt
          </a>
        ) : null}
      </div>
      {open ? (
        <ul data-testid="charge-items" className="flex flex-col gap-1 pb-3 pl-8 text-xs">
          {charge.items.map((i) => (
            <li key={i.conversion_id} className="flex items-center gap-3">
              <Link
                href={`/projects/${i.project_id}#tab=files`}
                className="min-w-0 flex-1 truncate text-fg-muted hover:text-fg"
              >
                {itemLine(i)}
              </Link>
              <span className="font-mono text-fg-muted">{formatCents(i.amount_cents)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function BillingScreen(): JSX.Element {
  const gateway = useGateway();
  const billing = useBilling();
  const card = billing.status?.card;
  const [charges, setCharges] = useState<BillingCharge[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    gateway.getBillingHistory().then(
      (h) => {
        if (!cancelled) setCharges(h.charges);
      },
      () => {
        if (!cancelled) setError("Couldn't load your purchase history. Please try again.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>

      <section
        aria-labelledby="payment-method"
        className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-5"
      >
        <h2 id="payment-method" className="text-sm font-semibold text-fg">
          Payment method
        </h2>
        {card ? (
          <div className="flex flex-wrap items-center gap-4">
            <span data-testid="billing-card" className="text-sm text-fg">
              {brandName(card.brand)} •••• {card.last4}
              <span className="ml-3 text-xs text-fg-muted">
                Expires {String(card.exp_month).padStart(2, "0")}/
                {String(card.exp_year).slice(-2)}
              </span>
            </span>
            <span className="ml-auto">
              <UpdateCardButton />
            </span>
          </div>
        ) : billing.status !== null && !billing.status.has_payment_method ? (
          <p className="text-sm text-fg-muted">
            No card saved yet.{" "}
            <Link href="/onboarding" className="text-primary hover:underline">
              Add a card
            </Link>
          </p>
        ) : (
          <p className="text-sm text-fg-muted">Loading…</p>
        )}
      </section>

      <section
        aria-labelledby="purchase-history"
        className="flex flex-col rounded-xl border border-edge bg-surface-1 p-5"
      >
        <div className="flex items-baseline gap-3 pb-2">
          <h2 id="purchase-history" className="text-sm font-semibold text-fg">
            Purchase history
          </h2>
          <span className="text-xs text-fg-muted">Card charges, newest first</span>
        </div>
        {error ? (
          <p className="text-sm text-red-400">{error}</p>
        ) : charges === null ? (
          <p className="text-sm text-fg-muted">Loading…</p>
        ) : charges.length === 0 ? (
          <p className="text-sm text-fg-muted">No charges yet.</p>
        ) : (
          <ul data-testid="charges">
            {charges.map((c) => (
              <ChargeRow key={c.charge_id} charge={c} />
            ))}
          </ul>
        )}
        <p className="pt-3 text-xs text-fg-muted">
          US dollars. Receipts include tax where it applies.
        </p>
      </section>
    </section>
  );
}
