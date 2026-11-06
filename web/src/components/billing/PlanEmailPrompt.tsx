"use client";

/**
 * "Add an email for your plan" (gateway 00152, EM-03): a Business or
 * Studio plan needs a real main email (receipts, Restore Purchases), never
 * a hidden Apple address. Shown while GET /v1/account/emails says
 * plan_email_needed — on the plan card, on Account, and in the plan
 * checkout's success step — until it's done; the plan works meanwhile.
 */

import { useEffect } from "react";
import type { JSX } from "react";

import { AddEmailForm } from "@/components/auth/AddEmailForm";
import { emailsAtom, loadEmailsAtom } from "@/components/auth/emailAtoms";
import { useGateway } from "@/lib/api/useGateway";
import { billingUidAtom } from "@/lib/billing";
import { isAppleRelayEmail } from "@/lib/emailCode";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

export const PLAN_EMAIL_TITLE = "Add an email for your plan";

/** Shows itself only while the plan needs an email (`load` reads the list
 * when nothing else has). */
export function PlanEmailPrompt({ prefill, load = false }: { prefill?: string | null; load?: boolean }): JSX.Element | null {
  const gateway = useGateway();
  const uid = useAppAtomValue(billingUidAtom);
  const state = useAppAtomValue(emailsAtom);
  const loadEmails = useAppSetAtom(loadEmailsAtom);
  useEffect(() => {
    if (load && uid !== null) void loadEmails(gateway);
  }, [load, uid, gateway, loadEmails]);
  const data = state.uid === uid ? state.data : null;
  if (!data?.plan_email_needed) return null;
  const start = prefill && !isAppleRelayEmail(prefill) ? prefill : "";
  return (
    <div data-testid="plan-email-prompt" className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
      <p className="text-sm font-medium text-fg">{PLAN_EMAIL_TITLE}</p>
      <p className="text-xs text-fg-muted">
        Receipts and Restore Purchases use it. A hidden Apple address won&apos;t do. Your plan works meanwhile.
      </p>
      <AddEmailForm idPrefix="plan-email" mainChoice={false} forPlan prefill={start} submitLabel="Use this email" />
    </div>
  );
}
