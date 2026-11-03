"use client";

/**
 * P11 Limits notice (spec v6 B14): an account that hasn't paid or saved a
 * payment method keeps up to 3 projects and 10 GB of uploads. Inline on
 * Projects and in the upload box once the gateway says the limit is
 * reached (GET /v1/billing `limits`, or a 403 save_method_for_more).
 */

import type { JSX } from "react";

import { openCardUpdate } from "@/components/billing/BillingBanner";
import { useGateway } from "@/lib/api/useGateway";
import { useBilling } from "@/lib/billing";

export const LIMITS_LINE =
  "Make your first 3D video or save a payment method to keep more than 3 projects and 10 GB of uploads.";

/** true when the account may not add another project or upload. */
export function useLimitsReached(): boolean {
  const l = useBilling().status?.limits;
  return l !== undefined && (l.reached === true || l.projects_left <= 0 || l.bytes_left <= 0);
}

export function LimitsNotice({ force = false }: { force?: boolean }): JSX.Element | null {
  const reached = useLimitsReached();
  const gateway = useGateway();
  if (!reached && !force) return null;
  return (
    <p
      data-testid="limits-notice"
      className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-fg"
    >
      {LIMITS_LINE}{" "}
      <button
        type="button"
        onClick={() => void openCardUpdate(gateway)}
        className="font-medium text-primary hover:underline"
      >
        Add payment method
      </button>
    </p>
  );
}
