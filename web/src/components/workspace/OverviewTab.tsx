"use client";

/**
 * Overview (screen 03, S3D-25/45): the project summary first — the video
 * at a glance, its method, what you'll get and this video's price and
 * time — with ONE main button, then the steps in a line. There is no
 * method chooser (S3D-01): new projects are Lifelike and never mention
 * Classic; an existing Classic project carries its "Older method" tag
 * and the one-way offer to move to Lifelike with this video's Lifelike
 * price and time (S3D-44).
 *
 * Every amount is a gateway quote; nothing is priced here. Summary labels
 * never name Red-cyan (owner note): it is a Make 3D format option only.
 */

import type { JSX } from "react";

import { AnalyzeProgress } from "@/components/projects/AnalyzeBadge";
import { LIFELIKE_PREVIEW_SECONDS, METHOD_TAGS } from "@/components/steps/methods";
import { useVariantQuotes } from "@/components/steps/priceAtoms";
import { Button } from "@/components/ui/button";
import {
  methodOf,
  posterUrl,
  type Method,
  type Project,
  type StepConversionRequest,
  type StepQuoteResponse,
} from "@/lib/api/types";
import { formatClock } from "@/lib/format";
import { parseRational } from "@/lib/frames";
import { METHOD_NAMES, qualityChoices, videoFacts } from "@/lib/glossary";

import {
  MoveToLifelikeOffer,
  priceAndTime,
  useMethodQuotes,
} from "./MethodChooser";
import type { WorkspaceTabId } from "./PageTabs";
import { BarsNotice } from "./BarsSetting";
import { OverviewSteps, primaryAction, secondaryAction, useOverviewSteps } from "./OverviewSteps";

/** What the summary says you'll get (the default files of a full run). */
const YOU_GET = "Vision Pro spatial video + Side by side";

/** A run that cost (or is costing) money: anything but failed, cancelled
 * or never-started runs. The method chooser stays open until one exists
 * (S3D-01). */
export function hasPaidRun(project: Project): boolean {
  return (project.conversions ?? []).some(
    (c) => c.state !== "failed" && c.state !== "canceled" && c.state !== "expired",
  );
}

/** The price of the Preview page's default: the first seconds of the
 * video at the best quality it reaches. */
function usePreviewQuote(project: Project, enabled: boolean): StepQuoteResponse | null {
  const probe = project.probe;
  const ready = enabled && project.analyze.state === "succeeded" && !!probe;
  const top = qualityChoices(project).at(-1)?.preset ?? "1080p";
  const reqs: Record<string, StepConversionRequest> = {};
  if (ready && probe) {
    const fps = parseRational(probe.fps_rational);
    const span = Math.round((LIFELIKE_PREVIEW_SECONDS * fps.num) / fps.den);
    reqs.preview = {
      step: "lifelike_preview",
      preset: top,
      formats: ["sbs"],
      from_frame: 0,
      to_frame: Math.min(span, probe.num_frames),
      method: "lifelike",
      platform: "web",
    };
  }
  // ADR 0138: the shared side-price cache (one quote per request)
  const e = useVariantQuotes(project.project_id, reqs, 0).preview;
  return ready && e?.status === "done" ? e.quote : null;
}

