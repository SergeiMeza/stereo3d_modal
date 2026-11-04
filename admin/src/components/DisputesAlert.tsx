import { Link, paths } from "../lib/router";
import type { DisputeSummary } from "../lib/types";
import { Banner } from "@/components/common";

/**
 * Open disputes and early fraud warnings, so the console shows them as well
 * as Slack (owner 2026-11-04): the Disputes nav badge and the due banner.
 * Counts come from GET /v1/admin/disputes/summary through the attention
 * provider (lib/attention.tsx), refreshed every 60 s and on focus. Zero
 * and errors show nothing.
 */

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

/** "4 disputes, 1 EFW" for the nav badge's accessible name. */
export function alertText(alert: DisputeAlert): string {
  return [
    alert.disputes > 0 ? plural(alert.disputes, "dispute", "disputes") : "",
    alert.efws > 0 ? plural(alert.efws, "EFW", "EFWs") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
