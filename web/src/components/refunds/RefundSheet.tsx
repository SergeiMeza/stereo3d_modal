"use client";

/**
 * "Request a refund" (owner 2026-11-06): pick what to ask about (the
 * plan's latest payment, runs paid in the last 30 days), add a note, Send.
 * A person reviews every request. After a plan request: "Cancel your plan
 * too?". Opened from Plan & billing and from a run in Billing history
 * (refundSheetAtom, ADR 0138).
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { CANCEL_PLAN_HREF } from "@/components/auth/deletePlanLine";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useGateway } from "@/lib/api/useGateway";
import { billingUidAtom } from "@/lib/billing";
import { useAppAtomValue, useAppSetAtom } from "@/lib/state/stores";

import {
  closeRefundSheetAtom,
  loadRefundOptionsAtom,
  NOTE_MAX,
  refundOptionsAtom,
  refundSheetAtom,
  sendRefundRequestAtom,
} from "./refundAtoms";

export const REVIEW_LINE = "We'll review it within 2 business days.";
export const MERGED_LINE = "You'd already asked about some of these, so we added them to that request.";

export function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function RefundSheet(): JSX.Element {
  const sheet = useAppAtomValue(refundSheetAtom);
  const close = useAppSetAtom(closeRefundSheetAtom);
  return (
    <Dialog open={sheet.open} onOpenChange={(o) => !o && close()}>
      <DialogContent data-testid="refund-sheet" className="sm:max-w-md">
        {/* mounted per opening, so each one starts from its own picks */}
        {sheet.open ? <RefundBody initialPlan={sheet.plan} initialRuns={sheet.conversionIds} onDone={close} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RefundBody({
  initialPlan,
  initialRuns,
  onDone,
}: {
  initialPlan: boolean;
  initialRuns: string[];
  onDone: () => void;
}): JSX.Element {
  const gateway = useGateway();
  const state = useAppAtomValue(refundOptionsAtom);
  const uid = useAppAtomValue(billingUidAtom);
  const loadOptions = useAppSetAtom(loadRefundOptionsAtom);
  const send = useAppSetAtom(sendRefundRequestAtom);
  const options = state.uid === uid ? state.data : null;
  const [plan, setPlan] = useState(initialPlan);
  const [runs, setRuns] = useState<string[]>(initialRuns);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ plan: boolean; merged: boolean } | null>(null);

  useEffect(() => {
    void loadOptions(gateway);
  }, [loadOptions, gateway]);

  const planOption = options?.plan ?? null;
  const runOptions = options?.runs ?? [];
  const planPicked = plan && planOption !== null && planOption.open_request_id === null;
  const runsPicked = runs.filter((id) => runOptions.some((r) => r.conversion_id === id && r.open_request_id === null));
  const nothing = planOption === null && runOptions.length === 0;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await send({ client: gateway, plan: planPicked, conversionIds: runsPicked, text: note });
      setSent({ plan: planPicked, merged: r.merged });
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't send your request. Try again in a while.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    const offerCancel = sent.plan && planOption !== null && !planOption.cancelled;
    return (
      <>
        <DialogHeader>
          <DialogTitle>Request sent</DialogTitle>
          <DialogDescription>{REVIEW_LINE}</DialogDescription>
        </DialogHeader>
        {sent.merged ? <p className="text-sm text-fg-muted">{MERGED_LINE}</p> : null}
        {offerCancel ? (
          <div data-testid="refund-cancel-too" className="flex flex-wrap items-center gap-3 rounded-lg border border-edge p-3 text-sm">
            <span className="min-w-0 flex-1 text-fg">Cancel your plan too?</span>
            {/* a full load, so Plan & billing opens its cancel confirmation */}
            <Button asChild size="sm" variant="outline">
              <a href={CANCEL_PLAN_HREF}>Cancel plan</a>
            </Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Request a refund</DialogTitle>
        <DialogDescription>
          Pick what it&apos;s about. A person reviews every request. You can ask within{" "}
          {options?.window_days ?? 30} days of a payment.
        </DialogDescription>
      </DialogHeader>
      {options === null ? (
        state.error && state.uid === uid ? (
          <p role="alert" className="text-sm text-destructive">{state.error}</p>
        ) : (
          <div className="h-24 animate-pulse rounded-lg bg-surface-2" aria-busy="true" />
        )
      ) : nothing ? (
        <p data-testid="refund-nothing" className="text-sm text-fg-muted">
          Nothing paid in the last {options.window_days ?? 30} days can be refunded.
        </p>
      ) : (
        <ul data-testid="refund-items" className="max-h-64 divide-y divide-edge overflow-y-auto rounded-lg border border-edge">
          {planOption ? (
            <PickRow
              id="refund-plan"
              label={`${planOption.name} plan`}
              detail={`${formatCents(planOption.paid_cents)} · paid ${shortDay(planOption.paid_at)}`}
              asked={planOption.open_request_id !== null}
              checked={planPicked}
              onChange={setPlan}
            />
          ) : null}
          {runOptions.map((r) => (
            <PickRow
              key={r.conversion_id}
              id={`refund-run-${r.conversion_id}`}
              label={r.label}
              detail={`${formatCents(r.amount_cents)} · paid ${shortDay(r.paid_at)}`}
              asked={r.open_request_id !== null}
              checked={runsPicked.includes(r.conversion_id)}
              onChange={(on) =>
                setRuns((x) => (on ? [...x, r.conversion_id] : x.filter((id) => id !== r.conversion_id)))
              }
            />
          ))}
        </ul>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="refund-note">What happened? (optional)</Label>
        <textarea
          id="refund-note"
          value={note}
          maxLength={NOTE_MAX}
          rows={4}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-primary/60"
        />
        <p className="text-right text-xs text-fg-muted tabular-nums">
          {note.length}/{NOTE_MAX}
        </p>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={busy || (!planPicked && runsPicked.length === 0)} onClick={() => void submit()}>
          {busy ? "Sending…" : "Send"}
        </Button>
      </DialogFooter>
    </>
  );
}

function PickRow({
  id,
  label,
  detail,
  asked,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  detail: string;
  asked: boolean;
  checked: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <input
        id={id}
        type="checkbox"
        className="size-4 accent-primary"
        disabled={asked}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="block truncate text-fg">{label}</span>
        <span className="block text-xs text-fg-muted tabular-nums">
          {detail}
          {asked ? " · already asked for" : ""}
        </span>
      </label>
    </li>
  );
}
