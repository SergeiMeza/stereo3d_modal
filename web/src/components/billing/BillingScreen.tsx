"use client";

/**
 * Billing (P10, spec v6 G2; S3D-57/58/62), from the account menu.
 *
 * Spec v6.2: our own UI in place of the portal. Methods in backup order
 * (default first) with Make default · Move up · Move down · Remove, Add
 * payment method (P15, up to 5), Expired; Company details summary + Edit
 * (P16); History and Invoices tabs. Room is left at the top for spec v7's
 * Balance section.
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

import { supportMailto } from "@/components/billing/BillingBanner";
import { AddMethodSheet } from "@/components/pay/AddMethodSheet";
import { CompanyDetailsSheet, companySummary } from "@/components/pay/CompanyDetailsSheet";
import { UNDER_REVIEW } from "@/components/pay/payCopy";
import { useSettle } from "@/components/pay/SettleSheet";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GatewayError } from "@/lib/api/client";
import type {
  BillingCharge,
  BillingChargeItem,
  BillingHistory,
  BillingMethods,
  BillingRow,
  BillingRowStatus,
  CompanyDetails,
  InvoiceRow,
  SavedMethod,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { isExpired, methodLabel, useBillingMethods } from "@/lib/api/usePaymentMethods";
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

export const METHODS_LINE =
  "We charge your default payment method. If it's declined, we try your others in this order.";
export const MAX_METHODS_LINE = "You can save up to 5 payment methods.";
export const REMOVE_BLOCKED =
  "You can't remove your only payment method while a payment is pending. Pay it or add another one first.";

/** P10 Payment methods: backup order, default first; each row's menu has
 * Make default · Move up · Move down · Remove. */
