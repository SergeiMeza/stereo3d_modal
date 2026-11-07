"use client";

/**
 * "Your steps" on Overview (owner 2026-11-05: the breadcrumb row read
 * like a path, not the flow): the steps in the rail's order and icons,
 * numbered, each done ✓, current (highlighted, with its short status) or
 * upcoming (muted); an optional step that was passed is skipped. Each step
 * goes to its tab. The current step's action is the Overview card's main
 * button (primaryAction), so the stepper itself carries none (QA
 * 2026-11-05: no twin Download buttons). Phones get four dots and the
 * current step's name. Everything comes from the project with its runs
 * live (lib/live); nothing is kept here.
 */

import type { JSX } from "react";

import { analyzePercent } from "@/components/projects/AnalyzeBadge";
import { formatCents } from "@/components/steps/money";
import { methodOf, type Project, type Step } from "@/lib/api/types";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import { useLiveProject } from "@/lib/live/useLive";

import { tabIcon, tabLabel, type WorkspaceTabId } from "./PageTabs";

export type StepState = "done" | "current" | "upcoming" | "skipped";

export interface StepView {
  tab: WorkspaceTabId;
  label: string;
  optional: boolean;
  state: StepState;
  /** the current step's short status ("Analyzing… 70%", "Ready") */
  status?: string;
  /** the current step's one action (the Overview card's main button) */
  action?: string;
}

interface StepDef {
  tab: WorkspaceTabId;
  optional?: boolean;
  /** an optional step counts as done after a run of this kind */
  run?: Step;
}

const FLOWS: Record<"lifelike" | "classic", readonly StepDef[]> = {
  lifelike: [
    { tab: "scenes" },
    { tab: "preview", optional: true, run: "lifelike_preview" },
    { tab: "make" },
    { tab: "files" },
  ],
  classic: [
    { tab: "scenes" },
    { tab: "depth", optional: true, run: "depth_preview" },
    { tab: "look", optional: true, run: "stereo_preview" },
    { tab: "make" },
    { tab: "files" },
  ],
};

const ACTIVE = new Set(["created", "paid", "processing"]);

/** The steps and their states, from the project (with its runs live). */
export interface StepsContext {
  previewFree?: boolean;
  /** the Preview page default's price, when known */
  previewCents?: number | null;
}

export function overviewSteps(project: Project, opts: StepsContext = {}, t: Tr = EN): StepView[] {
  const method = methodOf(project) === "classic" ? "classic" : "lifelike";
  const flow = FLOWS[method];
  const runs = project.conversions ?? [];
  const fullRuns = runs.filter((c) => (c.step ?? "production") === "production");
  const active = fullRuns.find((c) => ACTIVE.has(c.state)) ?? null;
  const running = active !== null;
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
    const base = { tab: s.tab, label: tabLabel(s.tab, t), optional: s.optional === true };
    if (i > at) return { ...base, state: "upcoming" };
    if (i < at) return { ...base, state: s.optional && !ran(s.run) ? "skipped" : "done" };
    switch (s.tab) {
      case "scenes": {
        const pct = analyzePercent(project.analyze);
        return project.analyze.state === "running"
          ? {
              ...base,
              state: "current",
              status:
                pct !== null
                  ? t("workspace.steps.status.analyzingPercent", { percent: String(pct) })
                  : t("workspace.steps.status.analyzing"),
            }
          : project.analyze.state === "failed"
            ? { ...base, state: "current", status: t("workspace.steps.status.unreadable") }
            : !analyzed
              ? { ...base, state: "current", status: t("workspace.steps.status.waiting") }
              : {
                  ...base,
                  state: "current",
                  status: t("workspace.steps.status.ready"),
                  action: t("workspace.steps.action.pickScenes"),
                };
      }
      case "preview":
        return {
          ...base,
          state: "current",
          status: t("workspace.steps.status.ready"),
          action: opts.previewFree
            ? t("workspace.steps.action.freePreview")
            : typeof opts.previewCents === "number"
              ? t("workspace.steps.action.previewPriced", { price: formatCents(opts.previewCents, t) })
              : t("workspace.steps.action.preview"),
        };
      case "make": {
        if (running && active) {
          const pct = Math.round(Math.min(Math.max(active.progress ?? 0, 0), 1) * 100);
          const waiting = active.waiting_for_gpu === true || active.state !== "processing";
          return {
            ...base,
            state: "current",
            status: waiting
              ? t("workspace.steps.status.waitingInLine")
              : t("workspace.steps.status.makingPercent", { percent: String(pct) }),
            action: t("workspace.steps.action.seeProgress"),
          };
        }
        return {
          ...base,
          state: "current",
          status: t("workspace.steps.status.ready"),
          action: t("workspace.steps.action.make"),
        };
      }
      default:
        return {
          ...base,
          state: "current",
          status: t("workspace.steps.status.ready"),
          action: project.sample ? t("workspace.steps.action.seeFiles") : t("workspace.steps.action.download"),
        };
    }
  });
}

