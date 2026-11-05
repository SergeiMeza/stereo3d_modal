"use client";

/**
 * "Your steps" on Overview (owner 2026-11-05: the breadcrumb row read
 * like a path, not the flow): the steps in the rail's order and icons,
 * numbered, each done ✓, current (highlighted, its short status and its
 * one action) or upcoming (muted); an optional step that was passed is
 * skipped. Each step goes to its tab. Phones get four dots and the
 * current step's name. Everything comes from the project and the run
 * atoms (ADR 0138); nothing is kept here.
 */

import { useAtomValue } from "jotai";
import type { JSX } from "react";

import { analyzePercent } from "@/components/projects/AnalyzeBadge";
import { conversionAtom } from "@/components/steps/conversionAtoms";
import { Button } from "@/components/ui/button";
import { methodOf, type Conversion, type Project, type Step } from "@/lib/api/types";

import { tabIcon, type WorkspaceTabId } from "./PageTabs";

export type StepState = "done" | "current" | "upcoming" | "skipped";

export interface StepView {
  tab: WorkspaceTabId;
  label: string;
  optional: boolean;
  state: StepState;
  /** the current step's short status ("Analyzing… 70%", "Ready") */
  status?: string;
  /** the current step's one action */
  action?: string;
}

interface StepDef {
  tab: WorkspaceTabId;
  label: string;
  optional?: boolean;
  /** an optional step counts as done after a run of this kind */
  run?: Step;
}

const FLOWS: Record<"lifelike" | "classic", readonly StepDef[]> = {
  lifelike: [
    { tab: "scenes", label: "Scenes" },
    { tab: "preview", label: "Preview", optional: true, run: "lifelike_preview" },
    { tab: "make", label: "Make 3D" },
    { tab: "files", label: "Files" },
  ],
  classic: [
    { tab: "scenes", label: "Scenes" },
    { tab: "depth", label: "Depth", optional: true, run: "depth_preview" },
    { tab: "look", label: "3D look", optional: true, run: "stereo_preview" },
    { tab: "make", label: "Make 3D" },
    { tab: "files", label: "Files" },
  ],
};

const ACTIVE = new Set(["created", "paid", "processing"]);

/** The steps and their states, from the project (and the active run's
 * latest poll). */
export function overviewSteps(
  project: Project,
  opts: { live?: Conversion | null; previewFree?: boolean } = {},
): StepView[] {
  const method = methodOf(project) === "classic" ? "classic" : "lifelike";
  const flow = FLOWS[method];
  const runs = project.conversions ?? [];
  const fullRuns = runs.filter((c) => (c.step ?? "production") === "production");
  const listed = fullRuns.find((c) => ACTIVE.has(c.state)) ?? null;
  const active = listed && opts.live?.conversion_id === listed.conversion_id ? opts.live : listed;
  const running = active !== null && ACTIVE.has(active.state);
  const made = fullRuns.some((c) => c.state === "succeeded");
  const analyzed = project.analyze.state === "succeeded" && !!project.probe;
  const scenesDone = analyzed && !!project.scenes;
  const ran = (step?: Step) => step !== undefined && runs.some((c) => c.step === step && c.state === "succeeded");

  let current: WorkspaceTabId;
  if (!scenesDone) current = "scenes";
  else if (running) current = "make";
  else if (made) current = "files";
  else if (method === "lifelike" && !ran("lifelike_preview")) current = "preview";
  else current = "make";
  const at = flow.findIndex((s) => s.tab === current);

  return flow.map((s, i): StepView => {
    const base = { tab: s.tab, label: s.label, optional: s.optional === true };
    if (i > at) return { ...base, state: "upcoming" };
    if (i < at) return { ...base, state: s.optional && !ran(s.run) ? "skipped" : "done" };
    switch (s.tab) {
      case "scenes": {
        const pct = analyzePercent(project.analyze);
        return project.analyze.state === "running"
          ? { ...base, state: "current", status: pct !== null ? `Analyzing… ${pct}%` : "Analyzing…" }
          : project.analyze.state === "failed"
            ? { ...base, state: "current", status: "Couldn't read the video" }
            : !analyzed
              ? { ...base, state: "current", status: "Waiting" }
              : { ...base, state: "current", status: "Ready", action: "Pick scenes" };
      }
      case "preview":
        return {
          ...base,
          state: "current",
          status: "Ready",
          action: opts.previewFree ? "Make a free preview" : "Make a preview",
        };
      case "make": {
        if (running && active) {
          const pct = Math.round(Math.min(Math.max(active.progress ?? 0, 0), 1) * 100);
          const waiting = active.waiting_for_gpu === true || active.state !== "processing";
          return { ...base, state: "current", status: waiting ? "Waiting in line" : `Making… ${pct}%` };
        }
        return { ...base, state: "current", status: "Ready", action: "Make 3D" };
      }
      default:
        return { ...base, state: "current", status: "Ready", action: "Download" };
    }
  });
}