function MethodChip({ method }: { method: Method }): JSX.Element {
  return (
    <span
      data-testid="overview-method"
      className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs ${
        method === "lifelike"
          ? "ll-chip"
          : "border border-edge bg-surface-2 text-fg-muted"
      }`}
    >
      {method === "lifelike" ? (
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-gradient-to-br from-[var(--ll-a)] to-[var(--ll-c)]"
        />
      ) : null}
      {METHOD_NAMES[method]}
      {METHOD_TAGS[method] ? (
        <span className="text-[10px] text-fg-muted/80">· {METHOD_TAGS[method]}</span>
      ) : null}
    </span>
  );
}

export interface OverviewTabProps {
  project: Project;
  onNavigate: (tab: WorkspaceTabId) => void;
  /** The method chooser's PATCH answer; absent when the method can't
   * change right now. */
  onProjectChanged?: (project: Project) => void;
  /** any other PATCH answer (the black bars choice) */
  onProjectUpdated?: (project: Project) => void;
}

export function OverviewTab({
  project,
  onNavigate,
  onProjectChanged,
  onProjectUpdated,
}: OverviewTabProps): JSX.Element {
  const method = methodOf(project);
  const quotes = useMethodQuotes(project, [method]);
  const previewQuote = usePreviewQuote(project, method === "lifelike");
  const probe = project.probe;
  const analyzed = project.analyze.state === "succeeded" && !!probe;
  const thumb =
    posterUrl(project);
  const own = quotes[method];
  const ownPrice = priceAndTime(own);
  const steps = useOverviewSteps(project, {
    previewFree: previewQuote?.payment_flow === "free_preview",
    previewCents: previewQuote ? previewQuote.quote.amount_cents : null,
  });
  const primary = primaryAction(steps);
  const secondary = secondaryAction(steps, project);

  return (
    <div data-testid="overview-tab" className="mx-auto flex max-w-5xl flex-col gap-5">
      <section
        data-testid="overview-summary"
        className="grid items-center gap-6 rounded-xl border border-edge bg-surface-1 p-4 md:grid-cols-[340px_1fr]"
      >
        <div className="relative aspect-video overflow-hidden rounded-lg bg-surface-2">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" className="h-full w-full object-cover" />
          ) : null}
          {probe ? (
            <span className="absolute right-2 bottom-2 rounded bg-black/70 px-1.5 font-mono text-[11px] text-white">
              {formatClock(probe.duration_s)}
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-fg">
              {project.name || "Untitled project"}
            </h2>
            {probe ? (
              <p data-testid="overview-facts" className="text-sm text-fg-muted">
                {videoFacts(project)}
              </p>
            ) : null}
          </div>

          {analyzed ? (
            <>
              <dl className="grid overflow-hidden rounded-lg border border-edge text-sm sm:grid-cols-[0.9fr_1.4fr_1.1fr]">
                <div className="flex flex-col gap-1.5 px-3.5 py-3">
                  <dt className="text-xs text-fg-muted">Method</dt>
                  <dd>
                    <MethodChip method={method} />
                  </dd>
                </div>
                <div className="flex flex-col gap-1.5 border-t border-edge px-3.5 py-3 sm:border-t-0 sm:border-l">
                  <dt className="text-xs text-fg-muted">You&apos;ll get</dt>
                  <dd data-testid="overview-you-get" className="text-fg">
                    {YOU_GET}
                  </dd>
                </div>
                <div className="flex flex-col gap-1.5 border-t border-edge px-3.5 py-3 sm:border-t-0 sm:border-l">
                  <dt className="text-xs text-fg-muted">
                    {project.sample ? "Price" : own ? `At ${own.qualityLabel}` : "Price"}
                  </dt>
                  <dd data-testid="overview-price" className={project.sample ? "text-fg" : "font-mono text-fg"}>
                    {project.sample
                      ? "A sample: already in 3D, never billed"
                      : own === undefined
                      ? "Pricing this video…"
                      : (ownPrice ?? own.error)}
                  </dd>
                </div>
              </dl>

              {/* QA 2026-11-05: the card's main action is the current
                  step's (one helper with Your steps), so they agree */}
              {primary ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <Button data-testid="overview-main" onClick={() => onNavigate(primary.tab)}>
                    {primary.label}
                  </Button>
                  {secondary ? (
                    <button
                      type="button"
                      data-testid="overview-secondary"
                      onClick={() => onNavigate(secondary.tab)}
                      className="text-sm text-primary hover:underline"
                    >
                      {secondary.label}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <div
              data-testid="analyzing-state"
              className="flex items-center gap-3 rounded-lg border border-edge bg-surface-2 p-4 text-fg-muted"
            >
              {project.analyze.state === "running" ? (
                <>
                  <span
                    aria-hidden
                    className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent"
                  />
                  <div className="min-w-0 flex-1">
                    <AnalyzeProgress analyze={project.analyze} />
                    <p className="mt-1 text-sm">
                      We&apos;re analyzing your video. Prices appear
                      here when it&apos;s done. Free.
                    </p>
                  </div>
                </>
              ) : project.analyze.state === "failed" ? (
                // the notice above the page offers Try again and support
                <p className="text-sm">We couldn&apos;t analyze this video.</p>
              ) : (
                <p className="text-sm">
                  Your video is waiting to be looked through. Prices appear
                  here when it&apos;s done.
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      {/* owner 2026-11-05: the flow as steps, right under the summary
          (QA: above the black bars on a phone) */}
      <OverviewSteps steps={steps} onNavigate={onNavigate} />

      {/* owner request 2026-11-04: say when the video has black bars */}
      {analyzed && onProjectUpdated ? (
        <BarsNotice project={project} onProjectChanged={onProjectUpdated} />
      ) : null}


      {onProjectChanged !== undefined && method === "classic" && analyzed ? (
        <MoveToLifelikeOffer project={project} onChanged={onProjectChanged} />
      ) : null}
    </div>
  );
}
