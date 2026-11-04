"use client";

/**
 * "Get another format" under a finished run's files (ADR 0137, owner
 * decision): the run's own 3D files are packed into another format, free.
 * GET /v1/runs/{id}/formats says what can be made (and why not, when
 * nothing can); POST starts one. While one is being made the GET is polled;
 * when it's done the file appears in the list above with its Download.
 * A failure says "That didn't work. Try again." with a retry.
 */

import { ChevronDown, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GatewayError } from "@/lib/api/client";
import type { Conversion, Format, Preset, RunFormats } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { FORMAT_NAMES } from "@/lib/glossary";

import { FORMAT_FOR, HALF_SBS_SIZE_HINT } from "./makeControls";
import { NO_FULL_SBS_PRESETS } from "./methods";

/** How often the GET is asked while a format is being made: every 3 s for
 * the first minute, then every 15 s. */
export const FORMAT_POLL_MS = 3000;
export const FORMAT_POLL_SLOW_MS = 15_000;
const FAST_POLL_FOR_MS = 60_000;

/** Beside "Making it…" for Spatial video or anything over ~2 minutes. */
export const LONG_WAIT_COPY = "This can take a while. You can leave this page; the file appears here when it's ready.";
const LONG_WAIT_S = 120;

/** "About 4 minutes" from an estimate in seconds. */
export function aboutMinutes(seconds: number): string {
  const n = Math.max(1, Math.round(seconds / 60));
  return `About ${n} minute${n === 1 ? "" : "s"}`;
}

/** Why nothing can be made, in plain words; null hides the control. */
export const UNAVAILABLE_COPY: Record<string, string | null> = {
  half_only: "This run only has the half-size file. Make a new conversion for other formats.",
  files_erased: "These files were erased after 90 days without use.",
  split_run: "This run is in parts, so other formats can't be made from it. Make a new conversion for other formats.",
  // too_wide only rules out full side by side at 6K/8K, never the control
  too_wide: null,
  classic_retired: null,
  run_failed: null,
};

const FAILED = "That didn't work. Try again.";

/** 409 format_unavailable {reason: "too_wide"} on a start. */
export const TOO_WIDE_COPY =
  "Full side by side isn't made at 6K and 8K. Pick Side by side (half size) or Spatial video.";

const nameOf = (f: Format) => FORMAT_NAMES[f] ?? f;

