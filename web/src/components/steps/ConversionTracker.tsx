"use client";

/**
 * Active conversion tracker: polls GET /v1/conversions/{id} until the
 * conversion reaches a terminal state, showing progress/stage/eta with a
 * cancel button while active. On success it notifies the workspace
 * (onProjectChanged) and fetches the signed download links. A run the
 * gateway marks overdue offers "Report it" instead of an endless bar
 * (2026-10-27: runs sat at "Profiling scenes" for hours).
 */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { Conversion, ConversionState, Downloads } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

import { DownloadsList, stepDownloads } from "./DownloadsList";
import { POLL_INTERVAL_MS } from "./polling";
import { stageLabel } from "./stageLabels";
import { StateChip } from "./StateChip";

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

/** A job can be canceled while in an active state, but only until the
 * gateway's cancel window closes (1 minute after GPU submission —
 * `cancelable_until`; the gateway enforces this with a 409). Re-evaluated
 * on every poll tick, so the button disappears within one interval. */
function cancelable(conv: Conversion): boolean {
  if (!CANCELABLE.has(conv.state)) return false;
  if (!conv.cancelable_until) return true; // not yet submitted
  return Date.now() < Date.parse(conv.cancelable_until);
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
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
}

export function ConversionTracker({
  conversion,
  onProjectChanged,
  onSettled,
  onUpdate,
  showDownloads = true,
}: ConversionTrackerProps): JSX.Element {
  const client = useGateway();
  const [conv, setConv] = useState(conversion);
  const [downloads, setDownloads] = useState<Downloads | null>(null);
  const [error, setError] = useState<string | null>(null);
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
          setError(e instanceof Error ? e.message : "poll failed");
        })
        .finally(() => {
          inFlight = false;
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [client, conv.conversion_id, terminal, onUpdate]);

  // Terminal side effects (once): notify parent; fetch downloads on success.
  useEffect(() => {
    if (!terminal || settledRef.current) return;
    settledRef.current = true;
    onSettled?.(conv);
    if (conv.state === "succeeded") {
      onProjectChanged();
      if (showDownloads) {
        client
          .getDownloads(conv.conversion_id)
          .then(setDownloads)
          .catch((e: unknown) => {
            setError(e instanceof Error ? e.message : "downloads failed");
          });
      }
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

  return (
    <div
      data-testid="conversion-tracker"
      className="rounded-lg border border-edge bg-surface-2 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StateChip state={conv.state} />
          {!terminal && conv.stage ? (
            // raw stage strings carry internal worker/model details
            // ("video_stereo[propainter]") — always render the mapped label
            <span className="text-xs text-fg-muted">
              {stageLabel(conv.stage)}
            </span>
          ) : null}
          {!terminal &&
          typeof conv.eta_seconds === "number" &&
          conv.eta_seconds > 0 ? (
            <span className="text-xs text-fg-muted">
              ~{formatEta(conv.eta_seconds)} left
            </span>
          ) : null}
        </div>
        {cancelable(conv) ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void cancel()}
            disabled={canceling}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {conv.state === "created" ? (
        <p className="mt-3 text-sm text-fg-muted" data-testid="hold-confirming">
          Confirming the payment hold with your bank — the run starts
          automatically once it clears.
        </p>
      ) : null}
      {!terminal ? <Progress value={pct} className="mt-3 h-1.5" /> : null}
      {!terminal && (conv.overdue || conv.reported_at) ? (
        <OverdueNotice reported={Boolean(conv.reported_at)} onReport={report} />
      ) : null}
      {conv.state === "succeeded" && showDownloads ? (
        <div className="mt-3">
          <p className="mb-2 text-xs font-medium text-fg-muted">Downloads</p>
          {downloads ? (
            <DownloadsList
              downloads={stepDownloads(conv.step, downloads.downloads)}
            />
          ) : (
            <p className="text-xs text-fg-muted">Fetching download links…</p>
          )}
        </div>
      ) : null}
      {conv.state === "succeeded" && conv.billing?.status === "batched" ? (
        <p className="mt-3 text-xs text-fg-muted" data-testid="batched-note">
          Added to your pending balance — charged together with your other
          steps.
        </p>
      ) : null}
      {conv.state === "succeeded" &&
      conv.billing?.status === "charge_failed" ? (
        <p className="mt-3 text-sm text-amber-400" data-testid="charge-failed">
          The automatic payment for this conversion failed — your results are
          ready, but settle it (banner above) before starting new work.
        </p>
      ) : null}
      {conv.state === "failed" && conv.error ? (
        <p className="mt-3 text-sm text-red-400">{conv.error.message}</p>
      ) : null}
      {conv.state === "canceled" ? (
        <p className="mt-3 text-sm text-fg-muted">
          Conversion canceled — you were not charged.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
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
