"use client";

/**
 * P10 Usage tab (spec v7 §N13, mock p10e): one row per run for a month —
 * Date · Project · Method · Preset · Minutes · Cost · Paid with · Status —
 * with the month picker and Download CSV beside the tabs, and "Balance
 * history" (top-ups, reloads, refunds to the balance, debt payments,
 * expiry) folded under the table.
 */

import { ChevronDownIcon, DownloadIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { BalanceEntry, UsageRow } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { qualityName } from "@/lib/glossary";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

import { MethodBadge, badgeKind } from "./MethodBadge";

/** "2026-11" for the current month (UTC), and the 11 before it. */
export function recentMonths(now = new Date()): string[] {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

function monthName(m: string, t: Tr): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(t.intl, { month: "long", year: "numeric", timeZone: "UTC" });
}

function shortDate(iso: string, t: Tr): string {
  return new Date(iso).toLocaleDateString(t.intl, { month: "short", day: "numeric" });
}

/** "2:15" from minutes. */
export function clockOf(minutes: number): string {
  const s = Math.round(minutes * 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function usageStatus(r: UsageRow, t: Tr = EN): { text: string; cls: string } {
  switch (r.status) {
    case "running":
      return {
        text:
          r.reserved_cents !== undefined
            ? t("billing.usage.status.runningReserved", { amount: formatCents(r.reserved_cents, t) })
            : t("billing.usage.status.running"),
        cls: "text-primary",
      };
    case "released":
      return { text: t("billing.usage.status.released"), cls: "text-fg-muted" };
    case "partly_delivered":
      return { text: t("billing.usage.status.partlyDelivered"), cls: "text-amber-300" };
    case "returned":
      return { text: t("billing.usage.status.returned", { amount: formatCents(r.returned_cents ?? 0, t) }), cls: "text-violet-300" };
    default:
      return { text: t("billing.usage.status.done"), cls: "text-emerald-300" };
  }
}

/** The gateway's paid_with: balance | card | alipay (or a full label);
 * the English names pick the badge, the reader's words show. */
const PAID_WITH: Record<string, string> = { balance: "Balance", card: "Payment method", alipay: "Alipay" };

const ENTRY_KINDS: ReadonlySet<string> = new Set<BalanceEntry["kind"]>([
  "topup",
  "topup_bonus",
  "auto_reload",
  "refund_to_balance",
  "debt_payment",
  "cash_refund",
  "expiry",
  "adjustment",
  "dispute_freeze",
  "dispute_unfreeze",
  "dispute_loss",
]);

function entryName(kind: string, t: Tr): string {
  return ENTRY_KINDS.has(kind) ? t(`billing.usage.entry.${kind}`) : "";
}

/** The month picker and Download CSV, for the tab bar. */
export function UsageTools({ month, onMonth }: { month: string; onMonth: (m: string) => void }): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <label className="relative">
        <span className="sr-only">{t("billing.usage.month")}</span>
        <select
          aria-label={t("billing.usage.month")}
          value={month}
          onChange={(e) => onMonth(e.target.value)}
          className="h-8 appearance-none rounded-md border border-edge bg-surface-1 pe-8 ps-3 text-xs text-fg"
        >
          {recentMonths().map((m) => (
            <option key={m} value={m}>
              {monthName(m, t)}
            </option>
          ))}
        </select>
        <ChevronDownIcon aria-hidden className="pointer-events-none absolute top-2 end-2 size-4 text-fg-muted" />
      </label>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const csv = await gateway.usageCsv(month);
            const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `stereo3d-usage-${month}.csv`;
            a.click();
            URL.revokeObjectURL(url);
          } finally {
            setBusy(false);
          }
        }}
      >
        <DownloadIcon className="size-3.5" aria-hidden />
        {t("billing.usage.downloadCsv")}
      </Button>
    </div>
  );
}

