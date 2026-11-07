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

import { Building2Icon, EllipsisIcon, InfoIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import { supportMailto } from "@/components/billing/BillingBanner";
import { SectionBoundary } from "@/components/SectionBoundary";
import { BalanceCard } from "@/components/billing/BalanceCard";
import { PlanCard } from "@/components/billing/PlanCard";
import { ProCreditCard } from "@/components/pro/ProCredit";
import { YourPrices } from "@/components/billing/YourPrices";
import { PlanMoveOffers } from "@/components/billing/PlanMoveOffers";
import { RestorePurchases } from "@/components/billing/RestorePurchases";
import { openRefundSheetAtom, refundOptionsAtom } from "@/components/refunds/refundAtoms";
import { RefundQuestionNotice, RefundsFooter, SHOW_REFUND_ENTRY } from "@/components/refunds/RefundsSection";
import { SettleFromLink } from "@/components/billing/SettleFromLink";
import { MethodBadge, badgeKind } from "@/components/billing/MethodBadge";
import { FirstTimeHint } from "@/components/onboarding/FirstTimeHint";
import { UsageTab, UsageTools, recentMonths } from "@/components/billing/UsageTab";
import { AddMethodSheet } from "@/components/pay/AddMethodSheet";
import { companySummary } from "@/lib/company";
import { useSettle } from "@/components/pay/SettleSheet";
import { formatCents, groupMoney } from "@/components/steps/money";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GatewayError } from "@/lib/api/client";
import type {
  BillingCharge,
  BillingChargeItem,
  BillingHistory,
  BillingMethods,
  BillingRow,
  BillingRowStatus,
  CompanyDetails,
  HistoryFilter,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { isExpired, methodLabel, useBillingMethods } from "@/lib/api/usePaymentMethods";
import { billingUidAtom, useBilling } from "@/lib/billing";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";
import { qualityName } from "@/lib/glossary";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

import {
  billingHistoryAtom,
  companyAtom,
  invoicesAtom,
  loadBillingHistoryAtom,
  loadCompanyAtom,
  loadInvoicesAtom,
} from "./billingHistoryAtoms";

/** Each status's colour, and whether it has a help line
 * (billing.history.status.* and billing.history.statusHelp.*). */
const STATUS: Record<BillingRowStatus, { cls: string; help?: true }> = {
  paid: { cls: "text-emerald-300" },
  processing: { cls: "text-amber-300", help: true },
  payment_needed: { cls: "text-red-300" },
  refund_requested: { cls: "text-fg", help: true },
  refunded: { cls: "text-fg-muted" },
  partially_refunded: { cls: "text-fg-muted" },
  disputed: { cls: "text-amber-300" },
  refund_failed: { cls: "text-red-300", help: true },
  failed: { cls: "text-red-300" },
  applied: { cls: "text-fg-muted" },
  scheduled: { cls: "text-amber-300" },
};

/** gateway ffac292: a credit row's state, in plain words
 * (billing.history.credit.*). */
const CREDIT_KINDS: ReadonlySet<string> = new Set<NonNullable<BillingRow["credit"]>["kind"]>([
  "granted",
  "expired",
  "removed",
  "frozen",
  "unfrozen",
]);

/** "payment_needed" → "Payment needed"; "" → "—". */
function humanize(v: string): string {
  if (!v) return "—";
  const t = v.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** A plan change or credit row: no money, only what happened. */
function isNoMoney(row: BillingRow): boolean {
  return row.kind === "plan_change" || row.kind === "credit";
}

/** "Scheduled for Dec 5", "Changed", "Added". */
export function noMoneyStatus(row: BillingRow, t: Tr = EN): string {
  if (row.kind === "credit") {
    return row.credit && CREDIT_KINDS.has(row.credit.kind)
      ? t(`billing.history.credit.${row.credit.kind}`)
      : t("billing.history.done");
  }
  if (row.status === "scheduled") {
    return row.change?.effective_at
      ? t("billing.history.scheduledFor", { date: shortDate(row.change.effective_at, t) })
      : t("billing.history.scheduled");
  }
  return t("billing.history.changed");
}

function shortDate(iso: string, t: Tr = EN): string {
  return new Date(iso).toLocaleDateString(t.intl, { month: "short", day: "numeric" });
}

/** "Kyoto walk · 3D video · 4K", with the launch offer when the run had
 * it ("… · 1080p · Launch offer −25%", gateway 00178) */
export function itemLine(i: BillingChargeItem, t: Tr = EN): string {
  return [
    i.project_name ?? t("billing.history.item.untitled"),
    i.step === "production" ? t("billing.history.item.production") : t("billing.history.item.preview"),
    i.preset ? qualityName(i.preset, t) : null,
    (i.campaign_cents ?? 0) > 0 ? (i.campaign_label ?? t("billing.history.item.launchOffer")) : null,
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

/** What in this row can still be asked for a refund (the options list,
 * not asked for yet). */
function useRowRefund(row: BillingRow): { plan: boolean; conversionIds: string[]; asked: boolean } | null {
  const options = useAppAtomValue(refundOptionsAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const opts = options.uid === uid ? options.data : null;
  if (!opts || row.kind === "refund") return null;
  if (row.kind === "plan") {
    const p = opts.plan;
    if (!p || !row.plan || p.invoice_id !== row.plan.invoice_id) return null;
    return { plan: p.open_request_id === null, conversionIds: [], asked: p.open_request_id !== null };
  }
  const ids = new Set((row.items ?? []).map((i) => i.conversion_id));
  const runs = opts.runs.filter((r) => ids.has(r.conversion_id));
  if (runs.length === 0) return null;
  const free = runs.filter((r) => r.open_request_id === null).map((r) => r.conversion_id);
  return { plan: false, conversionIds: free, asked: free.length === 0 };
}

function RowMenu({ row }: { row: BillingRow }): JSX.Element {
  const t = useT();
  const refund = useRowRefund(row);
  const openRefund = useAppSetAtom(openRefundSheetAtom);
  // owner 2026-11-07: the shadcn menu (Radix): it stays inside the screen
  // at the right edge, also at phone width
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("billing.history.menu.more")}
          className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          <EllipsisIcon className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="text-xs">
        {/* owner 2026-11-07: hidden with the footer (SHOW_REFUND_ENTRY) */}
        {SHOW_REFUND_ENTRY && refund ? (
          refund.asked ? (
            <DropdownMenuItem disabled data-testid="row-refund-asked" className="text-xs">
              {t("billing.history.menu.refundRequested")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              data-testid="row-refund"
              className="text-xs"
              onSelect={() => openRefund({ plan: refund.plan, conversionIds: refund.conversionIds })}
            >
              {t("billing.history.menu.requestRefund")}
            </DropdownMenuItem>
          )
        ) : null}
        <DropdownMenuItem asChild className="text-xs">
          <a href={supportMailto(helpSubject(row))} data-testid="row-help">
            {t("billing.history.menu.getHelp")}
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** gateway ffac292: a plan change or a usage-credit row (no money), for
 * the traceable credit history. */
function NoMoneyRow({ row }: { row: BillingRow }): JSX.Element {
  const t = useT();
  const scheduled = row.status === "scheduled";
  return (
    <li data-testid={`row-${row.row_id}`} className="border-t border-edge">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 py-2.5 text-sm sm:grid-cols-[3.5rem_1fr_5rem_9rem_8rem_auto_auto]">
        <span className="text-fg-muted">{shortDate(row.created_at, t)}</span>
        <span className="min-w-0 truncate text-fg-muted">
          {row.label ? groupMoney(row.label) : row.kind === "credit" ? t("billing.history.usageCredit") : t("billing.history.planChange")}
        </span>
        <span data-testid="row-amount" className="text-end font-mono text-fg-muted">
          —
        </span>
        <span className="hidden sm:block" />
        <span data-testid="row-status" className={`col-span-2 text-xs sm:col-span-1 ${scheduled ? "text-amber-300" : "text-fg-muted"}`}>
          <span aria-hidden className="me-1.5 inline-block size-1.5 -translate-y-px rounded-full bg-current" />
          {noMoneyStatus(row, t)}
        </span>
        <span />
        <span className="size-7" />
      </div>
    </li>
  );
}

function Row({ row }: { row: BillingRow }): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { openSettle } = useSettle();
  if (isNoMoney(row)) return <NoMoneyRow row={row} />;
  // plan rows come without run items
  const items = row.items ?? [];
  // total: a status this build doesn't know shows as plain text, never a crash
  const known = Object.hasOwn(STATUS, row.status) ? STATUS[row.status] : null;
  const s = known
    ? {
        label: t(`billing.history.status.${row.status}`),
        cls: known.cls,
        help: known.help ? t(`billing.history.statusHelp.${row.status}`) : undefined,
      }
    : { label: humanize(String(row.status ?? "")), cls: "text-fg-muted", help: undefined };
  const refund = row.kind === "refund";
  const planRow = row.kind === "plan";
  // a step-up's lines: the new plan and the credit for the unused one
  const lines = planRow && (row.lines?.length ?? 0) > 1 ? row.lines! : null;
  const many = items.length > 1 || lines !== null;
  const what = planRow
    ? (row.label ? groupMoney(row.label) : t("billing.history.plan"))
    : items.length === 0
      ? (row.label ? groupMoney(row.label) : "—")
      : items.length > 1
        ? t("billing.history.items", { count: items.length })
        : itemLine(items[0], t);
  const amount = refund ? `−${formatCents(row.amount_cents, t)}` : formatCents(row.amount_cents, t);
  const paid = row.status !== "payment_needed" && row.status !== "processing" && row.status !== "failed";
  return (
    <li data-testid={`row-${row.row_id}`} className="border-t border-edge">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 py-2.5 text-sm sm:grid-cols-[3.5rem_1fr_5rem_9rem_8rem_auto_auto]">
        <span className="text-fg-muted">{shortDate(row.created_at, t)}</span>
        <button
          type="button"
          aria-expanded={open}
          disabled={!many}
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 truncate text-start text-fg disabled:cursor-default"
        >
          {many ? (
            <span aria-hidden className={`me-1 inline-block text-fg-muted transition-transform ${open ? "rotate-90" : "rtl:-scale-x-100"}`}>
              ›
            </span>
          ) : null}
          {what}
          {many && !planRow ? <span className="text-fg-muted"> · {formatCents(row.amount_cents, t)}</span> : null}
        </button>
        <span data-testid="row-amount" className="text-end font-mono tabular-nums text-fg">
          {amount}
        </span>
        <span className="hidden min-w-0 items-center gap-2 text-xs text-fg sm:flex">
          {row.payment_method?.label ? <MethodBadge kind={badgeKind(row.payment_method.label)} /> : <span className="text-fg-muted">—</span>}
          <span className="truncate">{row.payment_method?.label ?? ""}</span>
        </span>
        <span data-testid="row-status" className={`col-span-2 text-xs sm:col-span-1 ${s.cls}`}>
          <span aria-hidden className="me-1.5 inline-block size-1.5 -translate-y-px rounded-full bg-current" />
          {s.label}
          {s.help ? <span className="block text-[11px] text-fg-muted">{s.help}</span> : null}
        </span>
        <span className="flex items-center gap-3 text-xs">
          {row.status === "payment_needed" && planRow && row.invoice?.hosted_invoice_url ? (
            // a plan invoice is paid on its own page, not with the runs
            <Ext href={row.invoice.hosted_invoice_url} label={t("billing.history.payInvoice")} />
          ) : row.status === "payment_needed" && !planRow ? (
            <Button
              size="sm"
              onClick={() => openSettle()}
              className="bg-red-400 text-zinc-950 tabular-nums hover:bg-red-300"
            >
              {t("billing.history.pay", { amount: formatCents(row.amount_cents, t) })}
            </Button>
          ) : null}
          {refund && row.credit_note_url ? <Ext href={row.credit_note_url} label={t("billing.history.creditNote")} /> : null}
          {!refund && paid && row.invoice?.hosted_invoice_url ? (
            <Ext href={row.invoice.hosted_invoice_url} label={t("billing.history.invoice")} />
          ) : null}
          {!refund && paid && row.receipt_url ? <Ext href={row.receipt_url} label={t("billing.history.receipt")} /> : null}
        </span>
        <RowMenu row={row} />
      </div>
      {open && lines ? (
        <ul data-testid="row-lines" className="flex flex-col gap-1 pb-3 ps-[4.25rem] text-xs">
          {lines.map((l, i) => (
            <li key={i} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-fg-muted">{groupMoney(l.description)}</span>
              <span className="font-mono text-fg-muted tabular-nums">
                {l.amount_cents < 0 ? `−${formatCents(-l.amount_cents, t)}` : formatCents(l.amount_cents, t)}
              </span>
            </li>
          ))}
        </ul>
      ) : open ? (
        <ul data-testid="row-items" className="flex flex-col gap-1 pb-3 ps-[4.25rem] text-xs">
          {items.map((i) => (
            <li key={i.conversion_id} className="flex items-center gap-3">
              <Link
                href={`/projects/${i.project_id}#tab=files`}
                className="min-w-0 flex-1 truncate text-fg-muted hover:text-fg"
              >
                {itemLine(i, t)}
              </Link>
              <span className="font-mono text-fg-muted tabular-nums">{formatCents(i.amount_cents, t)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** A History row inside its own boundary. */
function RowBoundary({ row }: { row: BillingRow }): JSX.Element {
  const t = useT();
  return (
    <SectionBoundary listItem name={row.label ?? t("billing.screen.sections.aRow")}>
      <Row row={row} />
    </SectionBoundary>
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

/** Our own refusal (the gateway's reason is shown as it sends it); shown
 * as billing.screen.methods.removeBlocked. */
export const REMOVE_BLOCKED =
  "You can't remove your only payment method while a payment is pending. Pay it or add another one first.";

/** P10 Payment methods: backup order, default first; each row's menu has
 * Make default · Move up · Move down · Remove. */
function MethodsSection(): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const { list, set, reload } = useBillingMethods();
  const billing = useBilling();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // the method being removed, by id (its row comes from the list)
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const methods = list?.methods ?? null;
  const max = list?.max ?? 5;
  const confirm = methods?.find((m) => m.id === confirmId) ?? null;

  async function change(id: string, run: () => Promise<BillingMethods>): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      set(await run());
      void billing.refresh();
    } catch (e) {
      if (e instanceof GatewayError && e.code === "method_needed") setBlocked(REMOVE_BLOCKED);
      else setError(t("billing.screen.methods.saveFailed"));
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
    <section aria-labelledby="payment-methods" className="flex flex-col rounded-xl border border-edge bg-surface-1">
      <div className="flex items-center gap-3 border-b border-edge px-5 py-4">
        <h2 id="payment-methods" className="text-sm font-semibold text-fg">
          {t("billing.screen.methods.title")}
        </h2>
        {busy ? <span aria-label={t("billing.screen.methods.saving")} className="size-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" /> : null}
        <Button
          variant="outline"
          size="sm"
          data-testid="add-method"
          className="ms-auto"
          disabled={methods !== null && methods.length >= max}
          onClick={() => setAdding(true)}
        >
          <PlusIcon className="size-3.5" aria-hidden />
          {t("billing.screen.methods.add")}
        </Button>
      </div>
      <div className="flex flex-col gap-3 px-5 py-3">
      {methods === null ? (
        <SkeletonRows n={2} />
      ) : methods.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("billing.screen.methods.none")}</p>
      ) : (
        <ul data-testid="payment-methods" className="flex flex-col">
          {methods.map((m, i) => (
            <li key={m.id} data-testid={`method-${m.id}`} className="flex items-center gap-3 border-t border-edge py-3 text-sm first:border-t-0">
              <span className="w-4 text-xs text-fg-muted tabular-nums">{i + 1}</span>
              <MethodBadge kind={badgeKind(m)} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-fg">{methodLabel(m)}</span>
                {isExpired(m) ? (
                  <span className="text-xs text-fg-muted">
                    {t("billing.screen.methods.expiredOn", {
                      date: `${String(m.exp_month).padStart(2, "0")}/${String(m.exp_year).slice(-2)}`,
                    })}
                  </span>
                ) : null}
              </span>
              <span className="ms-auto flex items-center gap-2">
              {m.is_default ? (
                <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                  <span className="sr-only">· </span>
                  {t("billing.screen.methods.default")}
                </span>
              ) : null}
              {isExpired(m) ? (
                <span
                  data-testid="method-expired"
                  className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-300"
                >
                  {t("billing.screen.methods.expired")}
                </span>
              ) : null}
              <MethodMenu
                label={methodLabel(m)}
                disabled={busy !== null}
                items={[
                  ...(!m.is_default
                    ? [{ label: t("billing.screen.methods.makeDefault"), run: () => void change(m.id, () => gateway.setDefaultMethod(m.id)) }]
                    : []),
                  ...(i > 0 ? [{ label: t("billing.screen.methods.moveUp"), run: () => move(i, -1) }] : []),
                  ...(i < methods.length - 1 ? [{ label: t("billing.screen.methods.moveDown"), run: () => move(i, 1) }] : []),
                  {
                    label: t("billing.screen.methods.remove"),
                    destructive: true,
                    run: () =>
                      m.removable === false ? setBlocked(m.remove_blocked_reason ?? REMOVE_BLOCKED) : setConfirmId(m.id),
                  },
                ]}
              />
              </span>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      {blocked ? (
        <p data-testid="remove-blocked" className="text-xs text-amber-200">
          {blocked === REMOVE_BLOCKED ? t("billing.screen.methods.removeBlocked") : blocked}
        </p>
      ) : null}
      {methods !== null && methods.length >= max ? <p className="text-xs text-fg-muted">{t("billing.screen.methods.max")}</p> : null}
      {methods !== null && methods.length > 0 ? (
        <p className="flex items-center gap-2 pb-1 text-xs text-fg-muted">
          <InfoIcon className="size-3.5 shrink-0" aria-hidden />
          {t("billing.screen.methods.chargeOrder")}
        </p>
      ) : null}
      </div>
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
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirmId(null)}>
        <AlertDialogContent data-testid="remove-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("billing.screen.methods.confirmTitle", { label: confirm ? methodLabel(confirm) : "" })}</AlertDialogTitle>
            {methods?.length === 1 ? (
              <AlertDialogDescription>{t("billing.screen.methods.confirmLast")}</AlertDialogDescription>
            ) : (
              <AlertDialogDescription className="sr-only">{t("billing.screen.methods.confirmDescription")}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("billing.screen.methods.keep")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const m = confirm;
                setConfirmId(null);
                if (m) void change(m.id, () => gateway.removeMethod(m.id));
              }}
            >
              {t("billing.screen.methods.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function MethodMenu({
  label,
  items,
  disabled,
}: {
  label: string;
  items: { label: string; destructive?: boolean; run: () => void }[];
  disabled: boolean;
}): JSX.Element {
  const t = useT();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("billing.screen.methods.optionsFor", { label })}
          disabled={disabled}
          className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
        >
          <EllipsisIcon className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((it) => (
          <DropdownMenuItem
            key={it.label}
            variant={it.destructive ? "destructive" : "default"}
            onSelect={() => it.run()}
            className="text-xs"
          >
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Owner 2026-11-05: a Business or Studio account whose invoices still
 * lack a company name or address (Checkout asks only the method and
 * country). A gentle line; it never blocks anything. */
export function companyMissing(c: CompanyDetails | null): boolean {
  return !c?.company_name?.trim() || !c.address?.line1?.trim();
}

/** P10 Company details: a one-line summary and Edit, which opens Account
 * → Business details (owner 2026-11-04). */
function CompanySection(): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const plan = useBilling().status?.plan;
  const teamPlan = plan?.active === true && (plan.plan === "business" || plan.plan === "studio");
  // ADR 0138: the business details live in an app-store atom
  const state = useAppAtomValue(companyAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const loadCompany = useAppSetAtom(loadCompanyAtom);
  useEffect(() => {
    void loadCompany(gateway);
  }, [loadCompany, gateway, uid]);
  const company = state.uid === uid ? state.company : null;
  const loaded = state.uid === uid && state.loaded;
  const summary = companySummary(company);
  const remind = teamPlan && loaded && companyMissing(company);
  return (
    <section aria-labelledby="company" className="flex items-center gap-4 rounded-xl border border-edge bg-surface-1 px-5 py-4">
      <Building2Icon className="size-5 shrink-0 text-fg-muted" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 id="company" className="text-sm font-semibold text-fg">
          {t("billing.screen.company.title")}
        </h2>
        <p data-testid="company-summary" className="truncate text-xs text-fg-muted">
          {!loaded ? t("billing.screen.company.loading") : (summary ?? t("billing.screen.company.empty"))}
        </p>
        {remind ? (
          <Link
            href="/account/business-details"
            data-testid="company-reminder"
            className="w-fit text-xs text-primary hover:underline"
          >
            {t("billing.screen.company.reminder")}
          </Link>
        ) : null}
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/account/business-details">{t("billing.screen.company.edit")}</Link>
      </Button>
    </section>
  );
}

/** P10 Invoices tab: Date · Number · Amount · PDF ↗, credit notes under
 * their invoice. */
function InvoicesTab(): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  // ADR 0138: the invoices live in an app-store atom
  const state = useAppAtomValue(invoicesAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const mine = state.uid === uid;
  const rows = mine ? state.rows : null;
  const hasMore = mine && state.hasMore;
  const error = mine && state.error;
  const [loadingMore, setLoadingMore] = useState(false);
  const loadInvoices = useAppSetAtom(loadInvoicesAtom);
  const load = useCallback(
    (after?: string): Promise<void> => loadInvoices({ client: gateway, after }),
    [gateway, loadInvoices],
  );
  useEffect(() => {
    void load();
  }, [load, uid]);
  if (error) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-red-300">{t("billing.screen.invoices.loadFailed")}</span>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {t("billing.screen.invoices.tryAgain")}
        </Button>
      </div>
    );
  }
  if (rows === null) return <SkeletonRows n={3} />;
  if (rows.length === 0) return <p className="text-sm text-fg-muted">{t("billing.screen.invoices.none")}</p>;
  return (
    <>
      <ul data-testid="invoices">
        {rows.map((inv) => (
          <li key={inv.invoice_id} className="border-t border-edge py-2.5 text-sm">
            <div className="grid grid-cols-[3.5rem_1fr_auto_auto] items-center gap-3">
              <span className="text-fg-muted">{shortDate(inv.created_at, t)}</span>
              <span className="font-mono text-xs text-fg">{inv.number}</span>
              <span className="font-mono tabular-nums text-fg">{formatCents(inv.amount_cents, t)}</span>
              <span className="text-xs">{inv.pdf_url ? <Ext href={inv.pdf_url} label={t("billing.screen.invoices.pdf")} /> : null}</span>
            </div>
            {(inv.credit_notes ?? []).map((cn) => (
              <div key={cn.id} className="grid grid-cols-[3.5rem_1fr_auto_auto] items-center gap-3 pt-1.5 text-xs text-fg-muted">
                <span>{shortDate(cn.created_at, t)}</span>
                <span className="font-mono">{t("billing.screen.invoices.creditNote", { number: cn.number })}</span>
                <span className="font-mono tabular-nums">−{formatCents(cn.amount_cents, t)}</span>
                <span>{cn.pdf_url ? <Ext href={cn.pdf_url} label={t("billing.screen.invoices.pdf")} /> : null}</span>
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
          {loadingMore ? t("billing.screen.invoices.loading") : t("billing.screen.invoices.showMore")}
        </Button>
      ) : null}
    </>
  );
}

export function BillingScreen(): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const review = useBilling().status?.flow_state === "under_review";
  const [tab, setTab] = useState<"history" | "plan" | "usage" | "invoices">("history");
  // gateway ffac292: the Plan tab is the history with filter=plan
  const filter: HistoryFilter | null = tab === "plan" ? "plan" : null;
  const [month, setMonth] = useState(() => recentMonths()[0]);
  // ADR 0138: the purchases live in an app-store atom (billingHistoryAtoms)
  const history = useAppAtomValue(billingHistoryAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const mine = history.uid === uid && history.filter === filter;
  const rows = mine ? history.rows : null;
  const hasMore = mine && history.hasMore;
  const tax = mine ? history.tax : "off";
  const error = mine && history.error;
  const [loadingMore, setLoadingMore] = useState(false);
  const loadHistory = useAppSetAtom(loadBillingHistoryAtom);

  const load = useCallback(
    (after?: string): Promise<void> => loadHistory({ client: gateway, rowsOf, after, filter }),
    [gateway, loadHistory, filter],
  );

  // the first page, and again when the account or the filter changes
  const listed = tab === "history" || tab === "plan";
  useEffect(() => {
    if (listed) void load();
  }, [load, uid, listed]);

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{t("billing.screen.title")}</h1>
      <FirstTimeHint id="billing" />
      {/* ?settle=1, the app's link after a delete answered balance_due */}
      <SettleFromLink />
      {review ? (
        <p data-testid="billing-review" className="text-sm text-amber-200">
          {t("pay.copy.underReview")} {t("billing.screen.contactSupportToContinue")}
        </p>
      ) : null}

      {/* owner 2026-11-07: the only refund line above the fold, when we
          asked a question about a request */}
      <SectionBoundary name={t("billing.screen.sections.refundQuestion")}>
        <RefundQuestionNotice />
      </SectionBoundary>
      {/* owner bug 2026-11-05: one section failing never takes the page */}
      <SectionBoundary name={t("billing.screen.sections.balance")}>
        <BalanceCard />
      </SectionBoundary>
      {/* gateway 00155: a plan support offered to move here */}
      <SectionBoundary name={t("billing.screen.sections.planMoves")}>
        <PlanMoveOffers />
      </SectionBoundary>
      <SectionBoundary name={t("billing.screen.sections.plan")}>
        <PlanCard />
      </SectionBoundary>
      {/* owner 2026-11-07: Pro's monthly usage credit */}
      <SectionBoundary name={t("billing.screen.sections.proCredit", { pro: "Pro" })}>
        <ProCreditCard />
      </SectionBoundary>
      <SectionBoundary name={t("billing.screen.sections.restorePurchases")}>
        <RestorePurchases />
      </SectionBoundary>

      <SectionBoundary name={t("billing.screen.sections.paymentMethods")}>
        <MethodsSection />
      </SectionBoundary>
      <SectionBoundary name={t("billing.screen.sections.businessDetails")}>
        <CompanySection />
      </SectionBoundary>

      <section aria-label={t("billing.screen.records.label")} className="flex flex-col rounded-xl border border-edge bg-surface-1 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList aria-label={t("billing.screen.records.tabsLabel")} className="text-xs">
            <TabsTrigger value="history">{t("billing.screen.records.tabs.history")}</TabsTrigger>
            <TabsTrigger value="plan">{t("billing.screen.records.tabs.plan")}</TabsTrigger>
            <TabsTrigger value="usage">{t("billing.screen.records.tabs.usage")}</TabsTrigger>
            <TabsTrigger value="invoices">{t("billing.screen.records.tabs.invoices")}</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "usage" ? (
          <span className="ms-auto">
            <UsageTools month={month} onMonth={setMonth} />
          </span>
        ) : null}
        </div>
        {tab === "usage" ? <FirstTimeHint id="usage" className="mb-3" /> : null}
        {tab === "invoices" ? <FirstTimeHint id="invoices" className="mb-3" /> : null}
        {tab === "usage" ? (
          <SectionBoundary name={t("billing.screen.sections.usage")}>
            <UsageTab month={month} />
          </SectionBoundary>
        ) : tab === "invoices" ? (
          <SectionBoundary name={t("billing.screen.sections.invoices")}>
            <InvoicesTab />
          </SectionBoundary>
        ) : error ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-red-300">{t("billing.screen.records.loadFailed")}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("billing.screen.records.tryAgain")}
            </Button>
          </div>
        ) : rows === null ? (
          <SkeletonRows n={3} />
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">{tab === "plan" ? t("billing.screen.records.noPlanPayments") : t("billing.screen.records.noPurchases")}</p>
        ) : (
          <>
            <ul data-testid="history">
              {rows.map((r) => (
                // one odd row shows its own line, the rest of History stays
                <RowBoundary key={r.row_id} row={r} />
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
                {loadingMore ? t("billing.screen.records.loading") : t("billing.screen.records.showMore")}
              </Button>
            ) : null}
          </>
        )}
        <p className="pt-3 text-xs text-fg-muted">
          {tax === "inclusive" ? t("billing.screen.records.currencyWithVat") : t("billing.screen.records.currency")}
        </p>
      </section>
      {/* owner 2026-11-07: the /pricing table for this plan and the next one
       * up, at the bottom (moved from under the plan card) */}
      <SectionBoundary name={t("billing.screen.sections.yourPrices")}>
        <YourPrices />
      </SectionBoundary>
      {/* owner 2026-11-07: refunds, quietly, at the bottom */}
      <SectionBoundary name={t("billing.screen.sections.refunds")}>
        <RefundsFooter />
      </SectionBoundary>
    </section>
  );
}
