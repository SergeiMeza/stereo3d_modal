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

import { useEffect, useState } from "react";
import type { JSX } from "react";

import { AnalyzeProgress } from "@/components/projects/AnalyzeBadge";
import { LIFELIKE_PREVIEW_SECONDS, METHOD_TAGS } from "@/components/steps/methods";
import { formatCents } from "@/components/steps/money";
import { Button } from "@/components/ui/button";
import {
  methodOf,
  type Method,
  type Project,
  type StepQuoteResponse,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { formatClock } from "@/lib/format";
import { parseRational } from "@/lib/frames";
import { METHOD_NAMES, qualityChoices, videoFacts } from "@/lib/glossary";

import {
  MoveToLifelikeOffer,
  priceAndTime,
  useMethodQuotes,
} from "./MethodChooser";
import type { WorkspaceTabId } from "./PageTabs";

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

interface StepLink {
  tab: WorkspaceTabId;
  label: string;
}

const STEPS: Record<Method, readonly StepLink[]> = {
  lifelike: [
    { tab: "scenes", label: "Scenes" },
    { tab: "preview", label: "Preview (optional)" },
    { tab: "make", label: "Make 3D" },
    { tab: "files", label: "Files" },
  ],
  classic: [
    { tab: "scenes", label: "Scenes" },
    { tab: "depth", label: "Depth (optional)" },
    { tab: "look", label: "3D look (optional)" },
    { tab: "make", label: "Make 3D" },
    { tab: "files", label: "Files" },
  ],
};

/** The price of the Preview page's default: the first seconds of the
 * video at the best quality it reaches. */
function usePreviewQuote(project: Project, enabled: boolean): StepQuoteResponse | null {
  const gateway = useGateway();
  const [quote, setQuote] = useState<StepQuoteResponse | null>(null);
  const probe = project.probe;
  const ready = enabled && project.analyze.state === "succeeded" && !!probe;
  const top = qualityChoices(project).at(-1)?.preset ?? "1080p";
  const key = `${project.project_id}:${ready}:${top}`;
  useEffect(() => {
    if (!ready || !probe) return;
    let cancelled = false;
    const fps = parseRational(probe.fps_rational);
    const span = Math.round((LIFELIKE_PREVIEW_SECONDS * fps.num) / fps.den);
    gateway
      .quoteStep(project.project_id, {
        step: "lifelike_preview",
        preset: top,
        formats: ["sbs"],
        from_frame: 0,
        to_frame: Math.min(span, probe.num_frames),
        method: "lifelike",
        platform: "web",
      })
      .then(
        (q) => {
          if (!cancelled) setQuote(q);
        },
        () => {
          if (!cancelled) setQuote(null);
        },
      );
    return () => {
      cancelled = true;
    };
    // the key covers project id, readiness and the quality
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, key]);
  return ready ? quote : null;
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
}

export function OverviewTab({
  project,
  onNavigate,
  onProjectChanged,
}: OverviewTabProps): JSX.Element {
  const method = methodOf(project);
  const quotes = useMethodQuotes(project, [method]);
  const previewQuote = usePreviewQuote(project, method === "lifelike");
  const probe = project.probe;
  const analyzed = project.analyze.state === "succeeded" && !!probe;
  const thumb =
    project.scene_thumbs?.[0]?.url ?? project.strip_thumbs?.[0]?.url;
  const own = quotes[method];
  const ownPrice = priceAndTime(own);

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
                    {own ? `At ${own.qualityLabel}` : "Price"}
                  </dt>
                  <dd data-testid="overview-price" className="font-mono text-fg">
                    {own === undefined
                      ? "Pricing this video…"
                      : (ownPrice ?? own.error)}
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {method === "lifelike" ? (
                  <>
                    <Button
                      data-testid="overview-main"
                      onClick={() => onNavigate("preview")}
                    >
                      Preview a moment
                      {previewQuote
                        ? ` · ${formatCents(previewQuote.quote.amount_cents)}`
                        : ""}
                    </Button>
                    <button
                      type="button"
                      onClick={() => onNavigate("make")}
                      className="text-sm text-primary hover:underline"
                    >
                      or go straight to Make 3D
                    </button>
                  </>
                ) : (
                  <>
                    <Button
                      data-testid="overview-main"
                      onClick={() => onNavigate("make")}
                    >
                      Make 3D
                    </Button>
                    <button
                      type="button"
                      onClick={() => onNavigate("look")}
                      className="text-sm text-primary hover:underline"
                    >
                      or check the 3D look first
                    </button>
                  </>
                )}
              </div>
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
                      We&apos;re looking through your video. Prices appear
                      here when it&apos;s done. Free.
                    </p>
                  </div>
                </>
              ) : project.analyze.state === "failed" ? (
                <p className="text-sm">
                  We couldn&apos;t read this video. Try uploading it again.
                </p>
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

      <nav
        data-testid="overview-steps"
        aria-label="Steps"
        className="flex flex-wrap items-center gap-y-1 pl-1 text-sm text-fg-muted"
      >
        {STEPS[method].map((s, i) => (
          <span key={s.tab} className="flex items-center">
            {i > 0 ? (
              <span aria-hidden className="mx-1.5 text-fg-muted/50">
                ›
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onNavigate(s.tab)}
              className="hover:text-fg"
            >
              {s.tab === "scenes" && project.scenes ? (
                <span className="mr-1 text-emerald-400" aria-label="done">
                  ✓
                </span>
              ) : null}
              {s.label}
            </button>
          </span>
        ))}
      </nav>

      {onProjectChanged !== undefined && method === "classic" && analyzed ? (
        <MoveToLifelikeOffer project={project} onChanged={onProjectChanged} />
      ) : null}
    </div>
  );
}
