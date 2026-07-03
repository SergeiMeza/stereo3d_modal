"use client";

/**
 * Billing gate for the paid workspace (projects list + workspace). Sits
 * INSIDE RequireAuth: by the time it renders, a user is signed in and the
 * BillingProvider is fetching GET /v1/billing.
 *
 * No saved payment method → replace-redirect to /onboarding (carrying
 * ?next= back), covering both fresh sign-ups and older accounts that
 * predate pay-as-you-go. A billing fetch ERROR fails open — the gateway's
 * 402 on conversion create is the enforcement backstop; a Stripe blip must
 * not lock users out of their projects.
 *
 * Delinquent accounts pass the gate (they must reach their outputs and the
 * settle UI) — BillingBanner surfaces the outstanding charge.
 */

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { useBilling } from "@/lib/billing";

import { BillingBanner } from "./BillingBanner";

export function RequireBilling({ children }: { children: React.ReactNode }) {
  const { status, error } = useBilling();
  const router = useRouter();
  const pathname = usePathname();

  const needsOnboarding = status !== null && !status.has_payment_method;

  useEffect(() => {
    if (needsOnboarding) {
      router.replace(`/onboarding?next=${encodeURIComponent(pathname)}`);
    }
  }, [needsOnboarding, router, pathname]);

  if (status === null && error === null) {
    return (
      <div className="flex flex-1 items-center justify-center py-24 text-fg-muted">
        Checking billing…
      </div>
    );
  }
  if (needsOnboarding) return null;
  return (
    <>
      <BillingBanner />
      {children}
    </>
  );
}
