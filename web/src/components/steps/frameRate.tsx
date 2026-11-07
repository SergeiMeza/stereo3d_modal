"use client";

/**
 * The output frame rate (owner 2026-11-04). Above 30 fps needs a Business
 * or Studio plan: the gateway caps everyone else at the largest whole
 * division of the source at or under 30 (60 → 30, 50 → 25, 120 → 30),
 * marks such a quote fps_capped, and answers an explicit target_fps above
 * the account's max_fps with 422 plan_required_fps.
 *
 * A source above 30 fps makes the frame rate a REQUIRED choice before any
 * paid step: nothing is preselected and the run button stays off until one
 * is picked. Each option carries this video's price at that rate (one
 * quote each); a rate the account can't use shows locked with "Business
 * or Studio plan" and a link to the plans. With a plan the choices are the
 * gateway's target_fps_choices. At 30 fps or below there is no choice: the
 * run keeps the source rate. A re-run starts from the last run's rate.
 */

import { useAtom } from "jotai";
import Link from "next/link";
import type { JSX } from "react";

import {
  conversionMethod,
  type Project,
  type Step,
  type StepConversionRequest,
  type StepQuoteResponse,
} from "@/lib/api/types";
import { fpsFactor, usePricing } from "@/lib/api/usePricing";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";
import { rich } from "@/lib/i18n/rich";

import { formatCents } from "./money";
import { fpsPickAtom } from "./make3dAtoms";
import { centsOf, useVariantQuotes } from "./priceAtoms";



/** Rates above this need a plan (the gateway's max_fps without one). */
export const FREE_MAX_FPS = 30;

export const FPS_PLAN_REQUIRED =
  "Frame rates above 30 fps come with Business and Studio plans.";

/** The run button's reason while no rate is picked. */
export const PICK_FRAME_RATE = "Pick a frame rate to see the price.";

const PLAN_NAMES = { business: "Business", studio: "Studio" };

export function fpsPlanRequired(t: Tr = EN): string {
  return t("make.fps.planRequired", PLAN_NAMES);
}

export function pickFrameRate(t: Tr = EN): string {
  return t("make.fps.pickFrameRate");
}

/** Whether a source needs the frame-rate choice. */
export function needsFpsChoice(sourceFps: number): boolean {
  return sourceFps > FREE_MAX_FPS + 0.01;
}

/** The gateway's choices (fps_cap.go fpsChoices): whole divisions of the
 * source at or under `max`, high to low, down to about 10 fps, three
 * decimals (60 → 60, 30, 20, 15, 12, 10; 59.94 → 59.94, 29.97, …). */
export function fpsDivisions(src: number, max = Infinity): number[] {
  const out: number[] = [];
  if (src <= 0) return out;
  for (let n = 1; n <= 12; n++) {
    const v = Math.round((src / n) * 1000) / 1000;
    if (v > max * 1.0005) continue;
    if (v < 10 && out.length > 0) break;
    out.push(v);
  }
  return out;
}

/** The rates the page offers from a list: those of about 24 fps and up,
 * and always the highest (120 → 120, 60, 40, 30, 24; without a plan
 * 60 → 30). Lower rates stay sendable through the API. */
export function shownRates(rates: readonly number[]): number[] {
  const sorted = [...rates].sort((a, b) => b - a);
  const kept = sorted.filter((v) => v >= 23.5);
  return kept.length > 0 ? kept : sorted.slice(0, 1);
}

/** "60 fps", "29.97 fps". */
export function fpsLabel(v: number, t: Tr = EN): string {
  const r = Math.round(v * 100) / 100;
  return t("glossary.fps", { fps: Number.isInteger(r) ? String(r) : r.toFixed(2) });
}

/** The frame rate a quote or run converts at: the sent target_fps, else
 * the rate behind its fps factor (exact from 12 to 60 fps). */
export function quotedFps(
  params: { target_fps?: number } | undefined,
  fpsFactorValue: number | undefined,
): number | null {
  if (params?.target_fps) return params.target_fps;
  if (fpsFactorValue === undefined) return null;
  return Math.round(fpsFactorValue * 24 * 100) / 100;
}

export interface FpsOption {
  fps: number;
  locked: boolean;
  /** this video's price at this rate; undefined while it loads */
  cents?: number;
}

export interface FpsChoice {
  /** the source is above 30 fps: a rate must be picked */
  required: boolean;
  options: FpsOption[];
  value: number | null;
  set: (v: number) => void;
  /** the request field to send */
  field: { target_fps?: number };
  /** the plain line under the choice */
  line: string | null;
}

/** The rate a re-run starts from: the last run of this step's rate. */
function lastRate(project: Project, step: Step): number | null {
  const last = [...(project.conversions ?? [])]
    .filter((c) => c.step === step && conversionMethod(c) === "lifelike")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  return last?.params?.target_fps ?? null;
}

/**
 * The frame-rate choice for one step. `base` is the request without
 * target_fps; every candidate rate is quoted on it.
 */
