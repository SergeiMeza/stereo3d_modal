"use client";

/**
 * Active conversion tracker: polls GET /v1/conversions/{id} until the
 * conversion reaches a terminal state, showing progress/stage/eta with a
 * cancel button while active. On success it notifies the workspace
 * (onProjectChanged) and fetches the signed download links.
 */

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { Conversion, ConversionState, Downloads } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

import { DownloadsList } from "./DownloadsList";
import { POLL_INTERVAL_MS } from "./polling";
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
            <span className="text-xs text-fg-muted">{conv.stage}</span>
          ) : null}
          {!terminal &&
          typeof conv.eta_seconds === "number" &&
          conv.eta_seconds > 0 ? (
            <span className="text-xs text-fg-muted">
              ~{formatEta(conv.eta_seconds)} left
            </span>
          ) : null}
        </div>
        {CANCELABLE.has(conv.state) ? (
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
      {conv.state === "succeeded" && showDownloads ? (
        <div className="mt-3">
          <p className="mb-2 text-xs font-medium text-fg-muted">Downloads</p>
          {downloads ? (
            <DownloadsList downloads={downloads.downloads} />
          ) : (
            <p className="text-xs text-fg-muted">Fetching download links…</p>
          )}
        </div>
      ) : null}
      {conv.state === "succeeded" && conv.billing?.status === "charge_failed" ? (
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
