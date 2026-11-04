import { useCallback, useEffect, useState } from "react";

import { Link, paths } from "../lib/router";
import { useServices } from "../lib/services";
import type { DisputeSummary } from "../lib/types";
import { Banner } from "@/components/common";

/**
 * Open disputes and early fraud warnings in the console header, so the
 * console shows them as well as Slack (owner 2026-11-04). Counts come from
 * GET /v1/admin/disputes/summary, refreshed every 60 s and when the window
 * gets focus. Zero and errors show nothing.
 */

export const DISPUTE_POLL_MS = 60_000;
const DUE_SOON_MS = 3 * 24 * 3600e3;
/** Stripe statuses that still need our response. */
const NEEDS_RESPONSE = new Set(["needs_response", "warning_needs_response"]);

export interface DisputeAlert {
  disputes: number;
  efws: number;
  /** open disputes due within 3 days (or past due), earliest first */
  dueSoon: { count: number; by: string } | null;
}

export function alertFrom(s: DisputeSummary, now = Date.now()): DisputeAlert {
  const open = s.open ?? [];
  const efws = typeof s.open_efws === "number" && s.open_efws > 0 ? s.open_efws : 0;
  const soon = open
    .filter((d) => (!d.status || NEEDS_RESPONSE.has(d.status)) && d.due_by && Date.parse(d.due_by) - now <= DUE_SOON_MS)
    .map((d) => d.due_by as string)
    .sort();
  return { disputes: open.length, efws, dueSoon: soon.length ? { count: soon.length, by: soon[0] } : null };
}

export function useDisputeAlert(): DisputeAlert | null {
  const { api } = useServices();
  const [alert, setAlert] = useState<DisputeAlert | null>(null);
  const load = useCallback(async () => {
    try {
      setAlert(alertFrom(await api.disputes(3)));
    } catch {
      // quiet: the Disputes page shows the error when it's opened
    }
  }, [api]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), DISPUTE_POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);
  return alert;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DisputeBadge({ alert }: { alert: DisputeAlert | null }) {
  if (!alert || alert.disputes + alert.efws === 0) return null;
  const parts = [
    alert.disputes > 0 ? plural(alert.disputes, "dispute", "disputes") : "",
    alert.efws > 0 ? plural(alert.efws, "EFW", "EFWs") : "",
  ].filter(Boolean);
  return (
    <Link
      to={paths.disputes()}
      className="rounded-full border border-destructive/35 bg-destructive/10 px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-destructive-foreground tabular-nums hover:bg-destructive/20"
      aria-label={`Open: ${parts.join(", ")}`}
    >
      {parts.join(" · ")}
    </Link>
  );
}

export function DisputeDueBanner({ alert }: { alert: DisputeAlert | null }) {
  if (!alert?.dueSoon) return null;
  const { count, by } = alert.dueSoon;
  const day = new Date(by).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <Banner tone="red" action={<Link to={paths.disputes()} className="text-link hover:underline">Open disputes</Link>}>
      {count === 1 ? "1 dispute needs" : `${count} disputes need`} a response by {day}.
    </Banner>
  );
}