export function OverviewSteps({
  project,
  previewFree,
  onNavigate,
}: {
  project: Project;
  previewFree?: boolean;
  onNavigate: (tab: WorkspaceTabId) => void;
}): JSX.Element {
  const activeId =
    (project.conversions ?? []).find((c) => (c.step ?? "production") === "production" && ACTIVE.has(c.state))
      ?.conversion_id ?? "";
  // the run's latest poll, when a tracker has one (ADR 0138)
  const live = useAtomValue(conversionAtom(activeId));
  const steps = overviewSteps(project, { live, previewFree });
  const at = steps.findIndex((s) => s.state === "current");
  const cur = steps[at];

  return (
    <section data-testid="overview-steps" aria-labelledby="your-steps" className="flex flex-col gap-3">
      <h2 id="your-steps" className="text-sm font-semibold text-fg">
        Your steps
      </h2>

      {/* phones: dots and the current step */}
      <div data-testid="steps-compact" className="flex flex-col gap-2 rounded-xl border border-edge bg-surface-1 p-3 sm:hidden">
        <div className="flex items-center gap-2" aria-hidden>
          {steps.map((s) => (
            <span
              key={s.tab}
              className={`h-1.5 flex-1 rounded-full ${
                s.state === "done" ? "bg-primary/60" : s.state === "current" ? "bg-primary" : "bg-surface-2"
              }`}
            />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => onNavigate(cur.tab)} className="min-w-0 flex-1 text-left">
            <span className="block text-xs text-fg-muted">
              Step {at + 1} of {steps.length}
            </span>
            <span className="block truncate text-sm font-medium text-fg">
              {cur.label}
              {cur.status ? <span className="font-normal text-fg-muted"> · {cur.status}</span> : null}
            </span>
          </button>
          {cur.action ? (
            <Button size="sm" data-testid="step-action-compact" onClick={() => onNavigate(cur.tab)}>
              {cur.action}
            </Button>
          ) : null}
        </div>
      </div>

      {/* tablet and up: every step */}
      <ol
        data-testid="steps-full"
        className="hidden gap-2 sm:grid"
        style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      >
        {steps.map((s, i) => {
          const current = s.state === "current";
          return (
            <li
              key={s.tab}
              data-testid={`step-${s.tab}`}
              data-state={s.state}
              aria-current={current ? "step" : undefined}
              className={`flex min-w-0 flex-col gap-2 rounded-xl border p-3 ${
                current ? "border-primary/60 bg-primary/5" : "border-edge bg-surface-1"
              }`}
            >
              <button
                type="button"
                onClick={() => onNavigate(s.tab)}
                className={`flex min-w-0 items-center gap-2 text-left text-sm ${
                  s.state === "upcoming" || s.state === "skipped" ? "text-fg-muted" : "text-fg"
                }`}
              >
                <span
                  aria-hidden
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${
                    s.state === "done"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : current
                        ? "bg-primary text-primary-foreground"
                        : "bg-surface-2 text-fg-muted"
                  }`}
                >
                  {s.state === "done" ? "✓" : i + 1}
                </span>
                <span aria-hidden className="shrink-0 opacity-80">
                  {tabIcon(s.tab)}
                </span>
                <span className="min-w-0 truncate font-medium">{s.label}</span>
                {s.optional ? (
                  <span className="shrink-0 rounded-full border border-edge px-1.5 text-[10px] text-fg-muted">
                    Optional
                  </span>
                ) : null}
              </button>
              {current && s.status ? (
                <p data-testid="step-status" className="text-xs text-fg-muted">
                  {s.status}
                </p>
              ) : null}
              {current && s.action ? (
                <Button size="sm" data-testid="step-action" className="w-fit" onClick={() => onNavigate(s.tab)}>
                  {s.action}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
