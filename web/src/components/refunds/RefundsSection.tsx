"use client";

/**
 * Refunds on Billing (owner 2026-11-06; quieter since 2026-11-07): a muted
 * line at the bottom with "Request a refund" (RefundSheet), the account's
 * requests with their status in plain words and a reply when we asked a
 * question (or a follow-up on a closed one), and a notice at the top only
 * while a question waits. Each row's menu asks about its own payment. App
 * Store Pro is refunded by Apple: "Ask Apple for a refund".
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { proCase } from "@/components/business/BusinessSetup";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import type { SupportRequest } from "@/lib/api/client";
import { useGateway } from "@/lib/api/useGateway";
import { billingUidAtom } from "@/lib/billing";
import { useProStatus } from "@/lib/pro/usePro";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import {
  loadRefundOptionsAtom,
  loadSupportRequestsAtom,
  NOTE_MAX,
  openRefundSheetAtom,
  refundOptionsAtom,
  replyToRequestAtom,
  supportRequestsAtom,
} from "./refundAtoms";
import { RefundSheet, shortDay } from "./RefundSheet";

export const APPLE_REFUND_URL = "https://reportaproblem.apple.com";

const ABOUT: Record<SupportRequest["about"], string> = {
  plan: "Plan payment",
  runs: "Runs",
  balance: "Balance",
  other: "Request",
};

/** Loads what can be refunded and the account's requests (ADR 0138: the
 * shared atoms, also read by each Billing row's menu). */
function useRefundData() {
  const gateway = useGateway();
  const uid = useAppAtomValue(billingUidAtom);
  const options = useAppAtomValue(refundOptionsAtom);
  const requests = useAppAtomValue(supportRequestsAtom);
  const loadOptions = useAppSetAtom(loadRefundOptionsAtom);
  const loadRequests = useAppSetAtom(loadSupportRequestsAtom);
  useEffect(() => {
    if (uid === null) return;
    void loadOptions(gateway);
    void loadRequests(gateway);
  }, [uid, gateway, loadOptions, loadRequests]);
  return {
    opts: options.uid === uid ? options.data : null,
    list: requests.uid === uid ? requests.data : null,
  };
}

/** Owner 2026-11-07: the only refund line above the fold — we asked a
 * question about a request and it needs the customer's answer. */
export function RefundQuestionNotice(): JSX.Element | null {
  const uid = useAppAtomValue(billingUidAtom);
  const requests = useAppAtomValue(supportRequestsAtom);
  const list = requests.uid === uid ? requests.data : null;
  const asked = list?.find((r) => r.state === "asked");
  if (!asked) return null;
  return (
    <p data-testid="refund-question-notice" role="status" className="text-sm text-amber-200">
      We asked a question about your refund request.{" "}
      <a
        href={`#request-${asked.id}`}
        onClick={(e) => {
          e.preventDefault();
          document.getElementById(`request-${asked.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        Answer it
      </a>
    </p>
  );
}

/** Billing's bottom (owner 2026-11-07): refunds, quietly — one muted line
 * with a text link, the App Store line, and Your requests when there are
 * any. The sheet stays mounted here. */
export function RefundsFooter(): JSX.Element {
  const { opts, list } = useRefundData();
  const openSheet = useAppSetAtom(openRefundSheetAtom);
  const pro = useProStatus();
  const plan = opts?.plan ?? null;
  const askable = (plan !== null && plan.open_request_id === null) || (opts?.runs ?? []).some((r) => r.open_request_id === null);
  const appStore = proCase(pro) === "app_store";
  const days = opts?.window_days ?? 30;

  return (
    <footer data-testid="refunds" aria-label="Refunds" className="flex flex-col gap-3 text-xs text-fg-muted">
      <p data-testid="refunds-line">
        {askable ? (
          <>
            Need a refund?{" "}
            <button
              type="button"
              data-testid="refunds-request"
              onClick={() => openSheet()}
              className="text-primary underline underline-offset-2 hover:text-primary/80"
            >
              Request a refund
            </button>
            {" · "}ask within {days} days of a payment, also after cancelling. A person reviews every request.
          </>
        ) : (
          <>Ask for a refund within {days} days of a payment, also after cancelling. A person reviews every request.</>
        )}
      </p>
      {appStore ? (
        <p data-testid="refund-app-store">
          Pro from the App Store is refunded by Apple.{" "}
          <a href={APPLE_REFUND_URL} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
            Ask Apple for a refund
          </a>
        </p>
      ) : null}
      {list !== null && list.length > 0 ? (
        <div className="flex flex-col gap-2 text-sm">
          <h2 className="text-xs font-medium text-fg-muted">Your requests</h2>
          <ul data-testid="support-requests" className="divide-y divide-edge rounded-lg border border-edge bg-surface-1">
            {list.map((r) => (
              <RequestRow key={r.id} request={r} />
            ))}
          </ul>
        </div>
      ) : null}
      <RefundSheet />
    </footer>
  );
}

function RequestRow({ request: r }: { request: SupportRequest }): JSX.Element {
  const gateway = useGateway();
  const reply = useAppSetAtom(replyToRequestAtom);
  const asked = r.state === "asked";
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = r.state === "refunded" || r.state === "not_refunded" || r.state === "waived" || r.state === "closed";

  async function send(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await reply({ client: gateway, id: r.id, text });
      setText("");
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't send that. Try again in a while.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li id={`request-${r.id}`} data-testid={`request-${r.id}`} className="flex scroll-mt-24 flex-col gap-2 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-fg">{ABOUT[r.about] ?? "Request"}</span>
        <span className="text-xs text-fg-muted">{shortDay(r.opened_at)}</span>
        {typeof r.requested_cents === "number" && r.requested_cents > 0 ? (
          <span className="text-xs text-fg-muted tabular-nums">{formatCents(r.requested_cents)}</span>
        ) : null}
        <span data-testid="request-status" className={`ml-auto text-xs ${asked ? "text-amber-300" : "text-fg"}`}>
          {r.status}
          {r.state === "refunded" && (r.refunded_cents ?? 0) > 0 ? ` · ${formatCents(r.refunded_cents!)}` : ""}
        </span>
      </div>
      {asked && r.question ? (
        <p data-testid="request-question" className="rounded-md bg-surface-2 px-3 py-2 text-fg">
          {r.question}
        </p>
      ) : null}
      {open || asked ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={asked ? "Your answer" : "Your message"}
            value={text}
            maxLength={NOTE_MAX}
            rows={3}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-primary/60"
          />
          {error !== null && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>
              {busy ? "Sending…" : asked ? "Send answer" : "Send"}
            </Button>
            {!asked ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="self-start text-xs text-primary hover:underline">
          {done ? "Ask about this again" : "Add a message"}
        </button>
      )}
    </li>
  );
}