export function AnotherFormat({
  conversion,
  onNewFile,
}: {
  conversion: Conversion;
  /** a format finished: load the run's files again */
  onNewFile: () => void;
}): JSX.Element | null {
  const gateway = useGateway();
  const id = conversion.conversion_id;
  const [data, setData] = useState<RunFormats | null>(null);
  /** formats whose start failed here (the gateway has no job for them) */
  const [startFailed, setStartFailed] = useState<Format[]>([]);
  const [starting, setStarting] = useState<Format | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seenDone = useRef<Set<string> | null>(null);
  /** the POST's estimate per format, until the GET's jobs carry one */
  const [estimates, setEstimates] = useState<Partial<Record<Format, number>>>({});
  /** when the current making began (for the slower polls after a minute) */
  const makingSince = useRef<number | null>(null);

  const load = useCallback(async () => {
    const next = await gateway.getRunFormats(id);
    // a job that finished since the last look: its file is ready
    const done = new Set(
      Object.entries(next.jobs ?? {})
        .filter(([, j]) => j?.status === "succeeded")
        .map(([f]) => f),
    );
    if (seenDone.current !== null && [...done].some((f) => !seenDone.current!.has(f))) onNewFile();
    seenDone.current = done;
    setData(next);
    return next;
  }, [gateway, id, onNewFile]);

  useEffect(() => {
    let stop = false;
    gateway
      .getRunFormats(id)
      .then((d) => {
        if (stop) return;
        seenDone.current = new Set(
          Object.entries(d.jobs ?? {})
            .filter(([, j]) => j?.status === "succeeded")
            .map(([f]) => f),
        );
        setData(d);
      })
      .catch(() => {
        // the control stays away when the gateway can't say
      });
    return () => {
      stop = true;
    };
  }, [gateway, id]);

  const making = data?.pending ?? [];
  // poll while something is being made: every 3 s, every 15 s after a minute
  useEffect(() => {
    if (making.length === 0) {
      makingSince.current = null;
      return;
    }
    makingSince.current ??= Date.now();
    const wait = Date.now() - makingSince.current < FAST_POLL_FOR_MS ? FORMAT_POLL_MS : FORMAT_POLL_SLOW_MS;
    const t = setTimeout(() => {
      void load().catch(() => {});
    }, wait);
    return () => clearTimeout(t);
  }, [making.length, data, load]);

  async function start(format: Format): Promise<void> {
    setStarting(format);
    setNotice(null);
    setStartFailed((l) => l.filter((f) => f !== format));
    try {
      const job = await gateway.requestRunFormat(id, format);
      if (typeof job.estimated_seconds === "number") {
        setEstimates((e) => ({ ...e, [format]: job.estimated_seconds as number }));
      }
      await load();
    } catch (e) {
      if (e instanceof GatewayError && (e.code === "format_exists" || e.code === "format_in_progress")) {
        await load().catch(() => {});
      } else if (e instanceof GatewayError && e.code === "format_unavailable") {
        const reason = typeof e.details?.reason === "string" ? e.details.reason : "";
        setNotice(reason === "too_wide" ? TOO_WIDE_COPY : (UNAVAILABLE_COPY[reason] ?? FAILED));
        await load().catch(() => {});
      } else if (e instanceof GatewayError && e.code === "rate_limited") {
        setNotice("Too many tries. Wait a few minutes.");
      } else {
        // repack_unavailable (502/503) and anything else: failed, with retry
        setStartFailed((l) => [...l.filter((f) => f !== format), format]);
      }
    } finally {
      setStarting(null);
    }
  }

  if (data === null) return null;
  const jobs = data.jobs ?? {};
  const failed = [
    ...new Set([
      ...startFailed,
      ...(Object.entries(jobs)
        .filter(([f, j]) => j?.status === "failed" && !data.have.includes(f as Format) && !making.includes(f as Format))
        .map(([f]) => f) as Format[]),
    ]),
  ];
  // 6K and 8K make no full side-by-side file: never offered there
  const noFullSbs = NO_FULL_SBS_PRESETS.includes(conversion.params.preset as Preset);
  const offered = data.available.filter(
    (f) => !failed.includes(f) && f !== starting && !(f === "sbs" && noFullSbs),
  );
  const reason = data.unavailable_reason ? UNAVAILABLE_COPY[data.unavailable_reason] : undefined;

  if (offered.length === 0 && making.length === 0 && failed.length === 0 && starting === null) {
    if (!reason) return null;
    return (
      <p data-testid="another-format-unavailable" className="text-xs text-fg-muted">
        {reason}
      </p>
    );
  }

  return (
    <section data-testid="another-format" className="flex flex-col gap-2 rounded-lg border border-dashed border-edge p-3">
      <div className="flex flex-wrap items-center gap-2">
        {offered.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-testid="another-format-open">
                Get another format
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              {offered.map((f) => (
                <DropdownMenuItem
                  key={f}
                  data-testid={`another-format-${f}`}
                  className="flex-col items-start gap-0.5"
                  onSelect={() => void start(f)}
                >
                  <span className="font-medium">{nameOf(f)}</span>
                  {FORMAT_FOR[f] ? <span className="text-xs text-fg-muted">{FORMAT_FOR[f]}</span> : null}
                  {f === "half_sbs" ? <span className="text-xs text-fg-muted">{HALF_SBS_SIZE_HINT}</span> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="text-sm text-fg">Another format</span>
        )}
        <Badge variant="secondary">Free</Badge>
        <span className="text-xs text-fg-muted">Made from this run&apos;s files.</span>
      </div>

      {[...new Set([...(starting ? [starting] : []), ...making])].map((f) => {
        const est = jobs[f]?.estimated_seconds ?? estimates[f] ?? null;
        const long = f === "mvhevc" || (est !== null && est > LONG_WAIT_S);
        return (
          <div key={f} role="status" data-testid={`another-format-making-${f}`} className="flex flex-col gap-0.5 text-xs">
            <p className="flex items-center gap-2 text-fg">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {nameOf(f)}: Making it…
              {est !== null ? <span className="text-fg-muted">{aboutMinutes(est)}</span> : null}
            </p>
            {long ? <p className="pl-5.5 text-fg-muted">{LONG_WAIT_COPY}</p> : null}
          </div>
        );
      })}
      {failed.map((f) => (
        <p key={f} data-testid={`another-format-failed-${f}`} className="flex flex-wrap items-center gap-2 text-xs">
          <span role="alert" className="text-destructive">
            {nameOf(f)}: {FAILED}
          </span>
          <Button size="xs" variant="outline" onClick={() => void start(f)}>
            Try again
          </Button>
        </p>
      ))}
      {notice !== null && <p className="text-xs text-fg-muted">{notice}</p>}
    </section>
  );
}
