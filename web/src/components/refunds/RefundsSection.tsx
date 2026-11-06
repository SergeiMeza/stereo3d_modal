"use client";

/**
 * Plan & billing → Refunds (owner 2026-11-06): ask for a refund of the
 * plan's latest payment or runs paid in the last 30 days (RefundSheet),
 * the account's requests with their status in plain words, and a reply
 * when we asked a question (or a follow-up on a closed one). App Store
 * Pro is refunded by Apple: "Ask Apple for a refund".
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

export function RefundsSection(): JSX.Element | null {
  const gateway = useGateway();
  const uid = useAppAtomValue(billingUidAtom);
  const options = useAppAtomValue(refundOptionsAtom);
  const requests = useAppAtomValue(supportRequestsAtom);
  const loadOptions = useAppSetAtom(loadRefundOptionsAtom);
  const loadRequests = useAppSetAtom(loadSupportRequestsAtom);
  const openSheet = useAppSetAtom(openRefundSheetAtom);
  const pro = useProStatus();
  useEffect(() => {
    if (uid === null) return;
    void loadOptions(gateway);
    void loadRequests(gateway);
  }, [uid, gateway, loadOptions, loadRequests]);

  const opts = options.uid === uid ? options.data : null;
  const list = requests.uid === uid ? requests.data : null;
  const plan = opts?.plan ?? null;
  const askable = (plan !== null && plan.open_request_id === null) || (opts?.runs ?? []).some((r) => r.open_request_id === null);
  const appStore = proCase(pro) === "app_store";

  return (
    <section data-testid="refunds" aria-labelledby="refunds-title" className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="refunds-title" className="text-sm font-semibold text-fg">
          Refunds
        </h2>
        {askable ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => openSheet()}>
            Request a refund
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-fg-muted">
        Ask within {opts?.window_days ?? 30} days of a payment. A person reviews every request.
      </p>
      {plan !== null && plan.open_request_id === null ? (
        <div data-testid="refund-plan-entry" className="flex flex-wrap items-center gap-3 text-sm">
          <span className="min-w-0 flex-1 text-fg">
            {plan.name} plan · {formatCents(plan.paid_cents)} paid {shortDay(plan.paid_at)}
          </span>
          <Button size="sm" variant="ghost" onClick={() => openSheet({ plan: true })}>
            Request a refund
          </Button>
        </div>
      ) : null}
      {appStore ? (
        <p data-testid="refund-app-store" className="text-sm text-fg">
          Pro from the App Store is refunded by Apple.{" "}
          <a href={APPLE_REFUND_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            Ask Apple for a refund
          </a>
        </p>
      ) : null}
      {list !== null && list.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-fg-muted">Your requests</h3>
          <ul data-testid="support-requests" className="divide-y divide-edge rounded-lg border border-edge">
            {list.map((r) => (
              <RequestRow key={r.id} request={r} />
            ))}
          </ul>
        </div>
      ) : null}
      <RefundSheet />
    </section>
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
    <li data-testid={`request-${r.id}`} className="flex flex-col gap-2 px-3 py-2.5 text-sm">
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
