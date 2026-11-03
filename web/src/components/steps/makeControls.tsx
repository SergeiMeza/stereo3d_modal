"use client";

/**
 * Make 3D building blocks shared by both methods (screens 06, 07, 10):
 * "Where will you watch it?" (S3D-07), the file tiles, quality tiles with
 * this video's price each, the start/end trim (S3D-10) and the numbered
 * section card. Native inputs underneath (tests and screen readers).
 */

import { useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

import type {
  Format,
  Method,
  Preset,
  Project,
  StepConversionRequest,
  Thumb,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { formatClock } from "@/lib/format";
import { frameToSeconds, secondsToFrame, type RationalFPS } from "@/lib/frames";
import { FORMAT_NAMES, type QualityChoice } from "@/lib/glossary";
import type { Client } from "@/lib/headset";

import { formatCents } from "./money";

/** A numbered section card: "1 Where will you watch it?" */
export function MakeSection({
  n,
  title,
  hint,
  aside,
  children,
  testId,
}: {
  n: number;
  title: ReactNode;
  hint?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <section
      data-testid={testId}
      className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-4"
    >
      <div className="flex flex-wrap items-start gap-2">
        <h3 className="flex items-start gap-2.5 text-sm font-semibold text-fg">
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded-full border border-edge bg-surface-2 text-[11px] font-normal text-fg-muted"
          >
            {n}
          </span>
          <span>{title}</span>
        </h3>
        {aside ? <span className="ml-auto">{aside}</span> : null}
      </div>
      {hint ? <p className="-mt-1.5 pl-7.5 text-xs text-fg-muted">{hint}</p> : null}
      {children}
    </section>
  );
}

function tileClass(on: boolean): string {
  return `flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-left text-sm transition-colors ${
    on
      ? "border-primary bg-primary/10 text-fg"
      : "border-edge bg-surface-0 text-fg-muted hover:bg-surface-2"
  }`;
}

/* ---------- Where will you watch it? (S3D-07) ---------- */

export type Device =
  | "avp"
  | "galaxyxr"
  | "quest"
  | "pico"
  | "steamframe"
  | "glasses"
  | "tv"
  | "unsure";

/** S3D-07/51: the options, in this order. */
export const DEVICES: readonly { id: Device; label: string }[] = [
  { id: "avp", label: "Apple Vision Pro" },
  { id: "galaxyxr", label: "Samsung Galaxy XR" },
  { id: "quest", label: "Meta Quest" },
  { id: "pico", label: "Pico" },
  { id: "steamframe", label: "Steam Frame" },
  { id: "glasses", label: "XR glasses (XREAL, VITURE, RayNeo)" },
  { id: "tv", label: "3D TV or projector" },
  { id: "unsure", label: "Not sure" },
];

/** The files each device needs; "Not sure" gets the two that play almost
 * anywhere. */
const DEVICE_FORMATS: Record<Device, Format[]> = {
  avp: ["mvhevc"],
  galaxyxr: ["sbs"],
  quest: ["half_sbs"],
  pico: ["sbs"],
  steamframe: ["sbs"],
  glasses: ["sbs"],
  tv: ["half_sbs"],
  unsure: ["mvhevc", "sbs"],
};

/** The files a set of devices needs, in the offered order. */
export function formatsForDevices(
  devices: readonly Device[],
  offered: readonly Format[],
): Format[] {
  const want = new Set(devices.flatMap((d) => DEVICE_FORMATS[d]));
  return offered.filter((f) => want.has(f));
}

/** The device a headset browser is (S3D-47), for preselecting. */
export function deviceForClient(c: Client): Device | null {
  switch (c) {
    case "vision":
      return "avp";
    case "quest":
      return "quest";
    case "pico":
      return "pico";
    case "galaxyxr":
      return "galaxyxr";
    default:
      return null;
  }
}

/** The default files before anyone picks a device. */
export const DEFAULT_MAKE_FORMATS: Format[] = ["mvhevc", "sbs"];

export function WatchPicker({
  devices,
  onChange,
}: {
  devices: readonly Device[];
  onChange: (next: Device[]) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Where will you watch it?"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
    >
      {DEVICES.map((d) => {
        const on = devices.includes(d.id);
        return (
          <label key={d.id} className={tileClass(on)}>
            <input
              type="checkbox"
              checked={on}
              onChange={() =>
                onChange(
                  on ? devices.filter((x) => x !== d.id) : [...devices, d.id],
                )
              }
              className="mt-0.5 accent-primary"
            />
            <span className="font-medium">{d.label}</span>
          </label>
        );
      })}
    </div>
  );
}

/* ---------- Files you'll get ---------- */

const FORMAT_FOR: Partial<Record<Format, string>> = {
  mvhevc: "For Apple Vision Pro",
  sbs: "For Galaxy XR, Pico, Steam Frame and XR glasses",
  half_sbs: "For Meta Quest, 3D TVs and projectors",
  anaglyph: "Any screen, with red-cyan glasses",
};

export function FileTiles({
  offered,
  formats,
  onToggle,
}: {
  offered: readonly Format[];
  formats: readonly Format[];
  onToggle: (f: Format) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label="Files you'll get" className="grid gap-2 sm:grid-cols-2">
      {offered.map((f) => {
        const on = formats.includes(f);
        return (
          <label key={f} className={tileClass(on)}>
            <input
              type="checkbox"
              checked={on}
              aria-label={FORMAT_NAMES[f]}
              onChange={() => onToggle(f)}
              className="mt-0.5 accent-primary"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{FORMAT_NAMES[f]}</span>
              <span className="text-xs text-fg-muted">{FORMAT_FOR[f]}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/* ---------- Quality tiles with this video's price each ---------- */

/** This video's price at each quality for the current request (formats
 * and trim), from the gateway's quotes. Re-priced, debounced, when the
 * request changes. */
export function usePresetPrices(
  project: Project,
  base: StepConversionRequest,
  presets: readonly Preset[],
  method: Method,
): Partial<Record<Preset, number>> {
  const gateway = useGateway();
  const [prices, setPrices] = useState<{
    key: string;
    cents: Partial<Record<Preset, number>>;
  }>({ key: "", cents: {} });
  const { preset: _ignored, ...rest } = base;
  void _ignored;
  const key = JSON.stringify({ rest, presets, method });
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      for (const p of presets) {
        gateway
          .quoteStep(project.project_id, { ...rest, preset: p, method })
          .then(
            (q) => {
              if (cancelled) return;
              setPrices((prev) => ({
                key,
                cents: {
                  ...(prev.key === key ? prev.cents : {}),
                  [p]: q.quote.amount_cents,
                },
              }));
            },
            () => {},
          );
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // key carries the request, presets and method
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, project.project_id, key]);
  return prices.key === key ? prices.cents : {};
}

/** This video's price for a few variants of one request (e.g. the edge
 * styles), from the gateway's quotes; debounced. */
export function useVariantPrices(
  project: Project,
  base: StepConversionRequest,
  variants: Record<string, Partial<StepConversionRequest>>,
): Record<string, number> {
  const gateway = useGateway();
  const [prices, setPrices] = useState<{ key: string; cents: Record<string, number> }>({
    key: "",
    cents: {},
  });
  const key = JSON.stringify({ base, variants });
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      for (const [name, over] of Object.entries(variants)) {
        const req = { ...base, ...over };
        // a variant drops fields it sets to undefined
        for (const k of Object.keys(over) as (keyof StepConversionRequest)[]) {
          if (over[k] === undefined) delete req[k];
        }
        gateway.quoteStep(project.project_id, req).then(
          (q) => {
            if (cancelled) return;
            setPrices((prev) => ({
              key,
              cents: { ...(prev.key === key ? prev.cents : {}), [name]: q.quote.amount_cents },
            }));
          },
          () => {},
        );
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // key carries the base request and the variants
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, project.project_id, key]);
  return prices.key === key ? prices.cents : {};
}

export function QualityTiles({
  choices,
  value,
  onChange,
  prices,
  note,
}: {
  choices: readonly QualityChoice[];
  value: Preset;
  onChange: (p: Preset) => void;
  prices: Partial<Record<Preset, number>>;
  note?: ReactNode;
}): JSX.Element {
  return (
    <>
      <div
        role="radiogroup"
        aria-label="Quality"
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {choices.map((q) => {
          const on = q.preset === value;
          const cents = prices[q.preset];
          return (
            <label
              key={q.preset}
              data-testid={`quality-${q.preset}`}
              className={`${tileClass(on)} flex-col gap-1`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="make-quality"
                  checked={on}
                  onChange={() => onChange(q.preset)}
                  className="accent-primary"
                />
                <span className="font-medium">{q.label}</span>
              </span>
              {q.hint ? (
                <span className="font-mono text-[11px] text-fg-muted">{q.hint}</span>
              ) : null}
              <span
                data-testid={`quality-price-${q.preset}`}
                className="font-mono text-sm text-fg"
              >
                {cents !== undefined ? formatCents(cents) : "…"}
              </span>
            </label>
          );
        })}
      </div>
      {note ? <p className="text-xs text-fg-muted">{note}</p> : null}
    </>
  );
}

/* ---------- Which part? (S3D-10) ---------- */

/** "1:02" / "1:02:03" → seconds; null when it doesn't parse. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length < 1 || parts.length > 3) return null;
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function ClockInput({
  label,
  seconds,
  onCommit,
}: {
  label: string;
  seconds: number;
  onCommit: (s: number) => void;
}): JSX.Element {
  const shown = formatClock(seconds);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-fg-muted">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        aria-label={label}
        value={draft ?? shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const s = draft === null ? null : parseClock(draft);
          setDraft(null);
          if (s !== null) onCommit(s);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-20 rounded-md border border-edge bg-surface-2 px-2 py-1 font-mono text-xs text-fg"
      />
    </label>
  );
}

export function TrimControl({
  numFrames,
  fps,
  thumbs,
  value,
  onChange,
}: {
  numFrames: number;
  fps: RationalFPS;
  thumbs: readonly Thumb[];
  /** [from, to) in source frames */
  value: [number, number];
  onChange: (next: [number, number]) => void;
}): JSX.Element {
  const [from, to] = value;
  const minSpan = Math.max(1, Math.round(fps.num / fps.den)); // 1 s
  const pct = (f: number) => (f / numFrames) * 100;
  const set = (a: number, b: number) => {
    const lo = Math.max(0, Math.min(a, numFrames - minSpan));
    const hi = Math.min(numFrames, Math.max(b, lo + minSpan));
    onChange([lo, hi]);
  };
  const thumbClass =
    "pointer-events-none absolute inset-0 h-full w-full appearance-none bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-12 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:cursor-ew-resize [&::-moz-range-thumb]:rounded-sm [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-12 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:cursor-ew-resize [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-sm [&::-webkit-slider-thumb]:bg-primary";
  const tiles = thumbs.length > 0 ? thumbs.filter((_, i) => i % Math.ceil(thumbs.length / 24) === 0) : [];
  return (
    <div className="flex flex-col gap-3">
      <div className="relative h-12 overflow-hidden rounded-md border border-edge bg-surface-2">
        <div aria-hidden className="absolute inset-0 flex">
          {tiles.map((t) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={t.frame} src={t.url} alt="" className="h-full min-w-0 flex-1 object-cover" />
          ))}
        </div>
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 bg-black/60"
          style={{ width: `${pct(from)}%` }}
        />
        <div
          aria-hidden
          className="absolute inset-y-0 right-0 bg-black/60"
          style={{ width: `${100 - pct(to)}%` }}
        />
        <div
          aria-hidden
          className="absolute inset-y-0 border-y-2 border-primary"
          style={{ left: `${pct(from)}%`, width: `${pct(to) - pct(from)}%` }}
        />
        <input
          type="range"
          aria-label="Start handle"
          min={0}
          max={numFrames}
          value={from}
          onChange={(e) => set(Number(e.target.value), to)}
          className={thumbClass}
        />
        <input
          type="range"
          aria-label="End handle"
          min={0}
          max={numFrames}
          value={to}
          onChange={(e) => set(from, Number(e.target.value))}
          className={thumbClass}
        />
      </div>
      <div className="flex flex-wrap gap-4">
        <ClockInput
          label="Start"
          seconds={frameToSeconds(from, fps)}
          onCommit={(s) => set(secondsToFrame(s, fps), to)}
        />
        <ClockInput
          label="End"
          seconds={frameToSeconds(to, fps)}
          onCommit={(s) => set(from, secondsToFrame(s, fps))}
        />
      </div>
    </div>
  );
}

/** "Whole video · 5:12" / "Part · 1:02" for the trim chip. */
export function trimChip(
  value: [number, number],
  numFrames: number,
  fps: RationalFPS,
): string {
  const whole = value[0] === 0 && value[1] >= numFrames;
  const secs = frameToSeconds(value[1] - value[0], fps);
  return `${whole ? "Whole video" : "Part"} · ${formatClock(secs)}`;
}

/** The trim's request fields: none for the whole video. */
export function trimFields(
  value: [number, number],
  numFrames: number,
): { from_frame?: number; to_frame?: number } {
  if (value[0] === 0 && value[1] >= numFrames) return {};
  return { from_frame: value[0], to_frame: value[1] };
}

/** "3 parts: about 15, 15 and 12 min" for a split of `outputSeconds`. */
export function partsEstimate(outputSeconds: number, maxSeconds: number): string {
  const n = Math.max(1, Math.ceil(outputSeconds / maxSeconds));
  const mins: number[] = [];
  for (let i = 0; i < n; i++) {
    const left = outputSeconds - i * maxSeconds;
    mins.push(Math.max(1, Math.round(Math.min(maxSeconds, left) / 60)));
  }
  const list =
    mins.length === 1
      ? `${mins[0]}`
      : `${mins.slice(0, -1).join(", ")} and ${mins[mins.length - 1]}`;
  return `${n} part${n === 1 ? "" : "s"}: about ${list} min`;
}
