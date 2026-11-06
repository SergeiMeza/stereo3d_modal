/**
 * Owner 2026-11-06: a plan that still renews must be cancelled before the
 * account can be deleted (the gateway answers 409 plan_renewing {plan,
 * current_period_end}). A cancelled plan stays valid to its end date, and
 * a new account with the same email can restore it. A scheduled step-down
 * still renews. App Store Pro renews through Apple, which the web can't
 * stop. No plan, nothing to say.
 */

import Link from "next/link";
import type { JSX } from "react";

import { longDate } from "@/components/billing/PlanCard";
import { proCase } from "@/components/business/BusinessSetup";
import { Button } from "@/components/ui/button";
import type { AccountPlan } from "@/lib/api/types";
import { isWebPro, type ProStatus } from "@/lib/pro/usePro";

export const APP_STORE_DELETE_LINE =
  "Pro from the App Store renews through Apple. Cancel it in your Apple ID settings.";

/** Plan & billing with the cancel confirmation open (PlanChangeMenu). */
export const CANCEL_PLAN_HREF = "/account/billing?cancel=1";

type PlanName = "Business" | "Studio" | "Pro";

export type DeletePlanState =
  | { kind: "renewing"; name: PlanName; until: string | null }
  | { kind: "ending"; name: PlanName; until: string | null }
  | { kind: "app_store" }
  | null;

function nameOf(plan: string | undefined): PlanName | null {
  if (plan === "studio") return "Studio";
  if (plan === "business") return "Business";
  if (plan === "pro" || plan?.startsWith("pro_")) return "Pro";
  return null;
}

/** What the plan means for deleting, or null for no plan. */
export function deletePlanState(
  plan: AccountPlan | null | undefined,
  pro: ProStatus | null,
): DeletePlanState {
  const name = plan?.active ? nameOf(plan.plan) : null;
  if (plan && name) {
    const until = plan.current_period_end ?? null;
    return plan.cancel_at_period_end ? { kind: "ending", name, until } : { kind: "renewing", name, until };
  }
  if (isWebPro(pro)) {
    const until = pro?.renews_at ?? pro?.ends_at ?? null;
    return pro?.ends_at && !pro.renews_at ? { kind: "ending", name: "Pro", until } : { kind: "renewing", name: "Pro", until };
  }
  if (proCase(pro) === "app_store") return { kind: "app_store" };
  return null;
}

/** The gateway's 409 plan_renewing, as a state (when the page's data was stale). */
export function renewingFromGateway(details: Record<string, unknown> | undefined): DeletePlanState {
  const until = typeof details?.current_period_end === "string"
    ? details.current_period_end
    : typeof details?.renews_at === "string"
      ? details.renews_at
      : null;
  const name = nameOf(typeof details?.plan === "string" ? details.plan : undefined) ?? "Pro";
  return { kind: "renewing", name, until };
}

export function DeletePlanNotice({ state }: { state: DeletePlanState }): JSX.Element | null {
  if (state === null) return null;
  if (state.kind === "app_store") {
    return (
      <p data-testid="delete-plan-line" className="text-sm text-fg">
        {APP_STORE_DELETE_LINE}
      </p>
    );
  }
  const until = state.until ? longDate(state.until) : null;
  if (state.kind === "ending") {
    return (
      <p data-testid="delete-plan-line" className="text-sm text-fg">
        {until
          ? `Your ${state.name} plan stays valid until ${until}.`
          : `Your ${state.name} plan stays valid until the end of its period.`}{" "}
        If you sign up again with this email, you can restore it.
      </p>
    );
  }
  return (
    <div data-testid="delete-plan-renewing" className="flex flex-wrap items-center gap-3 text-sm">
      <p className="min-w-0 flex-1 text-fg">
        Cancel your plan first.{until ? ` It stays valid until ${until}.` : ""}
      </p>
      <Button asChild size="sm" variant="outline">
        <Link href={CANCEL_PLAN_HREF}>Cancel plan</Link>
      </Button>
    </div>
  );
}
