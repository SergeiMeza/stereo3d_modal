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

const TERMINAL: ReadonlySet<ConversionState> = new Set([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);
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
}

export function ConversionTracker({
  conversion,
  onProjectChanged,
  onSettled,
}: ConversionTrackerProps): JSX.Element {
  const client = useGateway();
  const [conv, setConv] = useState(conversion);
  const [downloads, setDownloads] = useState<Downloads | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const settledRef = useRef(false);

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
          setConv((prev) => (TERMINAL.has(prev.state) ? prev : next));
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : "poll failed");
        })
        .finally(() => {
          inFlight = false;
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [client, conv.conversion_id, terminal]);

  // Terminal side effects (once): notify parent; fetch downloads on success.
  useEffect(() => {
    if (!terminal || settledRef.current) return;
    settledRef.current = true;
    onSettled?.(conv);
    if (conv.state === "succeeded") {
      onProjectChanged();
      client
        .getDownloads(conv.conversion_id)
        .then(setDownloads)
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : "downloads failed");
        });
    }
  }, [client, conv, onProjectChanged, onSettled, terminal]);

  async function cancel(): Promise<void> {
    setCanceling(true);
    try {
      const next = await client.cancelConversion(conv.conversion_id);
      setConv(next);
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
      {!terminal ? <Progress value={pct} className="mt-3 h-1.5" /> : null}
      {conv.state === "succeeded" ? (
        <div className="mt-3">
          <p className="mb-2 text-xs font-medium text-fg-muted">Downloads</p>
          {downloads ? (
            <DownloadsList downloads={downloads.downloads} />
          ) : (
            <p className="text-xs text-fg-muted">Fetching download links…</p>
          )}
        </div>
      ) : null}
      {conv.state === "failed" && conv.error ? (
        <p className="mt-3 text-sm text-red-400">{conv.error.message}</p>
      ) : null}
      {conv.state === "canceled" ? (
        <p className="mt-3 text-sm text-fg-muted">
          Conversion canceled — the payment hold is released.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
    </div>
  );
}
