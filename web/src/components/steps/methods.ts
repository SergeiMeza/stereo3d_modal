/**
 * Customer copy and options for the two ways a project is made 3D. One
 * source of truth for the method chooser, the header switch, History and
 * the Lifelike pages.
 *
 * Copy rules (owner, 2026-11-03): never name how either method works
 * inside (no model, technique or vendor names) — only what the customer
 * gets.
 */

import type {
  Format,
  GatewayLimits,
  Method,
  Preset,
  PublicPricing,
} from "@/lib/api/types";
import {
  FORMAT_NAMES,
  METHOD_NAMES,
  QUALITY_SHORT_SIDE,
  qualityName,
} from "@/lib/glossary";
import { FILES_DELETED_MESSAGE } from "@/lib/api/client";

export const METHOD_LABELS: Record<Method, string> = METHOD_NAMES;

export const METHOD_DESCRIPTIONS: Record<Method, string> = {
  lifelike:
    "Rebuilds every moment of your video as a real 3D scene, then films it again for each eye. The most natural depth and clean edges, in a fraction of the time.",
  classic: "Adds depth to your footage, with manual control over each step.",
};

/** S3D-46: Lifelike reads as our newest 3D. */
export const LIFELIKE_EYEBROW = "Our newest 3D technology";

/** The chooser's card tags (S3D-44: Classic is the older option). */
export const METHOD_TAGS: Partial<Record<Method, string>> = {
  classic: "Older method",
};

/** Defaults until /v1/limits and /v1/pricing answer (S3D-05). */
const DEFAULT_MAX_SECONDS: Record<Method, number> = { lifelike: 0, classic: 600 };
const DEFAULT_TOP_PRESET: Record<Method, Preset> = { lifelike: "8k", classic: "3k" };

/** "any length, up to 8K" / "up to 10 minutes, up to 4K" for one method
 * (S3D-05): the length from /v1/limits (or /v1/pricing), the top size
 * from /v1/pricing's presets. */
export function methodLimitText(
  m: Method,
  limits: GatewayLimits | null,
  pricing: PublicPricing | null,
): string {
  const secs =
    limits?.methods?.[m]?.max_source_duration_s ??
    pricing?.methods[m]?.max_source_duration_s ??
    DEFAULT_MAX_SECONDS[m];
  const presets = pricing?.methods[m]?.presets ?? [];
  const top =
    presets.length > 0
      ? presets.reduce((a, b) => (QUALITY_SHORT_SIDE[b] > QUALITY_SHORT_SIDE[a] ? b : a))
      : DEFAULT_TOP_PRESET[m];
  const length = secs > 0 ? `up to ${Math.round(secs / 60)} minutes` : "any length";
  return `${length}, up to ${qualityName(top)}`;
}

/** "Lifelike 3D: any length, up to 8K." — the one limits statement
 * (S3D-05); Classic 3D takes no new projects since 2026-11-04. */
export function limitsStatement(
  limits: GatewayLimits | null,
  pricing: PublicPricing | null,
): string {
  return `${METHOD_NAMES.lifelike}: ${methodLimitText("lifelike", limits, pricing)}.`;
}

/** Capital first letter: "Any length, up to 8K". */
export function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Chooser order: Lifelike first (recommended). */
export const METHOD_ORDER: readonly Method[] = ["lifelike", "classic"];

export const RECOMMENDED_METHOD: Method = "lifelike";

/** S3D-01/14: chosen before the first run; Lifelike never moves back. */
/** S3D-30: the one move there is, Classic → Lifelike. Classic 3D is
 * retired for new projects (owner 2026-11-04): an existing Classic project
 * keeps its files and converts with Lifelike 3D. */
export const CONVERT_WITH_LIFELIKE = "Convert with Lifelike 3D";
export const MOVE_TO_LIFELIKE_TITLE = "Convert this project with Lifelike 3D?";
export const MOVE_TO_LIFELIKE_BODY =
  "Your Classic files stay in Files. You can't move back to Classic.";

