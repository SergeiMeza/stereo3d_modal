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

import { useAtomValue } from "jotai";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { useGateway } from "@/lib/api/useGateway";
import {
  conversionMethod,
  type Project,
  type Step,
  type StepConversionRequest,
  type StepQuoteResponse,
} from "@/lib/api/types";
import { fpsFactor, usePricing } from "@/lib/api/usePricing";

import { priceEpochAtom } from "./checkoutStore";
import { formatCents } from "./money";

/** Rates above this need a plan (the gateway's max_fps without one). */
export const FREE_MAX_FPS = 30;

export const FPS_PLAN_REQUIRED =
  "Frame rates above 30 fps come with Business and Studio plans.";

/** The run button's reason while no rate is picked. */
export const PICK_FRAME_RATE = "Pick a frame rate to see the price.";

/** Whether a source needs the frame-rate choice. */
export function needsFpsChoice(sourceFps: number): boolean {
  return sourceFps > FREE_MAX_FPS + 0.01;
}

/** Whole divisions of the source rate down to about 24, high to low, two
 * decimals (60 → 60, 30; 120 → 120, 60, 40, 30, 24; 59.94 → 59.94, 29.97). */
export function fpsDivisions(src: number): number[] {
  const out: number[] = [];
  for (let n = 1; n <= 12; n++) {
    const v = Math.round((src / n) * 100) / 100;
    if (n > 1 && v < 23.5) break;
    out.push(v);
  }
  return out;
}

/** "60 fps", "29.97 fps". */
export function fpsLabel(v: number): string {
  const r = Math.round(v * 100) / 100;
  return `${Number.isInteger(r) ? r : r.toFixed(2)} fps`;
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
  const gateway = useGateway();
  const pricing = usePricing();
  const epoch = useAtomValue(priceEpochAtom);
  const src = project.probe?.fps ?? 0;
  const required = needsFpsChoice(src);
  const [picked, setPicked] = useState<number | null>(() =>
    required ? lastRate(project, step) : null,
  );
  const [state, setState] = useState<{
    key: string;
    cents: Record<string, number>;
    locked: Record<string, true>;
    quote: StepQuoteResponse | null;
  }>({ key: "", cents: {}, locked: {}, quote: null });

  const { target_fps: _drop, ...rest } = base;
  void _drop;
  const candidates = required ? fpsDivisions(src) : [];
  const key = JSON.stringify({ rest, candidates, epoch, id: project.project_id });
  useEffect(() => {
    if (candidates.length === 0) return;
    let cancelled = false;
    const t = setTimeout(() => {
      for (const v of candidates) {
        gateway.quoteStep(project.project_id, { ...rest, target_fps: v }).then(
          (q) => {
            if (cancelled) return;
            setState((prev) => {
              const same = prev.key === key;
              return {
                key,
                cents: { ...(same ? prev.cents : {}), [String(v)]: q.quote.amount_cents },
                locked: same ? prev.locked : {},
                quote: (same ? prev.quote : null) ?? q,
              };
            });
          },
          (e: { code?: string }) => {
            if (cancelled || e.code !== "plan_required_fps") return;
            setState((prev) => {
              const same = prev.key === key;
              return {
                key,
                cents: same ? prev.cents : {},
                locked: { ...(same ? prev.locked : {}), [String(v)]: true },
                quote: same ? prev.quote : null,
              };
            });
          },
        );
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // key carries the request and the candidates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, key]);

  const now: {
    cents: Record<string, number>;
    locked: Record<string, true>;
    quote: StepQuoteResponse | null;
  } = state.key === key ? state : { cents: {}, locked: {}, quote: null };
  const max = now.quote?.max_fps ?? pricing?.max_fps;
  const allowed = now.quote?.target_fps_choices;
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
      ? `Higher frame rates look smoother and cost more: at ${fpsLabel(example)} a minute counts as ${
          Math.round(fpsFactor(pricing, example) * 100) / 100
        } minutes.`
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
  if (!choice.required) return null;
  return (
    <div data-testid="fps-choice" className="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label="Frame rate"
        className={compact ? "flex flex-wrap gap-1.5" : "grid gap-2 sm:grid-cols-2"}
      >
        {choice.options.map((o) => {
          const on = choice.value !== null && Math.abs(choice.value - o.fps) < 0.01;
          const price =
            o.cents === undefined ? "…" : o.cents === 0 ? "Free" : formatCents(o.cents);
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
              <span className="font-medium">{fpsLabel(o.fps)}</span>
              {o.locked ? (
                <span className="text-xs text-fg-muted">· Business or Studio plan</span>
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
          {FPS_PLAN_REQUIRED}{" "}
          <Link href="/plans" className="text-primary hover:underline">
            See plans
          </Link>
        </p>
      ) : null}
    </div>
  );
}