function MethodsSection(): JSX.Element {
  const gateway = useGateway();
  const { list, set, reload } = useBillingMethods();
  const billing = useBilling();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<SavedMethod | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const methods = list?.methods ?? null;
  const max = list?.max ?? 5;

  async function change(id: string, run: () => Promise<BillingMethods>): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      set(await run());
      void billing.refresh();
    } catch (e) {
      if (e instanceof GatewayError && e.code === "method_needed") setBlocked(REMOVE_BLOCKED);
      else setError("Couldn't save that. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function move(i: number, by: -1 | 1): void {
    if (!methods) return;
    const ids = methods.map((m) => m.id);
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    void change(methods[i].id, () => gateway.orderMethods(ids));
  }

  return (
    <section aria-labelledby="payment-methods" className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-5">
      <div className="flex items-center gap-3">
        <h2 id="payment-methods" className="text-sm font-semibold text-fg">
          Payment methods
        </h2>
        {busy ? <span aria-label="Saving" className="size-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" /> : null}
      </div>
      {methods === null ? (
        <SkeletonRows n={2} />
      ) : methods.length === 0 ? (
        <p className="text-sm text-fg-muted">No saved payment methods.</p>
      ) : (
        <ul data-testid="payment-methods" className="flex flex-col">
          {methods.map((m, i) => (
            <li key={m.id} data-testid={`method-${m.id}`} className="flex items-center gap-2 border-t border-edge py-2 text-sm first:border-t-0">
              <span className="text-fg">{methodLabel(m)}</span>
              {m.is_default ? <span className="text-fg-muted">· Default</span> : null}
              {isExpired(m) ? (
                <span data-testid="method-expired" className="rounded-full border border-red-400/40 px-2 text-[11px] text-red-300">
                  Expired
                </span>
              ) : null}
              <MethodMenu
                label={methodLabel(m)}
                disabled={busy !== null}
                items={[
                  ...(!m.is_default ? [{ label: "Make default", run: () => void change(m.id, () => gateway.setDefaultMethod(m.id)) }] : []),
                  ...(i > 0 ? [{ label: "Move up", run: () => move(i, -1) }] : []),
                  ...(i < methods.length - 1 ? [{ label: "Move down", run: () => move(i, 1) }] : []),
                  {
                    label: "Remove",
                    run: () =>
                      m.removable === false ? setBlocked(m.remove_blocked_reason ?? REMOVE_BLOCKED) : setConfirm(m),
                  },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      {blocked ? (
        <p data-testid="remove-blocked" className="text-xs text-amber-200">
          {blocked}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          data-testid="add-method"
          disabled={methods !== null && methods.length >= max}
          onClick={() => setAdding(true)}
        >
          Add payment method
        </Button>
        {methods !== null && methods.length >= max ? <span className="text-xs text-fg-muted">{MAX_METHODS_LINE}</span> : null}
      </div>
      {methods !== null && methods.length > 0 ? <p className="text-xs text-fg-muted">{METHODS_LINE}</p> : null}
      {adding ? (
        <AddMethodSheet
          first={(methods?.length ?? 0) === 0}
          onClose={(saved) => {
            setAdding(false);
            if (saved) {
              void reload();
              void billing.refresh();
            }
          }}
        />
      ) : null}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent data-testid="remove-confirm" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove {confirm ? methodLabel(confirm) : ""}?</DialogTitle>
            {methods?.length === 1 ? (
              <DialogDescription>Your next runs will ask how to pay each time.</DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const m = confirm;
                setConfirm(null);
                if (m) void change(m.id, () => gateway.removeMethod(m.id));
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function MethodMenu({
  label,
  items,
  disabled,
}: {
  label: string;
  items: { label: string; run: () => void }[];
  disabled: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative ml-auto">
      <button
        type="button"
        aria-label={`Options for ${label}`}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
      >
        <EllipsisIcon className="size-4" />
      </button>
      {open ? (
        <span role="menu" className="absolute top-8 right-0 z-10 flex min-w-36 flex-col rounded-md border border-edge bg-popover py-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.run();
              }}
              className={`px-3 py-1.5 text-left text-xs hover:bg-surface-2 ${it.label === "Remove" ? "text-red-300" : "text-fg"}`}
            >
              {it.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** P10 Company details: a one-line summary and Edit (P16). */
function CompanySection(): JSX.Element {
  const gateway = useGateway();
  const [company, setCompany] = useState<CompanyDetails | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let live = true;
    gateway.getCompany().then(
      (c) => {
        if (!live) return;
        setCompany(c);
        setLoaded(true);
      },
      () => live && setLoaded(true),
    );
    return () => {
      live = false;
    };
  }, [gateway]);
  const summary = companySummary(company);
  return (
    <section aria-labelledby="company" className="flex flex-col gap-2 rounded-xl border border-edge bg-surface-1 p-5">
      <div className="flex items-center gap-3">
        <h2 id="company" className="text-sm font-semibold text-fg">
          Company details
        </h2>
        <Button variant="ghost" size="sm" className="ml-auto" disabled={!loaded} onClick={() => setEditing(true)}>
          Edit
        </Button>
      </div>
      <p data-testid="company-summary" className="text-sm text-fg-muted">
        {!loaded ? "Loading…" : summary ?? "No company details. Add them to show on invoices."}
      </p>
      {editing ? (
        <CompanyDetailsSheet
          initial={company ?? { tax_ids: [] }}
          onClose={(saved) => {
            setEditing(false);
            if (saved) setCompany(saved);
          }}
        />
      ) : null}
    </section>
  );
}

/** P10 Invoices tab: Date · Number · Amount · PDF ↗, credit notes under
 * their invoice. */
function InvoicesTab(): JSX.Element {
  const gateway = useGateway();
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(
    async (after?: string) => {
      try {
        const l = await gateway.getInvoices(after);
        setRows((prev) => (after && prev ? [...prev, ...l.invoices] : l.invoices));
        setHasMore(l.has_more === true);
        setError(false);
      } catch {
        if (!after) setError(true);
      }
    },
    [gateway],
  );
  useEffect(() => {
    let live = true;
    gateway.getInvoices().then(
      (l) => {
        if (!live) return;
        setRows(l.invoices);
        setHasMore(l.has_more === true);
      },
      () => live && setError(true),
    );
    return () => {
      live = false;
    };
  }, [gateway]);
  if (error) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-red-300">Couldn&apos;t load your invoices.</span>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  if (rows === null) return <SkeletonRows n={3} />;
  if (rows.length === 0) return <p className="text-sm text-fg-muted">No invoices yet.</p>;
  return (
    <>
      <ul data-testid="invoices">
        {rows.map((inv) => (
          <li key={inv.invoice_id} className="border-t border-edge py-2.5 text-sm">
            <div className="grid grid-cols-[3.5rem_1fr_auto_auto] items-center gap-3">
              <span className="text-fg-muted">{shortDate(inv.created_at)}</span>
              <span className="font-mono text-xs text-fg">{inv.number}</span>
              <span className="font-mono tabular-nums text-fg">{formatCents(inv.amount_cents)}</span>
              <span className="text-xs">{inv.pdf_url ? <Ext href={inv.pdf_url} label="PDF" /> : null}</span>
            </div>
            {(inv.credit_notes ?? []).map((cn) => (
              <div key={cn.id} className="grid grid-cols-[3.5rem_1fr_auto_auto] items-center gap-3 pt-1.5 text-xs text-fg-muted">
                <span>{shortDate(cn.created_at)}</span>
                <span className="font-mono">Credit note {cn.number}</span>
                <span className="font-mono tabular-nums">−{formatCents(cn.amount_cents)}</span>
                <span>{cn.pdf_url ? <Ext href={cn.pdf_url} label="PDF" /> : null}</span>
              </div>
            ))}
          </li>
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
            await load(rows.at(-1)?.invoice_id);
            setLoadingMore(false);
          }}
        >
          {loadingMore ? "Loading…" : "Show more"}
        </Button>
      ) : null}
    </>
  );
}

export function BillingScreen(): JSX.Element {
  const gateway = useGateway();
  const review = useBilling().status?.flow_state === "under_review";
  const [tab, setTab] = useState<"history" | "invoices">("history");
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

      {/* spec v7 adds a Balance section here (top-ups, auto-reload, usage) */}

      <MethodsSection />
      <CompanySection />

      <section aria-label="Purchases and invoices" className="flex flex-col rounded-xl border border-edge bg-surface-1 p-5">
        <div role="tablist" aria-label="Billing records" className="mb-2 flex gap-1 self-start rounded-md bg-surface-2 p-0.5 text-xs">
          {(
            [
              ["history", "History"],
              ["invoices", "Invoices"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded px-3 py-1 ${tab === id ? "bg-surface-0 text-fg shadow-sm" : "text-fg-muted hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "invoices" ? (
          <InvoicesTab />
        ) : error ? (
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
