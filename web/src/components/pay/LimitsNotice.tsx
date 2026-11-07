"use client";

/**
 * P11 Limits notice (spec v6 B14): an account that hasn't paid or saved a
 * payment method keeps up to 3 projects and 10 GB of uploads. Inline on
 * Projects and in the upload box once the gateway says the limit is
 * reached (GET /v1/billing `limits`, or a 403 save_method_for_more).
 * Add payment method opens P15.
 */

import { useState } from "react";
import type { JSX } from "react";

import { useBilling } from "@/lib/billing";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN } from "@/lib/i18n/t";

import { AddMethodSheet } from "./AddMethodSheet";

export const LIMITS_LINE = EN("pay.limits.line");

/** true when the account may not add another project or upload. */
export function useLimitsReached(): boolean {
  const l = useBilling().status?.limits;
  return l !== undefined && (l.reached === true || l.projects_left <= 0 || l.bytes_left <= 0);
}

export function LimitsNotice({ force = false }: { force?: boolean }): JSX.Element | null {
  const reached = useLimitsReached();
  const billing = useBilling();
  const t = useT();
  const [adding, setAdding] = useState(false);
  if (!reached && !force) return null;
  return (
    <p
      data-testid="limits-notice"
      className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-fg"
    >
      {t("pay.limits.line")}{" "}
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="font-medium text-primary hover:underline"
      >
        {t("pay.limits.addMethod")}
      </button>
      {adding ? (
        <AddMethodSheet
          first={!billing.status?.has_payment_method}
          onClose={(saved) => {
            setAdding(false);
            if (saved) void billing.refresh();
          }}
        />
      ) : null}
    </p>
  );
}
