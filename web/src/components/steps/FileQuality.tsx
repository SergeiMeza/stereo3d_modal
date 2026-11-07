"use client";

/**
 * File quality (owner 2026-11-07, gateway 00172): one three-step scale,
 * Standard · High · Master, in place of the Mbit/s list and the Master
 * bitrate add-on. Standard is the default and free; High and Master carry
 * their share from /v1/pricing. Under the scale, what the quote says the
 * files come to ("about 1.4 GB · about 22 Mbit/s"). "Quality" stays the
 * resolution picker's name.
 */

import type { JSX } from "react";

import type { Conversion, OutputQuality, PublicPricing, QuoteQuality } from "@/lib/api/types";
import { formatBytes } from "@/lib/format";
import { useT } from "@/lib/i18n/I18nProvider";
import { EN, type Tr } from "@/lib/i18n/t";

export const FILE_QUALITY = "File quality";

export const QUALITY_STEPS: readonly { value: OutputQuality; label: string; hint: string | null }[] = [
  { value: "standard", label: "Standard", hint: null },
  { value: "high", label: "High", hint: "For client reviews and big screens" },
  { value: "master", label: "Master", hint: "For editing and archiving" },
];

export function qualityName(q: OutputQuality): string {
  return QUALITY_STEPS.find((s) => s.value === q)?.label ?? "Standard";
}

/** A step's hint in the reader's language (Standard has none). */
export function qualityHint(q: OutputQuality, t: Tr = EN): string | null {
  return q === "high" || q === "master" ? t(`make.fileQuality.hint.${q}`) : null;
}

/** A step's price share from /v1/pricing: the quality table, else its
 * add-on; Standard is free. */
export function qualityPct(pricing: PublicPricing | null | undefined, q: OutputQuality): number {
  if (q === "standard") return 0;
  return pricing?.quality?.[q]?.price_pct ?? pricing?.addons?.[q]?.pct ?? 0;
}

/** The steps the gateway offers (none: no scale). */
export function qualitySteps(pricing: PublicPricing | null | undefined): OutputQuality[] {
  const tiers = pricing?.quality?.tiers;
  if (tiers && tiers.length > 0) return QUALITY_STEPS.map((s) => s.value).filter((v) => tiers.includes(v));
  if (pricing?.addons?.high || pricing?.addons?.master) {
    return QUALITY_STEPS.map((s) => s.value).filter((v) => v === "standard" || pricing.addons?.[v] !== undefined);
  }
  return [];
}

/** "about 1.4 GB · about 22 Mbit/s" (per file), from the quote; null when
 * it says nothing. */
