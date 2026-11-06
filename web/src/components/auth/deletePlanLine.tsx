/**
 * Owner 2026-11-06: deleting an account with a plan stops its renewal (the
 * gateway sets cancel_at_period_end on delete). No automatic refunds
 * unless the person asks for one, which support reviews by hand; a cash
 * balance is still refunded as before. The confirmation says so in one
 * line, only when it applies. A plan already set to end, or a scheduled
 * step-down, gets the same line: deleting ends it at the period's end.
 */

import type { JSX } from "react";

import { supportMailto } from "@/components/billing/BillingBanner";
import { proCase } from "@/components/business/BusinessSetup";
import type { AccountPlan } from "@/lib/api/types";
import { isWebPro, type ProStatus } from "@/lib/pro/usePro";

export const APP_STORE_DELETE_LINE =
  "Pro from the App Store renews through Apple. Cancel it in your Apple ID settings.";

export type DeletePlanCase =
  | { kind: "plan"; name: "Business" | "Studio" | "Pro" }
  | { kind: "app_store" }
  | null;

/** What deleting does to the plan, or null for no plan. */
export function deletePlanCase(
  plan: AccountPlan | null | undefined,
  pro: ProStatus | null,
): DeletePlanCase {
  if (plan?.active) {
    if (plan.plan === "studio") return { kind: "plan", name: "Studio" };
    if (plan.plan === "business") return { kind: "plan", name: "Business" };
    if (plan.plan === "pro") return { kind: "plan", name: "Pro" };
  }
  if (isWebPro(pro)) return { kind: "plan", name: "Pro" };
  if (proCase(pro) === "app_store") return { kind: "app_store" };
  return null;
}

export function DeletePlanLine({ which }: { which: DeletePlanCase }): JSX.Element | null {
  if (which === null) return null;
  return (
    <p data-testid="delete-plan-line" className="text-sm text-fg">
      {which.kind === "app_store" ? (
        APP_STORE_DELETE_LINE
      ) : (
        <>
          Your {which.name} plan won&apos;t renew. Time left on it isn&apos;t refunded
          automatically. To ask for a refund,{" "}
          <a
            href={supportMailto(`Refund request · ${which.name} plan`)}
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            contact support
          </a>
          .
        </>
      )}
    </p>
  );
}
