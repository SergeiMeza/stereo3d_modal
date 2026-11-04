/**
 * Plan change copy (owner 2026-11-04), from POST /v1/plans/preview-change:
 * - upgrade: "Today: $X (new plan $A − $B for your unused Pro days).
 *   Renews on <date>."
 * - step-down (at the end of the paid period): "Your Studio stays on until
 *   Jan 10, 2027. Business starts then at $299 a month." plus "Nothing is
 *   charged today."
 */

import { formatCents, formatCentsShort } from "@/components/steps/money";
import { GatewayError } from "@/lib/api/client";
import type { GatewayClient, PlanChangePreview } from "@/lib/api/client";

export const NOTHING_TODAY = "Nothing is charged today.";

/** "Jan 10, 2027" */
export function changeDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Today: $11,950.62. Studio $11,988.00 − $37.38 for your unused
 * Business." — every number from the preview. */
export function upgradeLine(
  p: PlanChangePreview,
  names: { from: string; to: string },
): string {
  const unused = p.unused_credit_cents ?? 0;
  const today = `Today: ${formatCents(p.today_cents)}.`;
  return unused > 0
    ? `${today} ${names.to} ${formatCents(p.new_plan_cents)} − ${formatCents(unused)} for your unused ${names.from}.`
    : `${today} ${names.to} ${formatCents(p.new_plan_cents)}.`;
}

export const CREDIT_RULE =
  "We credit what you paid for the time and usage you have left, whichever is smaller.";

/** "Your remaining Business usage this month ends when Studio's $1,500
 * starts." — a plan with monthly usage moving to another. */
export function usageHandoverLine(
  from: string,
  to: string,
  toCreditCents: number,
): string {
  return `Your remaining ${from} usage this month ends when ${to}'s ${formatCentsShort(toCreditCents)} starts.`;
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

export type ConfirmOutcome =
  | { kind: "done" }
  | { kind: "repriced"; preview: PlanChangePreview }
  | { kind: "error"; message: string };

/** Shown when the quote ran out and the price was worked out again. */
export const REPRICED = "The price was updated. Check it and confirm again.";

/** POST /v1/plans/change with the preview's quote_at. A 409 quote_expired
 * previews again and hands back the new amount to confirm; 402
 * payment_failed and the 409s (same_plan, change_on_hold,
 * change_scheduled) come back as the gateway's words. */
export async function confirmPlanChange(
  gateway: Pick<GatewayClient, "changePlan" | "previewPlanChange">,
  preview: PlanChangePreview,
): Promise<ConfirmOutcome> {
  try {
    await gateway.changePlan(preview.to, preview.quote_at);
    return { kind: "done" };
  } catch (e) {
    if (e instanceof GatewayError && e.code === "quote_expired") {
      try {
        return {
          kind: "repriced",
          preview: await gateway.previewPlanChange(preview.to),
        };
      } catch {
        return {
          kind: "error",
          message: "Couldn't work out the new price. Nothing was charged.",
        };
      }
    }
    if (e instanceof GatewayError && e.code === "payment_failed") {
      return {
        kind: "error",
        message:
          e.message || "Your payment didn't go through. Nothing changed.",
      };
    }
    return {
      kind: "error",
      message:
        e instanceof GatewayError && e.message
          ? e.message
          : "Couldn't change your plan. Nothing was charged.",
    };
  }
}