export function useFpsChoice(
  project: Project,
  step: Step,
  base: StepConversionRequest,
): FpsChoice {
  const t = useT();
  const pricing = usePricing();
  const src = project.probe?.fps ?? 0;
  const required = needsFpsChoice(src);
  const [pickedChoice, setPicked] = useAtom(fpsPickAtom(`${project.project_id}/${step}`));
  const picked = pickedChoice !== null ? pickedChoice : required ? lastRate(project, step) : null;
  const { target_fps: _drop, ...rest } = base;
  void _drop;
  // every rate a plan allows, quoted once each; a 422 plan_required_fps
  // marks it locked for this account (ADR 0138: cached per request)
  const candidates = required
    ? shownRates(fpsDivisions(src, pricing?.fps.max_fps_with_plan ?? 120))
    : [];
  const entries = useVariantQuotes(
    project.project_id,
    Object.fromEntries(candidates.map((v) => [String(v), { ...rest, target_fps: v }])),
  );
  const now: {
    cents: Record<string, number>;
    locked: Record<string, true>;
    quote: StepQuoteResponse | null;
  } = { cents: centsOf(entries), locked: {}, quote: null };
  for (const v of candidates) {
    const e = entries[String(v)];
    if (e?.status === "error" && e.code === "plan_required_fps") now.locked[String(v)] = true;
    if (e?.status === "done" && now.quote === null) now.quote = e.quote;
  }
  const max = now.quote?.fps?.max_fps;
  const allowed = now.quote?.fps ? shownRates(now.quote.fps.target_fps_choices) : undefined;
  const isLocked = (v: number) =>
    now.locked[String(v)] === true || (max !== undefined && v > max + 0.01);
  const rates = allowed
    ? [...new Set([...allowed, ...candidates.filter(isLocked)])].sort((a, b) => b - a)
    : candidates;
  const options: FpsOption[] = required
    ? rates.map((fps) => ({
        fps,
        locked: isLocked(fps),
        cents: now.cents[String(fps)],
      }))
    : [];
  const value =
    picked !== null && options.some((o) => !o.locked && Math.abs(o.fps - picked) < 0.01)
      ? picked
      : null;
  // the owner's example rate: 60 (or 59.94, 50…) rather than 120
  const example = rates.find((r) => r > FREE_MAX_FPS && r <= 60.01) ?? rates[0];
  const line =
    required && pricing && example !== undefined && example > FREE_MAX_FPS
      ? t("make.fps.costLine", {
          fps: fpsLabel(example, t),
          minutes: String(Math.round(fpsFactor(pricing, example) * 100) / 100),
        })
      : null;
  return {
    required,
    options,
    value,
    set: setPicked,
    field: value !== null ? { target_fps: value } : {},
    line,
  };
}

/** The choice as price tiles (Make 3D) or a compact row (Preview). */
export function FrameRatePicker({
  choice,
  onChange,
  compact = false,
}: {
  choice: FpsChoice;
  onChange: (v: number) => void;
  compact?: boolean;
}): JSX.Element | null {
  const t = useT();
  if (!choice.required) return null;
  return (
    <div data-testid="fps-choice" className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={t("make.fps.label")}
        className={compact ? "flex flex-wrap gap-1.5" : "grid gap-2 sm:grid-cols-2"}
      >
        {choice.options.map((o) => {
          const on = choice.value !== null && Math.abs(choice.value - o.fps) < 0.01;
          const price =
            o.cents === undefined ? "…" : o.cents === 0 ? t("make.fps.free") : formatCents(o.cents, t);
          return (
            <button
              key={o.fps}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={o.locked || undefined}
              disabled={o.locked}
              data-testid={`fps-${o.fps}`}
              onClick={() => onChange(o.fps)}
              className={`flex items-center gap-2 rounded-lg border text-left text-sm transition-colors ${
                compact ? "h-8 px-2.5 text-xs" : "p-3"
              } ${
                o.locked
                  ? "cursor-not-allowed border-edge bg-surface-1 text-fg-muted"
                  : on
                    ? "border-primary bg-primary/10 text-fg"
                    : "border-edge bg-surface-2 text-fg hover:border-fg-muted"
              }`}
            >
              <span className="font-medium">{fpsLabel(o.fps, t)}</span>
              {o.locked ? (
                <span className="text-xs text-fg-muted">· {t("make.fps.lockedPlan", PLAN_NAMES)}</span>
              ) : (
                <span className="font-mono text-xs text-fg-muted">· {price}</span>
              )}
            </button>
          );
        })}
      </div>
      {choice.line ? <p className="text-xs text-fg-muted">{choice.line}</p> : null}
      {choice.options.some((o) => o.locked) ? (
        <p className="text-xs text-fg-muted">
          {rich(
            t,
            "make.fps.planRequiredSeePlans",
            {
              link: (c) => (
                <Link href="/plans" className="text-primary hover:underline">
                  {c}
                </Link>
              ),
            },
            PLAN_NAMES,
          )}
        </p>
      ) : null}
    </div>
  );
}
