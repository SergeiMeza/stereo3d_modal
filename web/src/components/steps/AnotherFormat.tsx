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
import { useAtom, useAtomValue } from "jotai";
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
import type { Conversion, Format, Preset, RunFormatJob, RunFormats } from "@/lib/api/types";
import { formatClock } from "@/lib/format";
import { useGateway } from "@/lib/api/useGateway";
import { useFallbackTick, useLiveFormats } from "@/lib/live/useLive";
import { formatName } from "@/lib/glossary";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

import { formatFor, halfSbsSizeHint } from "./makeControls";
import { NO_FULL_SBS_PRESETS } from "./methods";
import { runFilesAtom, runFormatsAtom } from "./runFilesAtoms";

/** The time, ticking each second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** How often the GET is asked while a format is being made: every 3 s for
 * the first minute, then every 15 s. */

/** Beside "Making it…" for Spatial video or anything over ~2 minutes. */
export const LONG_WAIT_COPY = EN("files.another.longWait");
const LONG_WAIT_S = 120;

/** "About 4 minutes" from an estimate in seconds. */
export function aboutMinutes(seconds: number, t: Tr = EN): string {
  const n = Math.max(1, Math.round(seconds / 60));
  return t("files.another.aboutMinutes", { count: n });
}

/** A finished job whose file isn't listed yet. */
export const ALMOST_READY = EN("files.another.almostReady");

/** "About 1:52 left" (QA 2026-11-05: a countdown, never a frozen number). */
export function leftText(seconds: number, t: Tr = EN): string {
  return seconds > 0
    ? t("files.another.left", { time: formatClock(Math.ceil(seconds)) })
    : t("files.another.almostDone");
}

/**
 * How far a job is: the gateway's progress (0–1) and remaining seconds
 * (counted down from when they were read) when it sends them, else its
 * estimate counted down from when the job was asked for.
 */
export function jobProgress(
  job: RunFormatJob | undefined,
  started: { at: number; seconds: number | null } | undefined,
  readAt: number,
  now: number,
  t: Tr = EN,
): { fraction: number | null; text: string | null } {
  const fraction =
    typeof job?.progress === "number" ? Math.min(1, Math.max(0, job.progress)) : null;
  if (typeof job?.remaining_seconds === "number") {
    return { fraction, text: leftText(job.remaining_seconds - (now - readAt) / 1000, t) };
  }
  const est = job?.estimated_seconds ?? started?.seconds ?? null;
  if (est === null) return { fraction, text: null };
  const from = job?.requested_at ? Date.parse(job.requested_at) : (started?.at ?? now);
  return { fraction, text: leftText(est - (now - (Number.isFinite(from) ? from : now)) / 1000, t) };
}

/** Why nothing can be made, in plain words; null hides the control. */
export function unavailableCopy(t: Tr = EN): Record<string, string | null> {
  return {
    half_only: t("files.another.unavailable.halfOnly"),
    files_erased: t("files.another.unavailable.filesErased"),
    // split runs get one file per part now; an older gateway may still say it
    split_run: t("files.another.unavailable.splitRun"),
    // too_wide only rules out full side by side at 6K/8K, never the control
    too_wide: null,
    classic_retired: null,
    run_failed: null,
  };
}

/** The reasons in English (kept for older callers). */
export const UNAVAILABLE_COPY: Record<string, string | null> = unavailableCopy();

/** 409 format_unavailable {reason: "too_wide"} on a start. */
export const TOO_WIDE_COPY = EN("files.another.tooWide");


