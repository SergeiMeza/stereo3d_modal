"use client";

/**
 * Business nudge C (plans canvas, 2026-11-04): a "Talk to us" banner on
 * Projects, only for company email addresses (not gmail, outlook, icloud,
 * yahoo, qq, 163… — PERSONAL_DOMAINS), and not for Business or Studio.
 * Talk to us opens a small form (message, company, team size) that posts
 * to POST /v1/contact (gateway 00094); a person replies to the account's
 * email. A mailto with the same words only when the route itself fails
 * (network, 404, 5xx); 400 and 429 show the gateway's message. Dismissed
 * for 30 days (kept on the account).
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { formatCentsShort } from "@/components/steps/money";
import { ContactSalesForm } from "./ContactSalesForm";
import { NUDGE_SURFACE, PlanNudge } from "./PlanNudge";
import { companyAtom, loadCompanyAtom } from "@/components/billing/billingHistoryAtoms";
import { prepaidOf } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { usePricing } from "@/lib/api/usePricing";
import { useAuth } from "@/lib/auth";
import { billingUidAtom, useBilling } from "@/lib/billing";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import {
  isCompanyEmail,
  type SurfaceReason,
  useDismissal,
  usePaywallEvents,
  usePlanTier,
  useViewEvent,
} from "./upsell";

/** A month's spend that looks like Business work (half its usage). */
export const BUSINESS_SIZED_CENTS = 20_000;

/** Whether the account looks like a business (owner 2026-11-05): a
 * company email, business details saved, or Business-sized usage. null
 * while unknown. */
export function useBusinessReason(): SurfaceReason | null {
  const { user } = useAuth();
  const gateway = useGateway();
  const company = useAppAtomValue(companyAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const loadCompany = useAppSetAtom(loadCompanyAtom);
  const status = useBilling().status;
  useEffect(() => {
    if (uid !== null) void loadCompany(gateway);
  }, [loadCompany, gateway, uid]);
  if (isCompanyEmail(user?.email)) return "company_email";
  const details = company.uid === uid ? company.company : null;
  if (details?.company_name?.trim()) return "business_details";
  if ((prepaidOf(status)?.month_spent_cents ?? 0) >= BUSINESS_SIZED_CENTS) return "business_usage";
  return null;
}

/** The Business nudge shows: true, false, or null while unknown. */
export function useBusinessNudgeShown(): boolean | null {
  const tier = usePlanTier();
  const biz = usePricing()?.plans?.business;
  const { dismissed } = useDismissal("business_banner", 30);
  const reason = useBusinessReason();
  if (tier === null || dismissed === null) return null;
  return (tier === "none" || tier === "pro") && dismissed === false && reason !== null && !!biz;
}

export function TalkToUs(): JSX.Element | null {
  const { user } = useAuth();
  const tier = usePlanTier();
  const biz = usePricing()?.plans?.business;
  const { dismiss } = useDismissal("business_banner", 30);
  const [step, setStep] = useState<"banner" | "form" | "sent">("banner");
  const shown = useBusinessNudgeShown() === true;
  const reason = useBusinessReason() ?? "company_email";
  useViewEvent("business_banner", tier, shown, {
    variant: "talk_to_us",
    reason,
  });
  const send = usePaywallEvents("business_banner", tier, {
    variant: "talk_to_us",
    reason,
  });
  // the form and its thanks stay once opened
  if ((!shown && step === "banner") || !biz) return null;

  const onDismiss = () => {
    send("dismiss");
    dismiss();
  };
  if (step === "banner") {
    return (
      <PlanNudge
        testId="talk-to-us"
        text={
          <>
            Using Spatial Video Studio at work? Business gives you {formatCentsShort(biz.credit_cents)} of usage a month,
            commercial use and invoices.
          </>
        }
        action={{
          label: "Talk to us",
          testId: "talk-to-us-open",
          onClick: () => {
            send("click", { target: "talk" });
            setStep("form");
          },
        }}
        link={{ label: "See Business", href: "/plans", onClick: () => send("click", { target: "/plans" }) }}
        onDismiss={onDismiss}
      />
    );
  }
  return (
    <section data-testid="talk-to-us" className={`flex flex-col gap-3 ${NUDGE_SURFACE}`}>
      {step === "form" ? (
        <ContactSalesForm
          onSent={() => setStep("sent")}
          onCancel={() => setStep("banner")}
          onSend={() => send("click", { target: "send" })}
        />
      ) : (
        <p data-testid="talk-to-us-sent" className="text-fg">
          Thanks. We&apos;ll reply to {user?.email ?? "your account email"}.
        </p>
      )}
    </section>
  );
}
