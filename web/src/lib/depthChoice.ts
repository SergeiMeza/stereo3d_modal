/**
 * The 3D depth choice (owner 2026-11-10, LL-19): Comfortable · Standard ·
 * Strong on Lifelike runs and previews, Standard by default, no price
 * change. The gateway turns it into how far things may come out of the
 * screen. Requests leave Standard out (absent = standard); runs from
 * 2026-11-10 carry params.depth, older ones nothing (and say nothing).
 * Classic is never offered it (the gateway answers 400 when it's sent).
 */

import type { LifelikeDepth, Params } from "@/lib/api/types";
import { EN, type Tr } from "@/lib/i18n/t";

/** The choices, in the order they show. */
export const DEPTH_CHOICES: readonly LifelikeDepth[] = ["comfortable", "standard", "strong"];

export const DEFAULT_DEPTH: LifelikeDepth = "standard";

export function isDepthChoice(v: unknown): v is LifelikeDepth {
  return typeof v === "string" && (DEPTH_CHOICES as readonly string[]).includes(v);
}

/** "3D depth", the control's label. */
export function depthLabel(t: Tr = EN): string {
  return t("depthChoice.label");
}

/** "Comfortable", "Standard", "Strong". */
export function depthName(d: LifelikeDepth, t: Tr = EN): string {
  return t(`depthChoice.choice.${d}`);
}

/** The one line under the control. */
export function depthHint(t: Tr = EN): string {
  return t("depthChoice.hint");
}

/** The request's field: nothing for Standard (the gateway's default). */
export function depthField(d: LifelikeDepth): { depth?: LifelikeDepth } {
  return d === DEFAULT_DEPTH ? {} : { depth: d };
}

/** A run's words: "3D depth: Strong", or null for a run that doesn't say
 * (runs before 2026-11-10). */
export function depthRunWords(p: Pick<Params, "depth"> | null | undefined, t: Tr = EN): string | null {
  const d = p?.depth;
  return isDepthChoice(d) ? t("depthChoice.run", { depth: depthName(d, t) }) : null;
}
