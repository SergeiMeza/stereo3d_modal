"use client";

/**
 * The paid workspace's billing frame (projects list + workspace). Sits
 * inside RequireAuth. Spec v6: no onboarding wall — nothing saved means the
 * first paid run opens the pay sheet (P1). This only waits for the first
 * GET /v1/billing (an error fails open) and shows the account banner (P9).
 */

import { useBilling } from "@/lib/billing";

import { BillingBanner } from "./BillingBanner";

export function RequireBilling({ children }: { children: React.ReactNode }) {
  const { status, error } = useBilling();
  if (status === null && error === null) {
    return (
      <div className="flex flex-1 items-center justify-center py-24 text-fg-muted">
        Loading…
      </div>
    );
  }
  return (
    <>
      <BillingBanner />
      {children}
    </>
  );
}
