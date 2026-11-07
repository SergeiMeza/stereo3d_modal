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
import type { AccountPlan } from "@/lib/api/types";

export const NOTHING_TODAY = "Nothing is charged today.";

/** Set to end: cancel_at_period_end, or a scheduled change to pay per
 * video (gateway 00138 writes a cancel that way; older answers say
 * "none"). A step-down to another plan still renews. */
export function planEnds(plan: Pick<AccountPlan, "cancel_at_period_end" | "scheduled_change">): boolean {
  if (plan.cancel_at_period_end) return true;
  const to = plan.scheduled_change?.to;
  return to === "pay_per_video" || to === "none";
}


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

/** What comes after the current plan, in one wording for the change
 * dialog, the waiting-change card and the sheet's success (owner
 * 2026-11-05: the dialog said pay per video while the card said Pro):
 * "Your Studio stays on until Jan 10, 2027. Business starts then at $299 a
 * month." / "… Pro Monthly starts then." / "… After that you pay per
 * video." `next` null is pay per video; `cents` only when it's known. */
export function nextPlanLine(
  current: string,
  untilIso: string | null | undefined,
  next: { name: string | null; per?: string; cents?: number | null; unknown?: boolean } | null,
): string {
  const until = untilIso ? changeDate(untilIso) : "the end of this period";
  // a next plan this build can't name: say only what's certain
  if (next?.unknown) return `Your ${current} stays on until ${until}.`;
  const then =
    next === null || next.name === null
      ? "After that you pay per video."
      : typeof next.cents === "number" && next.cents > 0
        ? `${next.name} starts then at ${formatCentsShort(next.cents)}${next.per ? ` ${next.per}` : ""}.`
        : `${next.name} starts then.`;
  return `Your ${current} stays on until ${until}. ${then}`;
}

/** The change dialog's step-down line, from the preview. */
export function stepDownLine(
  current: string,
  to: { name: string | null; per?: string; unknown?: boolean } | null,
  p: PlanChangePreview,
): string {
  return nextPlanLine(current, p.effective_at, to === null ? null : { ...to, cents: p.new_plan_cents });
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

export const NOTHING_CHARGED = "Nothing was charged.";
export const QUOTE_CHANGED = "The price changed, check the new total.";
export const CARD_CONFIRM = "Your card needs confirming.";
export const CARD_DECLINED = "Your card was declined.";

/** Owner 2026-11-05: a failed change in plain words, sentence case, always
 * "Nothing was charged." (it didn't apply). The gateway's reason when it
 * gives one (its code, a decline or confirm reason in details or the
 * message), never its raw lowercase text. */
export function planChangeError(e: unknown): string {
  const code = e instanceof GatewayError ? e.code : "";
  const d = (e instanceof GatewayError ? e.details : undefined) ?? {};
  const said = [d.reason, d.decline_code, d.code, d.status, e instanceof Error ? e.message : ""]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  const confirm = d.requires_action === true || /requires_action|authenticat|confirm/.test(said);
  const declined = /declin|insufficient|card_error|do_not_honor|lost_card|stolen_card|expired_card/.test(said);
  let reason: string;
  switch (code) {
    case "quote_expired":
      reason = QUOTE_CHANGED;
      break;
    case "same_plan":
      reason = "That's already your plan.";
      break;
    case "not_renewable":
      // gateway 00155: a restored or moved plan runs to its end
      reason = e instanceof Error && e.message ? e.message : "This plan runs to its end and can't be changed.";
      break;
    case "change_scheduled":
      reason = "A change is already waiting. Take it back on Billing first.";
      break;
    case "change_on_hold":
      reason = "Plan changes are on hold for your account. Contact support.";
      break;
    case "plan_unavailable":
      reason = "That plan isn't available right now. Try again later.";
      break;
    case "no_plan":
    case "plan_unknown":
      reason = "Your plan can't be changed here.";
      break;
    case "confirm_required":
      reason = "Couldn't change your plan. Try again.";
      break;
    default:
      reason = confirm
        ? CARD_CONFIRM
        : declined
          ? CARD_DECLINED
          : code === "payment_failed"
            ? "Your payment didn't go through."
            : "Couldn't change your plan. Try again.";
  }
  return `${reason} ${NOTHING_CHARGED}`;
}

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
        return { kind: "error", message: `${QUOTE_CHANGED} ${NOTHING_CHARGED}` };
      }
    }
    return { kind: "error", message: planChangeError(e) };
  }
}
