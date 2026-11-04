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

import { X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { JSX } from "react";

import { formatCentsShort } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import { ContactSalesForm } from "./ContactSalesForm";
import { usePricing } from "@/lib/api/usePricing";
import { useAuth } from "@/lib/auth";

import {
  isCompanyEmail,
  useDismissal,
  usePaywallEvents,
  usePlanTier,
  useViewEvent,
} from "./upsell";

export function TalkToUs(): JSX.Element | null {
  const { user } = useAuth();
  const tier = usePlanTier();
  const biz = usePricing()?.plans?.business;
  const { dismissed, dismiss } = useDismissal("business_banner", 30);
  const [step, setStep] = useState<"banner" | "form" | "sent">("banner");
  const show =
    (tier === "none" || tier === "pro") &&
    dismissed === false &&
    isCompanyEmail(user?.email) &&
    !!biz;
  useViewEvent("business_banner", tier, show, {
    variant: "talk_to_us",
    reason: "company_email",
  });
  const send = usePaywallEvents("business_banner", tier, {
    variant: "talk_to_us",
    reason: "company_email",
  });
  if (!show || !biz) return null;

  return (
    <section
      data-testid="talk-to-us"
      className="flex flex-col gap-3 rounded-lg border border-edge bg-surface-1 px-4 py-3 text-sm"
    >
      {step === "banner" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-60 flex-1 text-fg">
            Using Spatial Video Studio at work? Business gives you{" "}
            {formatCentsShort(biz.credit_cents)} of usage a month, commercial
            use and invoices.
          </p>
          <Button
            size="sm"
            data-testid="talk-to-us-open"
            onClick={() => {
              send("click", { target: "talk" });
              setStep("form");
            }}
          >
            Talk to us
          </Button>
          <Link
            href="/plans"
            onClick={() => send("click", { target: "/plans" })}
            className="text-primary hover:underline"
          >
            See Business
          </Link>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              send("dismiss");
              dismiss();
            }}
            className="rounded p-0.5 text-fg-muted hover:text-fg"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ) : step === "form" ? (
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
