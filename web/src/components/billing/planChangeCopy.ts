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
import { EN, type Tr } from "@/lib/i18n/t";

/** English, for callers and tests without a translator. */
export const NOTHING_TODAY = EN("billing.planChange.nothingToday");

/** Set to end: cancel_at_period_end, or a scheduled change to pay per
 * video (gateway 00138 writes a cancel that way; older answers say
 * "none"). A step-down to another plan still renews. */
export function planEnds(plan: Pick<AccountPlan, "cancel_at_period_end" | "scheduled_change">): boolean {
  if (plan.cancel_at_period_end) return true;
  const to = plan.scheduled_change?.to;
  return to === "pay_per_video" || to === "none";
}


/** "Jan 10, 2027" */
export function changeDate(iso: string, t: Tr = EN): string {
  return new Date(iso).toLocaleDateString(t.intl, {
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
  t: Tr = EN,
): string {
  const unused = p.unused_credit_cents ?? 0;
  const today = t("billing.planChange.today", { amount: formatCents(p.today_cents, t) });
  const newPlan = formatCents(p.new_plan_cents, t);
  return unused > 0
    ? t("billing.planChange.upgradeWithCredit", { today, to: names.to, newPlan, unused: formatCents(unused, t), from: names.from })
    : t("billing.planChange.upgrade", { today, to: names.to, newPlan });
}

export const CREDIT_RULE = EN("billing.planChange.creditRule");

/** "Your remaining Business usage this month ends when Studio's $1,500
 * starts." — a plan with monthly usage moving to another. */
export function usageHandoverLine(
  from: string,
  to: string,
  toCreditCents: number,
  t: Tr = EN,
): string {
  return t("billing.planChange.usageHandover", { from, to, amount: formatCentsShort(toCreditCents, t) });
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
  t: Tr = EN,
): string {
  const until = untilIso ? changeDate(untilIso, t) : t("billing.planChange.endOfPeriod");
  const stays = t("billing.planChange.staysOn", { current, until });
  // a next plan this build can't name: say only what's certain
  if (next?.unknown) return stays;
  const then =
    next === null || next.name === null
      ? t("billing.planChange.afterPayPerVideo")
      : typeof next.cents === "number" && next.cents > 0
        ? next.per
          ? t("billing.planChange.startsThenAtPer", { name: next.name, amount: formatCentsShort(next.cents, t), per: next.per })
          : t("billing.planChange.startsThenAt", { name: next.name, amount: formatCentsShort(next.cents, t) })
        : t("billing.planChange.startsThen", { name: next.name });
  return `${stays} ${then}`;
}

/** The change dialog's step-down line, from the preview. */
export function stepDownLine(
  current: string,
  to: { name: string | null; per?: string; unknown?: boolean } | null,
  p: PlanChangePreview,
  t: Tr = EN,
): string {
  return nextPlanLine(current, p.effective_at, to === null ? null : { ...to, cents: p.new_plan_cents }, t);
}

export function isStepDown(p: PlanChangePreview): boolean {
  return p.kind === "step_down";
}

export type ConfirmOutcome =
  | { kind: "done" }
  | { kind: "repriced"; preview: PlanChangePreview }
  | { kind: "error"; message: string };

/** Shown when the quote ran out and the price was worked out again. */
export const REPRICED = EN("billing.planChange.repriced");

export const NOTHING_CHARGED = EN("billing.planChange.nothingCharged");
export const QUOTE_CHANGED = EN("billing.planChange.quoteChanged");
export const CARD_CONFIRM = EN("billing.planChange.cardConfirm");
export const CARD_DECLINED = EN("billing.planChange.cardDeclined");

/** Owner 2026-11-05: a failed change in plain words, sentence case, always
 * "Nothing was charged." (it didn't apply). The gateway's reason when it
 * gives one (its code, a decline or confirm reason in details or the
 * message), never its raw lowercase text. */
export function planChangeError(e: unknown, t: Tr = EN): string {
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
      reason = t("billing.planChange.quoteChanged");
      break;
    case "same_plan":
      reason = t("billing.planChange.errors.samePlan");
      break;
    case "not_renewable":
      // gateway 00155: a restored or moved plan runs to its end
      reason = e instanceof Error && e.message ? e.message : t("billing.planChange.errors.notRenewable");
      break;
    case "change_scheduled":
      reason = t("billing.planChange.errors.changeScheduled");
      break;
    case "change_on_hold":
      reason = t("billing.planChange.errors.changeOnHold");
      break;
    case "plan_unavailable":
      reason = t("billing.planChange.errors.planUnavailable");
      break;
    case "no_plan":
    case "plan_unknown":
      reason = t("billing.planChange.errors.cantChangeHere");
      break;
    case "confirm_required":
      reason = t("billing.planChange.errors.tryAgain");
      break;
    default:
      reason = confirm
        ? t("billing.planChange.cardConfirm")
        : declined
          ? t("billing.planChange.cardDeclined")
          : code === "payment_failed"
            ? t("billing.planChange.errors.paymentFailed")
            : t("billing.planChange.errors.tryAgain");
  }
  return `${reason} ${t("billing.planChange.nothingCharged")}`;
}

/** POST /v1/plans/change with the preview's quote_at. A 409 quote_expired
 * previews again and hands back the new amount to confirm; 402
 * payment_failed and the 409s (same_plan, change_on_hold,
 * change_scheduled) come back as the gateway's words. */
export async function confirmPlanChange(
  gateway: Pick<GatewayClient, "changePlan" | "previewPlanChange">,
  preview: PlanChangePreview,
  t: Tr = EN,
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
        return { kind: "error", message: `${t("billing.planChange.quoteChanged")} ${t("billing.planChange.nothingCharged")}` };
      }
    }
    return { kind: "error", message: planChangeError(e, t) };
  }
}