/** The steps from the project with its runs live (owner bug 2026-11-07:
 * "Making… 62%" stayed after the run finished, since nothing updated the
 * run while Overview was open), for the stepper and the Overview card
 * alike. */
export function useOverviewSteps(project: Project, opts: StepsContext = {}): StepView[] {
  const t = useT();
  return overviewSteps(useLiveProject(project), opts, t);
}

export interface StepAction {
  label: string;
  tab: WorkspaceTabId;
}

/** QA 2026-11-05: the Overview card's main button is the current step's
 * action, so the card and the stepper never disagree. */
export function primaryAction(steps: readonly StepView[]): StepAction | null {
  const cur = steps.find((s) => s.state === "current");
  return cur?.action ? { label: cur.action, tab: cur.tab } : null;
}

/** The card's one quiet alternative to the main action. */
export function secondaryAction(steps: readonly StepView[], project: Project, t: Tr = EN): StepAction | null {
  const cur = steps.find((s) => s.state === "current");
  if (!cur || project.sample) return null;
  const classic = methodOf(project) === "classic";
  switch (cur.tab) {
    case "preview":
      return { label: t("workspace.steps.secondary.straightToMake"), tab: "make" };
    case "make":
      return cur.action === t("workspace.steps.action.make") && classic
        ? { label: t("workspace.steps.secondary.checkLook"), tab: "look" }
        : null;
    case "files":
      return { label: t("workspace.steps.secondary.makeAgain"), tab: "make" };
    default:
      return null;
  }
}

export function OverviewSteps({
  steps,
  onNavigate,
}: {
  steps: readonly StepView[];
  onNavigate: (tab: WorkspaceTabId) => void;
}): JSX.Element {
  const t = useT();
  const at = steps.findIndex((s) => s.state === "current");
  const cur = steps[at];

  return (
    <section data-testid="overview-steps" aria-labelledby="your-steps" className="flex flex-col gap-3">
      <h2 id="your-steps" className="text-sm font-semibold text-fg">
        {t("workspace.steps.title")}
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
              {t("workspace.steps.stepOf", { step: String(at + 1), total: String(steps.length) })}
            </span>
            <span className="block truncate text-sm font-medium text-fg">
              {cur.label}
              {cur.status ? <span className="font-normal text-fg-muted"> · {cur.status}</span> : null}
            </span>
          </button>
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
                className={`flex min-w-0 items-start gap-2 text-left text-sm ${
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
                {/* QA 2026-11-05: names wrap, never cut; the tag goes under */}
                <span className="flex min-w-0 flex-col items-start gap-0.5">
                  <span data-testid="step-name" className="font-medium break-words">
                    {s.label}
                  </span>
                  {s.optional ? (
                    <span className="rounded-full border border-edge px-1.5 text-[10px] text-fg-muted">
                      {t("workspace.steps.optional")}
                    </span>
                  ) : null}
                </span>
              </button>
              {current && s.status ? (
                <p data-testid="step-status" className="text-xs text-fg-muted">
                  {s.status}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
