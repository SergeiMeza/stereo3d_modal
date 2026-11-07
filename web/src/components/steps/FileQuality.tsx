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

import type { OutputQuality, PublicPricing, QuoteQuality } from "@/lib/api/types";
import { formatBytes } from "@/lib/format";

export const FILE_QUALITY = "File quality";

export const QUALITY_STEPS: readonly { value: OutputQuality; label: string; hint: string | null }[] = [
  { value: "standard", label: "Standard", hint: null },
  { value: "high", label: "High", hint: "For client reviews and big screens" },
  { value: "master", label: "Master", hint: "For editing and archiving" },
];

export function qualityName(q: OutputQuality): string {
  return QUALITY_STEPS.find((s) => s.value === q)?.label ?? "Standard";
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
export function qualityResult(q: QuoteQuality | undefined, sizeBytes?: number): string | null {
  const bytes = q?.estimated_size_bytes ?? sizeBytes;
  const parts = [
    typeof bytes === "number" && bytes > 0 ? `about ${formatBytes(bytes)}` : null,
    typeof q?.mbps === "number" && q.mbps > 0 ? `about ${Math.round(q.mbps)} Mbit/s` : null,
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
  const steps = qualitySteps(pricing);
  if (steps.length < 2) return null;
  const hint = QUALITY_STEPS.find((s) => s.value === value)?.hint ?? null;
  const result = qualityResult(quality?.tier === value ? quality : undefined, quality?.tier === value ? sizeBytes : undefined);
  return (
    <div data-testid="file-quality" className="flex min-w-0 flex-col gap-1.5">
      <span id="file-quality-label" className="text-sm font-medium text-fg">
        {FILE_QUALITY}
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
