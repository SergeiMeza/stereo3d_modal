/**
 * Plan change copy (owner 2026-11-04), from POST /v1/plans/preview-change:
 * - upgrade: "Today: $X (new plan $A − $B for your unused Pro days).
 *   Renews on <date>."
 * - step-down (at the end of the paid period): "Your Studio stays on until
 *   Jan 10, 2027. Business starts then at $299 a month." plus "Nothing is
 *   charged today."
 */

import { formatCents, formatCentsShort } from "@/components/steps/money";
import type { PlanChangePreview } from "@/lib/api/client";

export const NOTHING_TODAY = "Nothing is charged today.";

/** "Jan 10, 2027" */
export function changeDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function upgradeLine(p: PlanChangePreview): string {
  const unused = p.unused_credit_cents ?? 0;
  const renews = p.renews_at ? ` Renews on ${changeDate(p.renews_at)}.` : "";
  return unused > 0
    ? `Today: ${formatCents(p.today_cents)} (new plan ${formatCents(p.new_plan_cents)} − ${formatCents(unused)} for your unused Pro days).${renews}`
    : `Today: ${formatCents(p.today_cents)}.${renews}`;
}

/** "Your Studio stays on until Jan 10, 2027. Business starts then at $299
 * a month." — or "After that you pay per video." */
export function stepDownLine(
  current: string,
  to: { name: string; per?: string } | null,
  p: PlanChangePreview,
): string {
  const until = p.effective_at
    ? changeDate(p.effective_at)
    : "the end of this period";
  const next =
    to === null
      ? "After that you pay per video."
      : `${to.name} starts then at ${formatCentsShort(p.new_plan_cents)}${to.per ? ` ${to.per}` : ""}.`;
  return `Your ${current} stays on until ${until}. ${next}`;
}

export function isStepDown(p: PlanChangePreview): boolean {
  return p.kind === "step_down";
}
