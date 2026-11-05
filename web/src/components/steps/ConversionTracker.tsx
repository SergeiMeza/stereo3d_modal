"use client";

/**
 * Active conversion tracker: polls GET /v1/conversions/{id} until the
 * conversion reaches a terminal state, showing progress/stage/eta with a
 * cancel button while active. On success it notifies the workspace
 * (onProjectChanged) and fetches the signed download links. A run the
 * gateway marks overdue offers "Report it" instead of an endless bar
 * (2026-10-27: runs sat at "Profiling scenes" for hours). A run queued for
 * a free GPU (waiting_for_gpu) says so instead of showing a frozen stage —
 * that wait is never drawn as progress.
 */

import { useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { Conversion, ConversionState } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

import { RunFiles } from "./RunFiles";
import { runFacts } from "./QuoteView";
import { formatCents } from "./money";
import { POLL_INTERVAL_MS } from "./polling";
import { FINISH_PAYMENT, WAITING_FOR_PAYMENT } from "@/components/pay/payCopy";
import { useSettle } from "@/components/pay/SettleSheet";
import { qualityName, STEP_NAMES } from "@/lib/glossary";
import { formatDuration, formatTimeLeft } from "@/lib/format";

import { WAITING_IN_LINE_NOTE } from "./runStatus";
import { stageLabel } from "./stageLabels";
import { StateChip } from "./StateChip";
import { conversionAtom } from "./conversionAtoms";
import { loadErrorText, useIsSample } from "./loadError";

/** States a conversion never leaves — shared with useStepCheckout, which
 * must not resume trackers for (or poll) conversions already done. */
export const TERMINAL_STATES: ReadonlySet<ConversionState> = new Set([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);
const TERMINAL = TERMINAL_STATES;
const CANCELABLE: ReadonlySet<ConversionState> = new Set([
  "created",
  "paid",
  "processing",
]);

/** S3D-23: a run can be cancelled any time while it waits in line (full
 * refund when it was paid up front) and for 1 minute after it starts
 * (`cancelable_until`; the gateway enforces it with a 409). */
/** 00081: an Express run waiting for a GPU (it may wait for a running
 * piece to finish, up to queue_wait_max_seconds). */
export function expressWaitLine(maxWait?: number): string {
  return maxWait && maxWait > 0
    ? `Starting soon (Express). Within about ${Math.max(1, Math.round(maxWait / 60))} min.`
    : "Starting soon (Express).";
}

export function cancelable(conv: Conversion, now = Date.now()): boolean {
  if (!CANCELABLE.has(conv.state)) return false;
  if (conv.waiting_for_gpu || conv.state !== "processing") return true;
  if (!conv.cancelable_until) return true; // not yet submitted
  return now < Date.parse(conv.cancelable_until);
}

/** Seconds left in the 1-minute cancel window, or null when the run is
 * waiting in line (no countdown) or past it. */
export function cancelSecondsLeft(
  conv: Conversion,
  now = Date.now(),
): number | null {
  if (conv.waiting_for_gpu || conv.state !== "processing") return null;
  if (!conv.cancelable_until) return null;
  const left = Math.ceil((Date.parse(conv.cancelable_until) - now) / 1000);
  return left > 0 ? left : null;
}

/** What cancelling costs, in words (screen 08). */
export function cancelNote(conv: Conversion, secondsLeft: number | null): string {
  const paid = conv.charge_timing === "before" && conv.billing?.status === "charged";
  if (secondsLeft !== null) {
    const m = Math.floor(secondsLeft / 60);
    const s = String(secondsLeft % 60).padStart(2, "0");
    return `${m}:${s} · ${paid ? "Full refund" : "Not charged"} if you cancel now`;
  }
  return paid
    ? "Cancel any time while it waits for a full refund."
    : "Cancel any time while it waits and you won't be charged.";
}

/** The three steps a run shows while it works (screen 08). */
export const STEP_LINES = ["Getting ready", "Making the 3D video", "Saving your files"];

/** Which of the three steps a raw stage belongs to. */
export function stageStep(stage: string | null | undefined): number {
  const base = (stage ?? "").split("[")[0].trim();
  if (["queued", "plan", "preprocess", "profile_scenes", "analyze", "proxy"].includes(base)) {
    return 0;
  }
  if (base.startsWith("encode") || base === "publish" || base === "done") return 2;
  return 1;
}

/** "Full video · 4K · 60 fps · 3 min · $58.50" — what the run is, in one
 * line (size, frame rate and billable minutes, owner 2026-11-04). */
export function runLine(conv: Conversion, { price = true }: { price?: boolean } = {}): string {
  const facts =
    conv.step === "depth_preview"
      ? []
      : runFacts(conv.params, conv.quote?.breakdown);
  return [
    STEP_NAMES[conv.step ?? "production"] ?? "Run",
    ...(facts.length > 0
      ? facts
      : [conv.step !== "depth_preview" && conv.params?.preset ? qualityName(conv.params.preset) : null]),
    price ? formatCents(conv.quote.amount_cents) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Plain words for a run's payment, when there is something to say:
 * pre-charged runs (charge_timing "before") and their refunds. */
export function billingStatusNote(conv: Conversion): string | null {
  switch (conv.billing?.status) {
    case "refund_pending":
      return "Your refund is on its way. The full amount goes back to your payment method.";
    case "refunded":
      return "Refunded in full.";
    case "not_charged":
      return "You were not charged.";
    case "charged":
      return conv.charge_timing === "before" &&
        (conv.state === "paid" || conv.state === "processing")
        ? "Paid when the run started. Refunded in full if it fails."
        : null;
    default:
      return conv.charge_timing === "before" &&
        (conv.state === "failed" || conv.state === "canceled")
        ? "This run was paid when it started, so it is refunded in full."
        : null;
  }
}


/** The current time, re-read every second while `ticking` (the cancel
 * countdown and window). */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return now;
}

export interface ConversionTrackerProps {
  conversion: Conversion;
  onProjectChanged: () => void;
  /** Fired once, when the conversion reaches a terminal state. */
  onSettled?: (conversion: Conversion) => void;
  /** Fired on every fresher snapshot (poll response, cancel) so an external
   * store can stay current — a tracker remounted after tab navigation then
   * resumes from the latest progress, not the creation response. */
  onUpdate?: (conversion: Conversion) => void;
  /** Render the downloads list on success (default). The Depth tab passes
   * false — its side-by-side depth view and Export button already surface
   * the outputs, so the tracker just reports the state. */
  showDownloads?: boolean;
  /** The quote's estimate (eta_seconds), shown until the run reports its
   * own time left. */
  estimateSeconds?: number;
  /** P12: reopen the run's open payment ("Finish payment") */
  onFinishPayment?: () => void;
}

export function ConversionTracker({
  conversion,
  onProjectChanged,
  onSettled,
  onUpdate,
  showDownloads = true,
  estimateSeconds,
  onFinishPayment,
}: ConversionTrackerProps): JSX.Element {
  const client = useGateway();
  const { openSettle } = useSettle();
  // ADR 0138: the run as last polled, in one atom per run, so a remount
  // (a tab switch) and every reader see the same state
  const [polled, setConv] = useAtom(conversionAtom(conversion.conversion_id));
  const conv = polled ?? conversion;
  const [error, setError] = useState<string | null>(null);
  const sample = useIsSample();
  const [canceling, setCanceling] = useState(false);
  const settledRef = useRef(false);
  // Latest conv for the in-flight poll race check (a local terminal state,
  // e.g. from cancel, wins over any poll response still in flight).
  const convRef = useRef(conv);
  useEffect(() => {
    convRef.current = conv;
  }, [conv]);

  const terminal = TERMINAL.has(conv.state);

  // Poll until terminal. A local terminal state (e.g. from cancel) wins over
  // any poll response still in flight.
  useEffect(() => {
    if (terminal) return;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      client
        .getConversion(conv.conversion_id)
        .then((next) => {
          setError(null);
          if (TERMINAL.has(convRef.current.state)) return;
          convRef.current = next;
          setConv(next);
          onUpdate?.(next);
        })
        .catch((e: unknown) => {
          setError(loadErrorText(e, sample, "Couldn't check on this run. Retrying…"));
        })
        .finally(() => {
          inFlight = false;
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [client, conv.conversion_id, terminal, onUpdate, sample, setConv]);

  // Terminal side effects (once): notify parent (RunFiles fetches the files).
  useEffect(() => {
    if (!terminal || settledRef.current) return;
    settledRef.current = true;
    onSettled?.(conv);
    if (conv.state === "succeeded") {
      onProjectChanged();
    }
  }, [client, conv, onProjectChanged, onSettled, terminal, showDownloads]);

  async function cancel(): Promise<void> {
    setCanceling(true);
    try {
      const next = await client.cancelConversion(conv.conversion_id);
      convRef.current = next; // wins over any poll still in flight
      setConv(next);
      onUpdate?.(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "cancel failed");
    } finally {
      setCanceling(false);
    }
  }

  async function report(note: string): Promise<void> {
    const next = await client.reportConversion(conv.conversion_id, note);
    if (TERMINAL.has(convRef.current.state)) return;
    convRef.current = next;
    setConv(next);
    onUpdate?.(next);
  }

  const pct = Math.round(Math.min(Math.max(conv.progress, 0), 1) * 100);
  // ticks while the run is active, so the window closes on time
  const now = useNow(!terminal);
  // Queued for a free GPU: no stage, no time left, no bar — the wait is
  // not progress.
  const waiting = !terminal && conv.waiting_for_gpu === true;
  const runEta =
    typeof conv.eta_seconds === "number" && conv.eta_seconds > 0
      ? conv.eta_seconds
      : null;

  const canCancel = cancelable(conv, now);
  const current = stageStep(conv.stage);

  return (
    <div
      data-testid="conversion-tracker"
      className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StateChip conversion={conv} />
        <span data-testid="tracker-line" className="text-sm text-fg">
          {runLine(conv)}
        </span>
        <span className="ml-auto flex items-center gap-3">
          {waiting || terminal ? null : runEta !== null ? (
            <span data-testid="tracker-eta" className="text-xs text-fg-muted">
              {formatTimeLeft(runEta)}
            </span>
          ) : estimateSeconds !== undefined && estimateSeconds > 0 ? (
            <span data-testid="tracker-eta" className="text-xs text-fg-muted">
              Estimated: {formatDuration(estimateSeconds)}
            </span>
          ) : null}
          {conv.state === "succeeded" && showDownloads ? (
            <a href="#tab=files" className="text-xs text-primary hover:underline">
              All files
            </a>
          ) : null}
          {canCancel && (waiting || conv.state !== "processing") ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => void cancel()}
              disabled={canceling}
            >
              Cancel
            </Button>
          ) : null}
        </span>
      </div>

      {conv.state === "created" && conv.billing?.status === "requires_payment" ? (
        // P12: the run waits for its payment; Finish payment reopens it
        <p className="flex flex-wrap items-center gap-3 text-sm text-fg" data-testid="waiting-for-payment">
          {WAITING_FOR_PAYMENT}
          {onFinishPayment ? (
            <Button size="sm" data-testid="finish-payment" onClick={onFinishPayment}>
              {FINISH_PAYMENT}
            </Button>
          ) : null}
        </p>
      ) : conv.state === "created" ? (
        <p className="text-sm text-fg-muted" data-testid="hold-confirming">
          {conv.billing?.status === "waiting_for_payment"
            ? "Waiting for your payment to be confirmed."
            : "Confirming the payment with your bank. It starts as soon as it clears."}
        </p>
      ) : null}
      {waiting || conv.state === "paid" ? (
        <div className="flex flex-col gap-1 text-sm text-fg-muted">
          <p data-testid="waiting-for-gpu">
            {conv.priority === "express" || conv.params?.express === true
              ? expressWaitLine(conv.queue_wait_max_seconds)
              : WAITING_IN_LINE_NOTE}
          </p>
          {canCancel ? (
            <p className="text-xs" data-testid="cancel-note">
              {cancelNote(conv, null)}
            </p>
          ) : null}
        </div>
      ) : null}

      {!waiting && conv.state === "processing" ? (
        <>
          <ol data-testid="tracker-steps" className="flex flex-col gap-1 text-sm">
            {STEP_LINES.map((line, i) => (
              <li
                key={line}
                aria-current={i === current ? "step" : undefined}
                className={`flex items-center gap-2 ${
                  i < current ? "text-fg-muted" : i === current ? "text-fg" : "text-fg-muted/60"
                }`}
              >
                <span aria-hidden className="w-4 text-center">
                  {i < current ? "✓" : i === current ? "•" : ""}
                </span>
                {line}
                {i === current && conv.stage ? (
                  // raw stage strings carry internal worker/model details
                  // ("video_stereo[propainter]") — only the mapped label
                  <span className="text-xs text-fg-muted">{" "}· {stageLabel(conv.stage)}</span>
                ) : null}
              </li>
            ))}
          </ol>
          <Progress value={pct} className="h-1" />
          {canCancel ? (
            <div className="flex items-center gap-3 text-xs text-fg-muted">
              <span data-testid="cancel-note">
                {cancelNote(conv, cancelSecondsLeft(conv, now))}
              </span>
              <Button
                variant="outline"
                size="xs"
                className="ml-auto"
                onClick={() => void cancel()}
                disabled={canceling}
              >
                Cancel
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {!terminal && (conv.overdue || conv.reported_at) ? (
        <OverdueNotice reported={Boolean(conv.reported_at)} onReport={report} />
      ) : null}

      {conv.state === "succeeded" && conv.billing?.status === "charge_failed" ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-amber-400" data-testid="charge-failed">
          There&apos;s a problem with your last payment.
          <button
            type="button"
            onClick={() => openSettle()}
            className="text-primary hover:underline"
          >
            Pay now
          </button>
        </p>
      ) : null}
      {conv.state === "succeeded" && showDownloads ? <RunFiles conversion={conv} /> : null}

      {conv.state === "failed" ? (
        <p className="text-sm text-fg-muted" data-testid="tracker-failed">
          Something went wrong on our side. Try again.
        </p>
      ) : null}
      {billingStatusNote(conv) !== null && conv.state !== "processing" ? (
        <p className="text-xs text-fg-muted" data-testid="billing-note">
          {billingStatusNote(conv)}
        </p>
      ) : null}
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </div>
  );
}

/** Shown under the bar once a run is well past its estimate. */
function OverdueNotice({
  reported,
  onReport,
}: {
  reported: boolean;
  onReport: (note: string) => Promise<void>;
}): JSX.Element {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  if (reported) {
    return (
      <p className="mt-3 text-sm text-fg-muted" data-testid="overdue-reported">
        Thanks for letting us know. We&apos;re looking into this run and will reply
        by email.
      </p>
    );
  }

  async function send(): Promise<void> {
    setSending(true);
    setFailed(false);
    try {
      await onReport(note.trim());
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-3 space-y-2" data-testid="overdue-notice">
      <p className="text-sm text-amber-400">
        This is taking much longer than expected.
      </p>
      <p className="text-xs text-fg-muted">
        Something may be stuck on our side. Report it and we&apos;ll look into it and
        reply by email.
      </p>
      <textarea
        aria-label="Anything we should know? (optional)"
        placeholder="Anything we should know? (optional)"
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        className="w-full rounded-lg border border-edge bg-surface-1 px-3 py-1.5 text-sm text-fg outline-none focus:border-primary/60"
      />
      <div className="flex items-center gap-3">
        <Button size="xs" onClick={() => void send()} disabled={sending}>
          {sending ? "Sending…" : "Report it"}
        </Button>
        {failed ? (
          <span className="text-xs text-red-400">
            Couldn&apos;t send the report. Try again.
          </span>
        ) : null}
      </div>
    </div>
  );
}