export function UsageTab({ month }: { month: string }): JSX.Element {
  const gateway = useGateway();
  const t = useT();
  const [rows, setRows] = useState<{ month: string; rows: UsageRow[] } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  const [entries, setEntries] = useState<BalanceEntry[] | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    gateway.getUsage(month).then(
      (p) => {
        if (!live) return;
        setRows({ month, rows: p.rows });
        setHasMore(p.has_more === true);
        setError(false);
      },
      () => live && setError(true),
    );
    return () => {
      live = false;
    };
  }, [gateway, month, tries]);

  useEffect(() => {
    let live = true;
    gateway.getBalanceEntries().then(
      (e) => live && setEntries(e.entries),
      () => live && setEntries([]),
    );
    return () => {
      live = false;
    };
  }, [gateway]);

  const shown = rows?.month === month ? rows.rows : null;
  return (
    <div className="flex flex-col">
      {error ? (
        <div className="flex items-center gap-3 px-1 py-3 text-sm">
          <span className="text-red-300">{t("billing.usage.loadFailed")}</span>
          <Button variant="outline" size="sm" onClick={() => setTries((n) => n + 1)}>
            {t("billing.usage.tryAgain")}
          </Button>
        </div>
      ) : shown === null ? (
        <ul className="flex animate-pulse flex-col gap-2 py-1">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-9 rounded-md bg-surface-2" />
          ))}
        </ul>
      ) : shown.length === 0 ? (
        <p className="py-3 text-sm text-fg-muted">{t("billing.usage.none")}</p>
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table data-testid="usage" className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-y border-edge text-start text-xs text-fg-muted">
                <th className="px-5 py-2 font-normal">{t("billing.usage.columns.date")}</th>
                <th className="py-2 font-normal">{t("billing.usage.columns.project")}</th>
                <th className="py-2 font-normal">{t("billing.usage.columns.method")}</th>
                <th className="py-2 font-normal">{t("billing.usage.columns.preset")}</th>
                <th className="py-2 text-end font-normal">{t("billing.usage.columns.minutes")}</th>
                <th className="py-2 pe-4 text-end font-normal">{t("billing.usage.columns.cost")}</th>
                <th className="py-2 font-normal">{t("billing.usage.columns.paidWith")}</th>
                <th className="py-2 pe-5 font-normal">{t("billing.usage.columns.status")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const st = usageStatus(r, t);
                const paidKind = PAID_WITH[r.paid_with] ?? r.paid_with;
                const paid = r.key_name
                  ? t("billing.usage.apiKey", { name: r.key_name })
                  : Object.hasOwn(PAID_WITH, r.paid_with)
                    ? t(`billing.usage.paidWith.${r.paid_with}`)
                    : r.paid_with;
                return (
                  <tr key={r.conversion_id} data-testid={`usage-${r.conversion_id}`} className="border-b border-edge">
                    <td className="px-5 py-2.5 text-fg-muted">{shortDate(r.at, t)}</td>
                    <td className="py-2.5 text-fg">{r.project}</td>
                    <td className="py-2.5 text-fg">{r.method === "lifelike" ? "Lifelike" : "Classic"}</td>
                    <td className="py-2.5 text-fg">{qualityName(r.preset)}</td>
                    <td className="py-2.5 text-end font-mono tabular-nums text-fg">{clockOf(r.minutes)}</td>
                    <td className="py-2.5 pe-4 text-end font-mono tabular-nums text-fg">
                      {r.cost_cents === null ? "–" : formatCents(r.cost_cents, t)}
                    </td>
                    <td className="py-2.5">
                      <span className="flex items-center gap-2 text-fg">
                        <MethodBadge kind={badgeKind(r.key_name ? "API key" : paidKind)} />
                        {paid}
                      </span>
                    </td>
                    <td className={`py-2.5 pe-5 ${st.cls}`}>{st.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {hasMore ? (
        <Button variant="ghost" size="sm" className="mt-2 self-start" onClick={() => setTries((n) => n + 1)}>
          {t("billing.usage.showMore")}
        </Button>
      ) : null}
      {entries && entries.length > 0 ? (
        <details data-testid="balance-history" className="group pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-fg">
            <ChevronDownIcon aria-hidden className="size-4 -rotate-90 text-fg-muted transition-transform group-open:rotate-0 rtl:rotate-90 rtl:group-open:rotate-0" />
            {t("billing.usage.balanceHistory")}
          </summary>
          <ul className="mt-2 flex flex-col">
            {entries.map((e) => (
              <li key={e.id} className="grid grid-cols-[4rem_1fr_auto] gap-3 border-t border-edge py-2 text-sm">
                <span className="text-fg-muted">{shortDate(e.at, t)}</span>
                <span className="text-fg">
                  {entryName(e.kind, t)}
                  {e.detail ? ` · ${e.detail}` : ""}
                </span>
                <span className={`font-mono tabular-nums ${e.cents >= 0 ? "text-emerald-300" : "text-fg"}`}>
                  {e.cents >= 0 ? "+" : "−"}
                  {formatCents(Math.abs(e.cents), t)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
