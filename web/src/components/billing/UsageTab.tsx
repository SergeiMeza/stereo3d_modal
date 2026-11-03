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

import { MethodBadge, badgeKind } from "./MethodBadge";

/** "2026-11" for the current month (UTC), and the 11 before it. */
export function recentMonths(now = new Date()): string[] {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

function monthName(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "2:15" from minutes. */
export function clockOf(minutes: number): string {
  const s = Math.round(minutes * 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function usageStatus(r: UsageRow): { text: string; cls: string } {
  switch (r.status) {
    case "running":
      return {
        text: r.reserved_cents !== undefined ? `Running, reserved ${formatCents(r.reserved_cents)}` : "Running",
        cls: "text-primary",
      };
    case "released":
      return { text: "Released", cls: "text-fg-muted" };
    case "partly_delivered":
      return { text: "Partly delivered", cls: "text-amber-300" };
    case "returned":
      return { text: `Returned to balance ${formatCents(r.returned_cents ?? 0)}`, cls: "text-violet-300" };
    default:
      return { text: "Done", cls: "text-emerald-300" };
  }
}

const ENTRY: Record<BalanceEntry["kind"], string> = {
  topup: "Top-up",
  auto_reload: "Auto-reload",
  refund_to_balance: "Returned to balance",
  debt_payment: "Paid what was owed",
  cash_refund: "Refunded to your payment method",
  expiry: "Expired",
  adjustment: "Adjustment",
  dispute_freeze: "On hold while a payment is reviewed",
  dispute_unfreeze: "Released after review",
  dispute_loss: "Removed after a bank dispute",
};

/** The month picker and Download CSV, for the tab bar. */
export function UsageTools({ month, onMonth }: { month: string; onMonth: (m: string) => void }): JSX.Element {
  const gateway = useGateway();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <label className="relative">
        <span className="sr-only">Month</span>
        <select
          aria-label="Month"
          value={month}
          onChange={(e) => onMonth(e.target.value)}
          className="h-8 appearance-none rounded-md border border-edge bg-surface-1 pr-8 pl-3 text-xs text-fg"
        >
          {recentMonths().map((m) => (
            <option key={m} value={m}>
              {monthName(m)}
            </option>
          ))}
        </select>
        <ChevronDownIcon aria-hidden className="pointer-events-none absolute top-2 right-2 size-4 text-fg-muted" />
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
        Download CSV
      </Button>
    </div>
  );
}

export function UsageTab({ month }: { month: string }): JSX.Element {
  const gateway = useGateway();
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
          <span className="text-red-300">Couldn&apos;t load your usage.</span>
          <Button variant="outline" size="sm" onClick={() => setTries((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : shown === null ? (
        <ul className="flex animate-pulse flex-col gap-2 py-1">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-9 rounded-md bg-surface-2" />
          ))}
        </ul>
      ) : shown.length === 0 ? (
        <p className="py-3 text-sm text-fg-muted">No usage yet.</p>
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table data-testid="usage" className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-y border-edge text-left text-xs text-fg-muted">
                <th className="px-5 py-2 font-normal">Date</th>
                <th className="py-2 font-normal">Project</th>
                <th className="py-2 font-normal">Method</th>
                <th className="py-2 font-normal">Preset</th>
                <th className="py-2 text-right font-normal">Minutes</th>
                <th className="py-2 pr-4 text-right font-normal">Cost</th>
                <th className="py-2 font-normal">Paid with</th>
                <th className="py-2 pr-5 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const st = usageStatus(r);
                const paid =
                  r.paid_with === "balance" ? "Balance" : r.key_name ? `API key "${r.key_name}"` : r.paid_with;
                return (
                  <tr key={r.conversion_id} data-testid={`usage-${r.conversion_id}`} className="border-b border-edge">
                    <td className="px-5 py-2.5 text-fg-muted">{shortDate(r.at)}</td>
                    <td className="py-2.5 text-fg">{r.project}</td>
                    <td className="py-2.5 text-fg">{r.method === "lifelike" ? "Lifelike" : "Classic"}</td>
                    <td className="py-2.5 text-fg">{qualityName(r.preset)}</td>
                    <td className="py-2.5 text-right font-mono tabular-nums text-fg">{clockOf(r.minutes)}</td>
                    <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-fg">
                      {r.cost_cents === null ? "–" : formatCents(r.cost_cents)}
                    </td>
                    <td className="py-2.5">
                      <span className="flex items-center gap-2 text-fg">
                        <MethodBadge kind={badgeKind(r.key_name ? "API key" : paid)} />
                        {paid}
                      </span>
                    </td>
                    <td className={`py-2.5 pr-5 ${st.cls}`}>{st.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {hasMore ? (
        <Button variant="ghost" size="sm" className="mt-2 self-start" onClick={() => setTries((n) => n + 1)}>
          Show more
        </Button>
      ) : null}
      {entries && entries.length > 0 ? (
        <details data-testid="balance-history" className="group pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-fg">
            <ChevronDownIcon aria-hidden className="size-4 -rotate-90 text-fg-muted transition-transform group-open:rotate-0" />
            Balance history
          </summary>
          <ul className="mt-2 flex flex-col">
            {entries.map((e) => (
              <li key={e.id} className="grid grid-cols-[4rem_1fr_auto] gap-3 border-t border-edge py-2 text-sm">
                <span className="text-fg-muted">{shortDate(e.at)}</span>
                <span className="text-fg">
                  {ENTRY[e.kind]}
                  {e.detail ? ` · ${e.detail}` : ""}
                </span>
                <span className={`font-mono tabular-nums ${e.cents >= 0 ? "text-emerald-300" : "text-fg"}`}>
                  {e.cents >= 0 ? "+" : "−"}
                  {formatCents(Math.abs(e.cents))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
