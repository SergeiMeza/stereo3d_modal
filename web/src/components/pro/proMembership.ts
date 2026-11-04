/**
 * QA 2026-11-05: what a Pro member's /pro says about their Pro, from
 * GET /v1/pro (and, for web Pro, the plan block on GET /v1/billing): where
 * it comes from, its period, when it renews or ends when that's known,
 * and where to manage it. A source the gateway doesn't name (missing or
 * "unknown") gets a generic line.
 */

import type { AccountPlan } from "@/lib/api/types";
import { isStripePro, proSourceKind, type ProStatus } from "@/lib/pro/usePro";

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

/** " Renews on 5 Dec 2026." / " Ends on …", or "" when unknown. */
function whenLine(renews: string | null | undefined, ends: string | null | undefined): string {
  const end = longDate(ends ?? undefined);
  if (end) return ` Ends on ${end}.`;
  const renew = longDate(renews ?? undefined);
  return renew ? ` Renews on ${renew}.` : "";
}

/** /pro for a member whose Pro we can't place (QA batch 3). */
export const PRO_UNKNOWN_LINE = "Pro is active. Manage it where you bought it.";

/** The line, and where it's managed; null when there's nothing to say
 * (not Pro, Pro included with Business or Studio, a simulated Pro). From
 * GET /v1/pro's source, period, renews_at/ends_at (QA batch 3), and for
 * web Pro the plan block on GET /v1/billing. */
export function proMembership(
  status: ProStatus | null | undefined,
  plan: AccountPlan | null | undefined,
): { text: string; manage: ManageAt } | null {
  const kind = proSourceKind(status);
  if (kind === null || kind === "team" || kind === "simulated") return null;
  const s = status!;
  if (kind === "web" || isStripePro(s, plan)) {
    const billingPlan = plan?.plan === "pro" ? plan : null;
    const period =
      periodWord(billingPlan?.plan_id) ?? periodWord(s.period) ?? periodWord(s.plan_id ?? s.via);
    const when = billingPlan?.current_period_end
      ? whenLine(billingPlan.cancel_at_period_end ? null : billingPlan.current_period_end, billingPlan.cancel_at_period_end ? billingPlan.current_period_end : null)
      : whenLine(s.renews_at, s.ends_at);
    return { text: `Pro${period ? ` ${period}` : ""} on the web.${when}`, manage: "billing" };
  }
  if (kind === "app_store" || kind === "mac_app_store") {
    const period = periodWord(s.period) ?? periodWord(s.via);
    const store = kind === "mac_app_store" ? "the Mac App Store" : "the App Store";
    return { text: `Pro${period ? ` ${period}` : ""} through ${store}.${whenLine(s.renews_at, s.ends_at)}`, manage: "apple" };
  }
  if (kind === "grant") {
    return {
      text: `Pro given to your account by Spatial Video Studio, at no charge.${whenLine(null, s.ends_at)}`,
      manage: null,
    };
  }
  return { text: PRO_UNKNOWN_LINE, manage: null };
}