export function qualityResult(q: QuoteQuality | undefined, sizeBytes?: number, t: Tr = EN): string | null {
  const bytes = q?.estimated_size_bytes ?? sizeBytes;
  const parts = [
    typeof bytes === "number" && bytes > 0 ? t("make.fileQuality.aboutSize", { size: formatBytes(bytes) }) : null,
    typeof q?.mbps === "number" && q.mbps > 0 ? t("make.fileQuality.aboutMbps", { mbps: String(Math.round(q.mbps)) }) : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function FileQualityScale({
  value,
  onChange,
  pricing,
  quality,
  sizeBytes,
}: {
  value: OutputQuality;
  onChange: (q: OutputQuality) => void;
  pricing: PublicPricing | null | undefined;
  /** the quote's quality block, for the chosen step */
  quality?: QuoteQuality;
  /** the quote's estimated_size_bytes, when the block doesn't say */
  sizeBytes?: number;
}): JSX.Element | null {
  const t = useT();
  const steps = qualitySteps(pricing);
  if (steps.length < 2) return null;
  const hint = qualityHint(value, t);
  const result = qualityResult(quality?.tier === value ? quality : undefined, quality?.tier === value ? sizeBytes : undefined, t);
  return (
    <div data-testid="file-quality" className="flex min-w-0 flex-col gap-1.5">
      <span id="file-quality-label" className="text-sm font-medium text-fg">
        {t("make.fileQuality.title")}
      </span>
      <div
        role="radiogroup"
        aria-labelledby="file-quality-label"
        className="grid w-full max-w-md grid-cols-3 gap-0.5 rounded-lg border border-edge bg-surface-2 p-0.5"
      >
        {steps.map((q) => {
          const pct = qualityPct(pricing, q);
          const on = q === value;
          return (
            <label
              key={q}
              data-testid={`file-quality-${q}`}
              className={`flex min-w-0 cursor-pointer flex-col items-center rounded-md px-2 py-1.5 text-center text-sm focus-within:ring-2 focus-within:ring-primary ${
                on ? "bg-primary text-primary-foreground" : "text-fg hover:bg-surface-1"
              }`}
            >
              <input
                type="radio"
                name="file-quality"
                value={q}
                checked={on}
                onChange={() => onChange(q)}
                className="sr-only"
              />
              <span className="truncate font-medium">{qualityName(q)}</span>
              {pct > 0 ? (
                <span className={`text-xs ${on ? "text-primary-foreground/80" : "text-fg-muted"}`}>
                  +{Math.round(pct * 100)}%
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      {hint ? (
        <p data-testid="file-quality-hint" className="text-xs text-fg-muted">
          {hint}
        </p>
      ) : null}
      {result ? (
        <p data-testid="file-quality-result" className="text-xs text-fg-muted">
          {result}
        </p>
      ) : null}
    </div>
  );
}

/* ---------- what a run asked for and what its files measure ---------- */

const OUTPUT_SHORT: Record<string, string> = {
  mvhevc: "Spatial",
  sbs: "SBS",
  half_sbs: "Half SBS",
  anaglyph: "Red-cyan",
  depth: "Depth",
  depth_vis: "Depth view",
};

function outputShort(b: string, t: Tr): string {
  return Object.hasOwn(OUTPUT_SHORT, b) ? t(`make.fileQuality.outputShort.${b}`) : b;
}

/** 41250 kbit/s → "41 Mbit/s". */
function mbit(kbps: number, t: Tr): string {
  return t("make.fileQuality.mbps", { mbps: String(Math.round(kbps / 1000)) });
}

/** What the run asked for: its File quality, else the bitrate it asked
 * for (Automatic, Match source, 40 Mbit/s, Master); null when it says
 * nothing (never a guess). */
export function requestedQuality(c: Conversion, t: Tr = EN): string | null {
  if (c.quality) return qualityName(c.quality);
  const b = c.bitrate_requested ?? (c.params as { bitrate?: unknown }).bitrate;
  if (b === undefined || b === null || b === "") return null;
  if (b === "auto") return t("make.fileQuality.bitrateAuto");
  if (b === "match_source") return t("make.fileQuality.bitrateMatchSource");
  if (b === "master") return "Master";
  const n = Number(b);
  return Number.isFinite(n) && n > 0 ? t("make.fileQuality.mbps", { mbps: String(n) }) : null;
}

/** What the finished files measure: "measured 41 Mbit/s", or per file
 * "measured: Spatial 41 Mbit/s · SBS 38 Mbit/s"; the overall rate (so
 * labelled) only without a video rate. Null while running or without
 * measurements. */
export function measuredRates(c: Conversion, t: Tr = EN): string | null {
  if (c.state !== "succeeded" || !c.outputs_media) return null;
  const seen = new Map<string, string>();
  for (const [name, m] of Object.entries(c.outputs_media)) {
    const base = name.replace(/_part\d+$/, "").replace(/\.[a-z0-9]+$/i, "");
    if (seen.has(base)) continue;
    const rate =
      typeof m.video_kbps === "number" && m.video_kbps > 0
        ? mbit(m.video_kbps, t)
        : typeof m.overall_kbps === "number" && m.overall_kbps > 0
          ? t("make.fileQuality.overall", { rate: mbit(m.overall_kbps, t) })
          : null;
    if (rate) seen.set(base, rate);
  }
  if (seen.size === 0) return null;
  if (seen.size === 1) return t("make.fileQuality.measuredOne", { rate: [...seen.values()][0] });
  return t("make.fileQuality.measuredMany", {
    rates: [...seen].map(([b, r]) => t("make.fileQuality.measuredPart", { name: outputShort(b, t), rate: r })).join(" · "),
  });
}

/** "High (measured 41 Mbit/s)", "High" while running, or null. */
export function fileQualityLine(c: Conversion, t: Tr = EN): string | null {
  const asked = requestedQuality(c, t);
  const measured = measuredRates(c, t);
  if (asked && measured) return t("make.fileQuality.askedMeasured", { asked, measured });
  return asked ?? (measured ? measured.charAt(0).toUpperCase() + measured.slice(1) : null);
}

/** "AAC 256 kbit/s" from the first file with audio; null without. */
export function audioLine(c: Conversion, t: Tr = EN): string | null {
  if (c.state !== "succeeded" || !c.outputs_media) return null;
  const m = Object.values(c.outputs_media).find((x) => x.audio_codec);
  if (!m?.audio_codec) return null;
  return [m.audio_codec.toUpperCase(), typeof m.audio_kbps === "number" && m.audio_kbps > 0 ? t("make.fileQuality.kbps", { kbps: String(Math.round(m.audio_kbps)) }) : null]
    .filter(Boolean)
    .join(" ");
}
