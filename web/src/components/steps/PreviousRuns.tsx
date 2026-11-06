"use client";

/**
 * Make 3D's Previous runs (owner 2026-11-07): earlier full runs of this
 * project, newest first, at the top of the tab so they can't be missed.
 * Hidden until there is one (previews don't count). Up to 3 show; more
 * sit behind "Show all (n)". Each row: what part, quality and fps, the
 * day, the state in plain words (a bar while it's being made), what it
 * cost, and Watch / Download / Files for a finished one. A run being made
 * is highlighted so the same thing isn't ordered twice, and the note by
 * the Make 3D button (AlreadyMadeNote) says when the form matches a run
 * already made or being made. Nothing here blocks ordering.
 */

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Collapsible } from "radix-ui";
import type { JSX } from "react";

import type { Conversion, Project, StepConversionRequest } from "@/lib/api/types";
import { formatClock, formatShortDay } from "@/lib/format";
import { frameToSeconds, parseRational } from "@/lib/frames";
import { qualityLabelFor } from "@/lib/glossary";
import { paymentStatus } from "@/lib/billingCopy";

import { conversionAtom } from "./conversionAtoms";
import { fpsLabel } from "./frameRate";
import { formatCents } from "./money";
import { previousRunsOpenAtom } from "./previousRunsAtoms";
import { PreviewDownloads, useRunFiles } from "./RunFiles";
import { RunProgressCompact } from "./RunProgressCompact";
import { ViewIn3D } from "./ViewIn3D";

/** Rows shown before "Show all". */
export const PREVIOUS_RUNS_SHOWN = 3;

const IN_PROGRESS: ReadonlySet<Conversion["state"]> = new Set(["created", "paid", "processing"]);

export function isInProgress(c: Conversion): boolean {
  return IN_PROGRESS.has(c.state);
}

/** The project's full runs, newest first, with a just-started one the
 * project's list hasn't caught up with yet. */