export function AnotherFormat({
  conversion,
  onNewFile,
}: {
  conversion: Conversion;
  /** a format finished: load the run's files again */
  onNewFile: () => void;
}): JSX.Element | null {
  const t = useT();
  const nameOf = (f: Format) => formatName(f, t);
  const gateway = useGateway();
  const id = conversion.conversion_id;
  // ADR 0138: the run's format jobs and files live in its atoms
  // (runFilesAtoms); what's local here is this control's own feedback
  const [formats, setFormats] = useAtom(runFormatsAtom(id));
  const runFiles = useAtomValue(runFilesAtom(id)).files;
  const data = formats.data;
  /** formats whose start failed here (the gateway has no job for them) */
  const [startFailed, setStartFailed] = useState<Format[]>([]);
  const [starting, setStarting] = useState<Format | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seenDone = useRef<Set<string> | null>(null);

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
    setFormats((s) => ({ ...s, data: next, readAt: Date.now() }));
    return next;
  }, [gateway, id, onNewFile, setFormats]);

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
        setFormats((s) => ({ ...s, data: d, readAt: Date.now() }));
      })
      .catch(() => {
        // the control stays away when the gateway can't say
      });
    return () => {
      stop = true;
    };
  }, [gateway, id, setFormats]);

  // QA 2026-11-05: a job the gateway finished whose file isn't in the
  // run's files yet keeps its row ("Almost ready…"), and the files are read
  // again until it's there
  const listed = new Set((runFiles ?? []).map((f) => f.format));
  const finishing =
    runFiles === null
      ? []
      : (Object.entries(data?.jobs ?? {})
          .filter(([f, j]) => j?.status === "succeeded" && !listed.has(f))
          .map(([f]) => f) as Format[]);
  const making = data?.pending ?? [];
  const waiting = making.length + finishing.length;
  // owner 2026-11-07: no timer. The live feed's run.formats brings the
  // jobs (and the run's file names); a newer one replaces what we read
  const live = useLiveFormats(id);
  const liveVersion = live?.version ?? 0;
  useEffect(() => {
    if (!live || live.formats === null || typeof live.formats !== "object") return;
    const next = live.formats as RunFormats;
    const done = new Set(
      Object.entries(next.jobs ?? {})
        .filter(([, j]) => j?.status === "succeeded")
        .map(([f]) => f),
    );
    if (seenDone.current !== null && [...done].some((f) => !seenDone.current!.has(f))) onNewFile();
    seenDone.current = done;
    setFormats((s) => ({ ...s, data: next, readAt: Date.now() }));
    // follows the event's version only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveVersion]);
  // a new file landed on the run: read its files again
  const outputsKey = (live?.outputs ?? []).join(",");
  const lastOutputs = useRef(outputsKey);
  useEffect(() => {
    if (outputsKey === lastOutputs.current) return;
    lastOutputs.current = outputsKey;
    if (outputsKey !== "") onNewFile();
  }, [outputsKey, onNewFile]);
  // a finished job whose file the list doesn't show yet: read the files
  // once more when that's first seen (the outputs event brings the rest)
  const finishingKey = finishing.join(",");
  const lastFinishing = useRef("");
  useEffect(() => {
    if (finishingKey === lastFinishing.current) return;
    lastFinishing.current = finishingKey;
    if (finishingKey !== "") onNewFile();
  }, [finishingKey, onNewFile]);
  // the stream is down: its slow poll reads the jobs again while one runs
  const tick = useFallbackTick();
  useEffect(() => {
    if (tick === 0 || waiting === 0) return;
    void load().catch(() => {});
    if (finishing.length > 0) onNewFile();
    // follows the slow poll only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // the countdowns tick while something is being made
  const now = useNow(waiting > 0);

  async function start(format: Format): Promise<void> {
    setStarting(format);
    setNotice(null);
    setStartFailed((l) => l.filter((f) => f !== format));
    try {
      const job = await gateway.requestRunFormat(id, format);
      setFormats((s) => ({
        ...s,
        started: {
          ...s.started,
          [format]: { at: Date.now(), seconds: typeof job.estimated_seconds === "number" ? job.estimated_seconds : null },
        },
      }));
      await load();
    } catch (e) {
      if (e instanceof GatewayError && (e.code === "format_exists" || e.code === "format_in_progress")) {
        await load().catch(() => {});
      } else if (e instanceof GatewayError && e.code === "format_unavailable") {
        const reason = typeof e.details?.reason === "string" ? e.details.reason : "";
        setNotice(
          reason === "too_wide"
            ? t("files.another.tooWide")
            : (unavailableCopy(t)[reason] ?? t("files.another.failed")),
        );
        await load().catch(() => {});
      } else if (e instanceof GatewayError && e.code === "rate_limited") {
        setNotice(t("files.another.rateLimited"));
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
  const reason = data.unavailable_reason ? unavailableCopy(t)[data.unavailable_reason] : undefined;

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
                {t("files.another.open")}
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
                  {formatFor(f, t) ? <span className="text-xs text-fg-muted">{formatFor(f, t)}</span> : null}
                  {f === "half_sbs" ? <span className="text-xs text-fg-muted">{halfSbsSizeHint(t)}</span> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className="text-sm text-fg">{t("files.another.title")}</span>
        )}
        <Badge variant="secondary">{t("files.another.free")}</Badge>
        <span className="text-xs text-fg-muted">{t("files.another.madeFrom")}</span>
      </div>

      {[...new Set([...(starting ? [starting] : []), ...making, ...finishing])].map((f) => {
        const job = jobs[f];
        const started = formats.started[f];
        const est = job?.estimated_seconds ?? started?.seconds ?? null;
        const long = f === "mvhevc" || (est !== null && est > LONG_WAIT_S);
        const done = finishing.includes(f);
        const p = done ? null : jobProgress(job, started, formats.readAt, now, t);
        return (
          <div key={f} role="status" data-testid={`another-format-making-${f}`} className="flex flex-col gap-1 text-xs">
            <p className="flex flex-wrap items-center gap-2 text-fg">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {done
                ? t("files.another.formatAlmostReady", { format: nameOf(f) })
                : t("files.another.formatMaking", { format: nameOf(f) })}
              {p?.text ? (
                <span data-testid={`another-format-left-${f}`} className="text-fg-muted tabular-nums">
                  {p.text}
                </span>
              ) : null}
            </p>
            {p?.fraction !== undefined && p.fraction !== null ? (
              <div
                role="progressbar"
                aria-label={t("files.another.progressLabel", { format: nameOf(f) })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(p.fraction * 100)}
                className="ml-5.5 h-1 overflow-hidden rounded-full bg-surface-2"
              >
                <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(p.fraction * 100)}%` }} />
              </div>
            ) : null}
            {long && !done ? <p className="pl-5.5 text-fg-muted">{t("files.another.longWait")}</p> : null}
          </div>
        );
      })}
      {failed.map((f) => (
        <p key={f} data-testid={`another-format-failed-${f}`} className="flex flex-wrap items-center gap-2 text-xs">
          <span role="alert" className="text-destructive">
            {t("files.another.formatFailed", { format: nameOf(f) })}
          </span>
          <Button size="xs" variant="outline" onClick={() => void start(f)}>
            {t("files.another.tryAgain")}
          </Button>
        </p>
      ))}
      {notice !== null && <p className="text-xs text-fg-muted">{notice}</p>}
    </section>
  );
}