/** 400 method_switch_not_allowed, in words. */
export const SWITCH_NOT_ALLOWED = "A Lifelike 3D project can't move back to Classic 3D.";

/** 422 classic_retired: Classic 3D takes no new projects or runs. */
/** Onboarding: the sample project is finished and never billed. */
export const SAMPLE_PROJECT =
  "This is a finished sample, so there's nothing to pay for here. Its 3D files are in Files. Add your own video to make 3D.";

export const CLASSIC_RETIRED =
  "Classic 3D is retired. Your files stay here, and you can convert this project with Lifelike 3D.";

/** Lifelike output formats (the gateway 400s top-bottom and red-cyan for
 * Lifelike, so they are never offered). */
export const LIFELIKE_FORMATS = [
  "mvhevc",
  "sbs",
  "half_sbs",
] as const satisfies readonly Format[];

/** Sizes that make no full side-by-side file (its frame would be twice
 * the eye width): half side-by-side and spatial video only. The gateway's
 * per-quality `formats` wins when it sends one. */
export const NO_FULL_SBS_PRESETS: readonly Preset[] = ["6k", "8k"];

/** The Lifelike files a quality can make. */
export function lifelikeFormatsFor(q: {
  preset: Preset;
  formats?: readonly Format[];
}): Format[] {
  if (q.formats) return LIFELIKE_FORMATS.filter((f) => q.formats!.includes(f));
  return LIFELIKE_FORMATS.filter(
    (f) => !(f === "sbs" && NO_FULL_SBS_PRESETS.includes(q.preset)),
  );
}

/** The 5K, 6K and 8K tiles carry this tag (S3D-11). */
export const HIGHEST_QUALITY_TAG = "Highest quality";

export const LIFELIKE_FORMAT_LABELS: Record<
  (typeof LIFELIKE_FORMATS)[number],
  string
> = {
  mvhevc: FORMAT_NAMES.mvhevc,
  sbs: FORMAT_NAMES.sbs,
  half_sbs: FORMAT_NAMES.half_sbs,
};

/** Classic previews render this long a clip from the playhead (S3D-27). */
export const CLASSIC_PREVIEW_SECONDS = 10;

/** Lifelike preview length: about 5 s of source from the chosen moment
 * (the gateway allows up to 10 s). */
export const LIFELIKE_PREVIEW_SECONDS = 5;

/** Outputs longer than this are offered as parts (15 minutes). */
export const SPLIT_MAX_SECONDS = 900;


/** What the customer reads for 400 preset_above_source. */
export const PRESET_ABOVE_SOURCE =
  "That quality is higher than your video. Pick a lower one — we never upscale.";

/** Friendly copy for the gateway's method-related 400 codes on quotes and
 * runs; null for any other code (its own message is user-safe). */
export function methodErrorCopy(code: string): string | null {
  switch (code) {
    case "preset_above_source":
      return PRESET_ABOVE_SOURCE;
    case "preset_unavailable":
      return "Classic 3D goes up to 3K. Convert with Lifelike 3D for 4K and above.";
    case "method_unavailable":
      return "This 3D method isn't available right now. Please try again later.";
    case "source_too_long_for_method":
      return "This video is too long for Classic 3D. Convert with Lifelike 3D at the top of the page. It works with videos of any length.";
    case "step_not_supported_for_method":
      return "This project's 3D method has changed. Reload the page to continue.";
    case "method_switch_not_allowed":
      return SWITCH_NOT_ALLOWED;
    case "classic_retired":
      return CLASSIC_RETIRED;
    case "sample_project":
      return SAMPLE_PROJECT;
    case "files_deleted":
      return FILES_DELETED_MESSAGE;
    case "split_unsupported":
      return "Splitting into parts isn't available for this method.";
    default:
      return null;
  }
}