export function previousRuns(project: Project, active?: Conversion | null): Conversion[] {
  const listed = (project.conversions ?? []).filter((c) => c.step === "production");
  const fresh =
    active && active.step === "production" && !listed.some((c) => c.conversion_id === active.conversion_id)
      ? [active]
      : [];
  return [...fresh, ...listed].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** The state in plain words. */
export function runWord(c: Conversion): string {
  const b = c.billing?.status;
  if (b === "refunded" || b === "refund_pending") return "Refunded";
  switch (c.state) {
    case "created":
    case "paid":
      return "Waiting in line";
    case "processing":
      return c.waiting_for_gpu ? "Waiting in line" : "Making…";
    case "succeeded":
      return "Ready";
    case "failed":
      return "Failed";
    case "canceled":
      return "Cancelled";
    case "expired":
      return "Didn't start";
  }
}

/** What it cost: the amount taken, or why nothing was. */
export function runPrice(c: Conversion): string {
  const word = paymentStatus(c);
  if (word === "Not charged") return "Not charged";
  return formatCents(c.billing?.charged_cents ?? c.quote.amount_cents);
}

/** "Whole video" or "0:12 – 1:40". */
function rangeText(c: Conversion, project: Project): string {
  const { from_frame: from, to_frame: to } = c.params;
  if (from === undefined || to === undefined || !project.probe) return "Whole video";
  const fps = parseRational(project.probe.fps_rational);
  if (from === 0 && to >= project.probe.num_frames) return "Whole video";
  return `${formatClock(frameToSeconds(from, fps))} – ${formatClock(frameToSeconds(to, fps))}`;
}

/** "4K · 24 fps" */
function outputText(c: Conversion, project: Project): string {
  const fps = c.params.target_fps ?? project.probe?.fps;
  return [qualityLabelFor(project, c.params.preset), fps ? fpsLabel(fps) : null]
    .filter(Boolean)
    .join(" · ");
}

/** The run's frame span, the whole video when it sent none. */
function span(p: { from_frame?: number; to_frame?: number }, numFrames: number): [number, number] {
  return [p.from_frame ?? 0, Math.min(p.to_frame ?? numFrames, numFrames)];
}

/** The form would order what this run made (or is making): same part,
 * quality, frame rate and files. */
export function sameOrder(c: Conversion, request: StepConversionRequest, numFrames: number): boolean {
  if (c.params.preset !== request.preset) return false;
  const [a0, a1] = span(c.params, numFrames);
  const [b0, b1] = span(request, numFrames);
  if (a0 !== b0 || a1 !== b1) return false;
  if ((c.params.target_fps ?? null) !== (request.target_fps ?? null)) return false;
  const made = [...(c.params.formats ?? [])].sort().join(",");
  const asked = [...(request.formats ?? [])].sort().join(",");
  return made === asked;
}

function rowId(c: Conversion): string {
  return `previous-run-${c.conversion_id}`;
}

export function PreviousRuns({
  project,
  active,
}: {
  project: Project;
  active?: Conversion | null;
}): JSX.Element | null {
  const runs = previousRuns(project, active);
  const [open, setOpen] = useAtom(previousRunsOpenAtom(project.project_id));
  if (runs.length === 0) return null;
  const first = runs.slice(0, PREVIOUS_RUNS_SHOWN);
  const rest = runs.slice(PREVIOUS_RUNS_SHOWN);
  return (
    <section
      aria-label="Previous runs"
      data-testid="previous-runs"
      className="flex flex-col gap-2 rounded-xl border border-edge bg-surface-1 p-4"
    >
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-fg">Previous runs</h3>
        <span className="text-xs text-fg-muted">{runs.length}</span>
        <a href="#tab=files" className="ml-auto text-xs text-primary hover:underline">
          All files
        </a>
      </div>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <ul className="flex flex-col gap-2">
          {first.map((c) => (
            <RunRow key={c.conversion_id} project={project} conversion={c} />
          ))}
        </ul>
        {rest.length > 0 ? (
          <>
            <Collapsible.Content asChild>
              <ul className="mt-2 flex flex-col gap-2">
                {rest.map((c) => (
                  <RunRow key={c.conversion_id} project={project} conversion={c} />
                ))}
              </ul>
            </Collapsible.Content>
            <Collapsible.Trigger className="mt-2 text-xs text-primary hover:underline">
              {open ? "Show fewer" : `Show all (${runs.length})`}
            </Collapsible.Trigger>
          </>
        ) : null}
      </Collapsible.Root>
    </section>
  );
}

function RunRow({ project, conversion }: { project: Project; conversion: Conversion }): JSX.Element {
  // the run as last polled (the tracker and the bar write it), so a run
  // that just finished reads Ready before the project's list is read again
  const polled = useAtomValue(conversionAtom(conversion.conversion_id));
  const c = polled ?? conversion;
  const running = isInProgress(c);
  return (
    <li
      id={rowId(c)}
      tabIndex={-1}
      data-testid="previous-run"
      data-conversion-id={c.conversion_id}
      data-running={running ? "true" : undefined}
      className={`flex flex-col gap-2 rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        running ? "border-primary/60 bg-primary/10" : "border-edge bg-surface-0"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-fg">{rangeText(c, project)}</span>
        <span className="text-fg-muted">{outputText(c, project)}</span>
        <span className="text-fg-muted">{formatShortDay(c.created_at)}</span>
        <span className="ml-auto flex items-center gap-3">
          <span
            data-testid="previous-run-state"
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              c.state === "succeeded" && runWord(c) === "Ready"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : running
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : c.state === "failed"
                    ? "border-red-500/30 bg-red-500/10 text-red-300"
                    : "border-edge bg-surface-2 text-fg-muted"
            }`}
          >
            {runWord(c)}
          </span>
          <span data-testid="previous-run-price" className="font-mono text-fg-muted">
            {runPrice(c)}
          </span>
        </span>
      </div>
      {running ? (
        // its one-line step truncates instead of widening the page (390 px)
        <div className="min-w-0 [contain:inline-size]">
          <RunProgressCompact conversion={c} poll chip={false} />
        </div>
      ) : null}
      {c.state === "succeeded" ? (
        project.files_deleted_at ? (
          <p data-testid="previous-run-gone" className="text-xs text-fg-muted">
            These files were deleted on {formatShortDay(project.files_deleted_at)}.
          </p>
        ) : (
          <RunActions conversion={c} />
        )
      ) : null}
    </li>
  );
}

/** Watch, the downloads and Files, from the same files Files lists. */
function RunActions({ conversion: c }: { conversion: Conversion }): JSX.Element {
  const { files, error } = useRunFiles(c);
  const split = (c.parts?.length ?? 0) > 1;
  // a split run plays its first part
  const playable =
    files === null
      ? null
      : Object.fromEntries(
          files.filter((f) => f.part === undefined || f.part === 1).map((f) => [f.format, f.url]),
        );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {error ? (
        <span className="text-xs text-fg-muted">The files can&apos;t be opened right now.</span>
      ) : (
        <>
          <ViewIn3D files={playable} size="xs" hideHint flatLabel="Watch" />
          {split ? (
            <span className="text-xs text-fg-muted">{c.parts!.length} parts, in Files</span>
          ) : (
            <PreviewDownloads conversion={c} />
          )}
        </>
      )}
      <a
        href="#tab=files"
        data-testid="previous-run-files"
        className="ml-auto text-xs text-primary hover:underline"
      >
        Files
      </a>
    </div>
  );
}

/** By the Make 3D button: the form matches a run already made or being
 * made. A gentle note; ordering stays open. */
export function AlreadyMadeNote({
  project,
  active,
  request,
}: {
  project: Project;
  active?: Conversion | null;
  request: StepConversionRequest;
}): JSX.Element | null {
  const numFrames = project.probe?.num_frames ?? 0;
  const setOpen = useSetAtom(previousRunsOpenAtom(project.project_id));
  const runs = previousRuns(project, active);
  const match = runs.find(
    (c) => (c.state === "succeeded" || isInProgress(c)) && sameOrder(c, request, numFrames),
  );
  if (!match) return null;
  const day = formatShortDay(match.created_at);
  const running = isInProgress(match);
  const show = () => {
    if (runs.indexOf(match) >= PREVIOUS_RUNS_SHOWN) setOpen(true);
    // after the list opens
    requestAnimationFrame(() => {
      const el = document.getElementById(rowId(match));
      el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      el?.focus({ preventScroll: true });
    });
  };
  return (
    <p data-testid="already-made" className="text-center text-xs text-fg-muted">
      {running ? `You're already making this (ordered ${day})` : `You already made this on ${day}`}
      {" · "}
      <button type="button" onClick={show} className="text-primary hover:underline">
        {running ? "See progress" : "Download"}
      </button>
    </p>
  );
}
