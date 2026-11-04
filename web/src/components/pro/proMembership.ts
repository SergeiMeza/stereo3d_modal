/**
 * QA 2026-11-05: what a Pro member's /pro says about their Pro, from
 * GET /v1/pro (and, for web Pro, the plan block on GET /v1/billing): where
 * it comes from, its period, when it renews or ends when that's known,
 * and where to manage it. GET /v1/pro carries no renewal or end date for
 * an App Store Pro or a grant, so those lines name none.
 */

import type { AccountPlan } from "@/lib/api/types";
import { isWebPro, type ProStatus } from "@/lib/pro/usePro";

export type ManageAt = "billing" | "apple" | null;

/** "Monthly" from a product or plan id (pro_monthly, pro_subs_1y_v1…). */
export function periodWord(id: string | null | undefined): string | null {
  const s = (id ?? "").toLowerCase();
  if (/(^|_)(1y|12m|yearly|year|annual)(_|$)/.test(s)) return "Yearly";
  if (/(^|_)(1m|monthly|month)(_|$)/.test(s)) return "Monthly";
  if (/(^|_)(1w|weekly|week)(_|$)/.test(s)) return "Weekly";
  return null;
}

function longDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** The line, and where it's managed; null when there's nothing to say
 * (not Pro, Pro included with Business or Studio, a simulated Pro). */
export function proMembership(
  status: ProStatus | null | undefined,
  plan: AccountPlan | null | undefined,
): { text: string; manage: ManageAt } | null {
  if (!status?.pro) return null;
  const src = status.source ?? "";
  if (isWebPro(status)) {
    const period = periodWord(plan?.plan === "pro" ? plan.plan_id : null) ?? periodWord(status.plan_id ?? status.via);
    const date = plan?.plan === "pro" ? longDate(plan.current_period_end) : null;
    const when = date ? (plan?.cancel_at_period_end ? ` Ends on ${date}.` : ` Renews on ${date}.`) : "";
    return { text: `Pro${period ? ` ${period}` : ""} on the web.${when}`, manage: "billing" };
  }
  if (src === "app_store" || src === "mac_app_store") {
    const period = periodWord(status.via);
    const store = src === "mac_app_store" ? "the Mac App Store" : "the App Store";
    return { text: `Pro${period ? ` ${period}` : ""} through ${store}.`, manage: "apple" };
  }
  if (src === "promotional") {
    return { text: "Pro given to your account by Spatial Video Studio, at no charge.", manage: null };
  }
  return null;
}
