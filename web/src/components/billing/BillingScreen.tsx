"use client";

/**
 * Billing (P10, spec v6 G2; S3D-57/58/62), from the account menu.
 *
 * Methods: read-only rows oldest first with a Default tag, one button to
 * the portal ("Manage payment methods and company details ↗") and the
 * line saying how the default and the others are charged.
 *
 * History: one row per statement charge — Date · For · Amount · Paid with
 * · Status · Invoice ↗ · Receipt ↗ — with a "Payment needed" row while the
 * account owes (Pay $X opens the settle sheet), refund rows with their
 * credit note, a menu with "Get help with this payment", and 25 rows a
 * page with Show more.
 */

import { EllipsisIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import { openCardUpdate, supportMailto } from "@/components/billing/BillingBanner";
import { UNDER_REVIEW } from "@/components/pay/payCopy";
import { useSettle } from "@/components/pay/SettleSheet";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type {
  BillingCharge,
  BillingChargeItem,
  BillingHistory,
  BillingRow,
  BillingRowStatus,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { methodLabel, usePaymentMethods } from "@/lib/api/usePaymentMethods";
import { useBilling } from "@/lib/billing";
import { qualityName } from "@/lib/glossary";

const STATUS: Record<BillingRowStatus, { label: string; cls: string; help?: string }> = {
  paid: { label: "Paid", cls: "text-emerald-300" },
  processing: {
    label: "Processing",
    cls: "text-amber-300",
    help: "Your payment is being confirmed. This can take a few days.",
  },
  payment_needed: { label: "Payment needed", cls: "text-red-300" },
  refund_requested: {
    label: "Refund requested",
    cls: "text-fg",
    help: "We'll email you within 2 business days.",
  },
  refunded: { label: "Refunded", cls: "text-fg-muted" },
  partially_refunded: { label: "Partly refunded", cls: "text-fg-muted" },
  disputed: { label: "Disputed with your bank", cls: "text-amber-300" },
  refund_failed: { label: "Refund didn't go through", cls: "text-red-300", help: "We've emailed you about it." },
};

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

/** Older gateways' card charges, in the row shape. */
export function rowsOf(h: BillingHistory): BillingRow[] {
  if (h.rows) return h.rows;
  return (h.charges ?? []).map((c: BillingCharge) => ({
    row_id: c.charge_id,
    created_at: c.created_at,
    amount_cents: c.amount_cents,
    currency: c.currency,
    status: c.status === "failed" ? "payment_needed" : c.status,
    ...(c.card ? { payment_method: { label: `${c.card.brand.charAt(0).toUpperCase()}${c.card.brand.slice(1)} •••• ${c.card.last4}` } } : {}),
    ...(c.hosted_invoice_url ? { invoice: { hosted_invoice_url: c.hosted_invoice_url } } : {}),
    ...(c.receipt_url ? { receipt_url: c.receipt_url } : {}),
    items: c.items,
  }));
}

/** "Payment Nov 3 · $6.75 · R7K2" */
export function helpSubject(row: BillingRow): string {
  return [`Payment ${shortDate(row.created_at)}`, formatCents(row.amount_cents), row.help_ref]
    .filter(Boolean)
    .join(" · ");
}

function PortalButton({ label }: { label: string }): JSX.Element {
  const gateway = useGateway();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
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

function Ext({ href, label }: { href: string; label: string }): JSX.Element {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
      {label} ↗
    </a>
  );
}

function RowMenu({ row }: { row: BillingRow }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        aria-label="More"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg"
      >
        <EllipsisIcon className="size-4" />
      </button>
      {open ? (
        <a
          href={supportMailto(helpSubject(row))}
          data-testid="row-help"
          onClick={() => setOpen(false)}
          className="absolute top-8 right-0 z-10 rounded-md border border-edge bg-popover px-3 py-2 text-xs whitespace-nowrap text-fg shadow-lg hover:bg-surface-2"
        >
          Get help with this payment
        </a>
      ) : null}
    </span>
  );
}

function Row({ row }: { row: BillingRow }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { openSettle } = useSettle();
  const s = STATUS[row.status];
  const refund = row.kind === "refund";
  const many = row.items.length > 1;
  const what = row.items.length === 0 ? "—" : many ? `${row.items.length} items` : itemLine(row.items[0]);
  const amount = refund ? `−${formatCents(row.amount_cents)}` : formatCents(row.amount_cents);
  const paid = row.status !== "payment_needed" && row.status !== "processing";
  return (
    <li data-testid={`row-${row.row_id}`} className="border-t border-edge">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 py-2.5 text-sm sm:grid-cols-[3.5rem_1fr_5rem_9rem_8rem_auto_auto]">
        <span className="text-fg-muted">{shortDate(row.created_at)}</span>
        <button
          type="button"
          aria-expanded={open}
          disabled={!many}
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 truncate text-left text-fg disabled:cursor-default"
        >
          {many ? (
            <span aria-hidden className={`mr-1 inline-block text-fg-muted transition-transform ${open ? "rotate-90" : ""}`}>
              ›
            </span>
          ) : null}
          {what}
          {many ? <span className="text-fg-muted"> · {formatCents(row.amount_cents)}</span> : null}
        </button>
        <span data-testid="row-amount" className="text-right font-mono tabular-nums text-fg">
          {amount}
        </span>
        <span className="hidden truncate text-xs text-fg-muted sm:block">
          {row.payment_method?.label ?? ""}
        </span>
        <span data-testid="row-status" className={`col-span-2 text-xs sm:col-span-1 ${s.cls}`}>
          {s.label}
          {s.help ? <span className="block text-[11px] text-fg-muted">{s.help}</span> : null}
        </span>
        <span className="flex items-center gap-3 text-xs">
          {row.status === "payment_needed" ? (
            <Button
              size="sm"
              onClick={() => openSettle()}
              className="bg-red-400 text-zinc-950 tabular-nums hover:bg-red-300"
            >
              Pay {formatCents(row.amount_cents)}
            </Button>
          ) : null}
          {refund && row.credit_note_url ? <Ext href={row.credit_note_url} label="Credit note" /> : null}
          {!refund && paid && row.invoice?.hosted_invoice_url ? (
            <Ext href={row.invoice.hosted_invoice_url} label="Invoice" />
          ) : null}
          {!refund && paid && row.receipt_url ? <Ext href={row.receipt_url} label="Receipt" /> : null}
        </span>
        <RowMenu row={row} />
      </div>
      {open ? (
        <ul data-testid="row-items" className="flex flex-col gap-1 pb-3 pl-[4.25rem] text-xs">
          {row.items.map((i) => (
            <li key={i.conversion_id} className="flex items-center gap-3">
              <Link
                href={`/projects/${i.project_id}#tab=files`}
                className="min-w-0 flex-1 truncate text-fg-muted hover:text-fg"
              >
                {itemLine(i)}
              </Link>
              <span className="font-mono text-fg-muted tabular-nums">{formatCents(i.amount_cents)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SkeletonRows({ n }: { n: number }): JSX.Element {
  return (
    <ul data-testid="skeleton" className="flex animate-pulse flex-col gap-2 py-1">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="h-9 rounded-md bg-surface-2" />
      ))}
    </ul>
  );
}

export function BillingScreen(): JSX.Element {
  const gateway = useGateway();
  const methods = usePaymentMethods();
  const review = useBilling().status?.flow_state === "under_review";
  const [rows, setRows] = useState<BillingRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [tax, setTax] = useState<BillingHistory["tax"]>("off");
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (after?: string): Promise<void> => {
      try {
        const h = await gateway.getBillingHistory(after);
        const page = rowsOf(h);
        setRows((prev) => (after && prev ? [...prev, ...page] : page));
        setHasMore(h.has_more === true);
        setTax(h.tax ?? "off");
        setError(false);
      } catch {
        if (!after) setError(true);
      }
    },
    [gateway],
  );

  useEffect(() => {
    let live = true;
    void gateway.getBillingHistory().then(
      (h) => {
        if (!live) return;
        setRows(rowsOf(h));
        setHasMore(h.has_more === true);
        setTax(h.tax ?? "off");
      },
      () => live && setError(true),
    );
    return () => {
      live = false;
    };
  }, [gateway]);

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
      {review ? (
        <p data-testid="billing-review" className="text-sm text-amber-200">
          {UNDER_REVIEW} Contact support to continue.
        </p>
      ) : null}

      <section
        aria-labelledby="payment-methods"
        className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-5"
      >
        <h2 id="payment-methods" className="text-sm font-semibold text-fg">
          Payment methods
        </h2>
        {methods === null ? (
          <SkeletonRows n={2} />
        ) : methods.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-fg-muted">No saved payment methods.</p>
            <PortalButton label="Add payment method" />
          </div>
        ) : (
          <>
            <ul data-testid="payment-methods" className="flex flex-col">
              {methods.map((m) => (
                <li
                  key={m.id}
                  data-testid={`method-${m.id}`}
                  className="flex items-center gap-2 border-t border-edge py-2 text-sm first:border-t-0"
                >
                  <span className="text-fg">{methodLabel(m)}</span>
                  {m.is_default ? <span className="text-fg-muted">· Default</span> : null}
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-2">
              <span>
                <PortalButton label="Manage payment methods and company details ↗" />
              </span>
              <p className="text-xs text-fg-muted">
                We charge your default payment method. If it&apos;s declined, we try your others.
              </p>
            </div>
          </>
        )}
      </section>

      <section
        aria-labelledby="purchase-history"
        className="flex flex-col rounded-xl border border-edge bg-surface-1 p-5"
      >
        <h2 id="purchase-history" className="pb-2 text-sm font-semibold text-fg">
          Purchases
        </h2>
        {error ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-red-300">Couldn&apos;t load your purchases.</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : rows === null ? (
          <SkeletonRows n={3} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">No purchases yet.</p>
        ) : (
          <>
            <ul data-testid="history">
              {rows.map((r) => (
                <Row key={r.row_id} row={r} />
              ))}
            </ul>
            {hasMore ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 self-start"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  await load(rows.at(-1)?.row_id);
                  setLoadingMore(false);
                }}
              >
                {loadingMore ? "Loading…" : "Show more"}
              </Button>
            ) : null}
          </>
        )}
        <p className="pt-3 text-xs text-fg-muted">
          US dollars.{tax === "inclusive" ? " Prices include VAT where it applies." : ""}
        </p>
      </section>
    </section>
  );
}
