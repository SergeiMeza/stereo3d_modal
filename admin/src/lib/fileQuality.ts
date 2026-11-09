/**
 * A run's File quality in words (owner 2026-11-07, gateway 00172), as the
 * web's Run details show it: what was asked for (Standard, High, Master;
 * older runs their bitrate) with what the finished files measure
 * ("High (measured 41 Mbit/s)", per file when there are several), and the
 * audio. Never a guess: without measurements, the asked-for setting only.
 */

export interface OutputMedia {
  video_kbps?: number;
  overall_kbps?: number;
  audio_codec?: string;
  audio_kbps?: number;
  source?: string;
}

export interface QualityFields {
  quality?: string;
  bitrate_requested?: string;
  outputs_media?: Record<string, OutputMedia> | null;
  /** the launch offer's line on the run (gateway 00175), 0 without */
  campaign_cents?: number;
  /** the Commercial use add-on (owner 2026-11-09): bought on the run */
  commercial?: boolean | null;
  /** ...or included by a plan active on 2026-11-09, until its renewal */
  commercial_included?: boolean | null;
}

const QUALITY: Record<string, string> = { standard: "Standard", high: "High", master: "Master" };

const OUTPUT_SHORT: Record<string, string> = {
  mvhevc: "Spatial",
  sbs: "SBS",
  half_sbs: "Half SBS",
  anaglyph: "Red-cyan",
  depth: "Depth",
  depth_vis: "Depth view",
};

function mbit(kbps: number): string {
  return `${Math.round(kbps / 1000)} Mbit/s`;
}

export function requestedQuality(r: QualityFields): string | null {
  if (r.quality) return QUALITY[r.quality] ?? r.quality;
  const b = r.bitrate_requested;
  if (!b) return null;
  if (b === "auto") return "Automatic";
  if (b === "match_source") return "Match source";
  if (b === "master") return "Master";
  const n = Number(b);
  return Number.isFinite(n) && n > 0 ? `${n} Mbit/s` : null;
}

export function measuredRates(r: QualityFields): string | null {
  const seen = new Map<string, string>();
  for (const [name, m] of Object.entries(r.outputs_media ?? {})) {
    const base = name.replace(/_part\d+$/, "").replace(/\.[a-z0-9]+$/i, "");
    if (seen.has(base)) continue;
    const rate =
      typeof m.video_kbps === "number" && m.video_kbps > 0
        ? mbit(m.video_kbps)
        : typeof m.overall_kbps === "number" && m.overall_kbps > 0
          ? `${mbit(m.overall_kbps)} overall`
          : null;
    if (rate) seen.set(base, rate);
  }
  if (seen.size === 0) return null;
  if (seen.size === 1) return `measured ${[...seen.values()][0]}`;
  return `measured: ${[...seen].map(([b, v]) => `${OUTPUT_SHORT[b] ?? b} ${v}`).join(" · ")}`;
}

/** "High (measured 41 Mbit/s)", "High" without measurements, or null. */
export function fileQualityLine(r: QualityFields): string | null {
  const asked = requestedQuality(r);
  const measured = measuredRates(r);
  if (asked && measured) return `${asked} (${measured})`;
  return asked ?? (measured ? measured.charAt(0).toUpperCase() + measured.slice(1) : null);
}

/** "AAC 256 kbit/s" from the first file with audio; null without. */
export function audioLine(r: QualityFields): string | null {
  const m = Object.values(r.outputs_media ?? {}).find((x) => x.audio_codec);
  if (!m?.audio_codec) return null;
  return [m.audio_codec.toUpperCase(), typeof m.audio_kbps === "number" && m.audio_kbps > 0 ? `${Math.round(m.audio_kbps)} kbit/s` : null]
    .filter(Boolean)
    .join(" ");
}

/** Commercial use on a run: "included" (a grandfathered plan), "yes"
 * (bought), "no", or null when the run doesn't say (older gateway). */
export function commercialLine(r: QualityFields): "yes" | "included" | "no" | null {
  if (r.commercial_included === true) return "included";
  if (r.commercial === true) return "yes";
  if (r.commercial === false || r.commercial_included === false) return "no";
  return null;
}
