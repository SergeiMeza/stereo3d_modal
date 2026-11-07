/**
 * Black bars (owner request 2026-11-04): when the video has black bars,
 * the project says so (has_bars, with the picture area in `crop`,
 * "W:H:X:Y"), and Lifelike removes them unless the person keeps them
 * (remove_bars, default true when bars are found). The Overview tab tells
 * the person and offers the choice; Make 3D has the same setting; the
 * Preview tab's moments follow it.
 */

import type { Probe, Project } from "@/lib/api/types";
import { parseCrop } from "@/components/workspace/utils";
import { eyeSize, type QualityChoice } from "@/lib/glossary";
import { EN, type Tr } from "@/lib/i18n/t";

export type BarSides = "top_bottom" | "sides" | "all";

/** Where the bars are; null when the project reports none (or an older
 * gateway says nothing). */
export function barSides(project: Pick<Project, "has_bars" | "crop" | "probe">): BarSides | null {
  if (project.has_bars !== true || !project.probe) return null;
  const c = parseCrop(project.crop);
  if (!c) return null;
  const { width, height } = project.probe;
  const tb = c.height < height;
  const lr = c.width < width;
  if (tb && lr) return "all";
  if (tb) return "top_bottom";
  if (lr) return "sides";
  return null;
}

/** Bars are removed unless the person chose to keep them. */
export function removesBars(project: Pick<Project, "has_bars" | "remove_bars">): boolean {
  return project.has_bars === true && project.remove_bars !== false;
}

const WHERE: Record<BarSides, string> = {
  top_bottom: "topBottom",
  sides: "sides",
  all: "all",
};

/** "Black bars found at the top and bottom of your video. …" */
export function barsNotice(sides: BarSides, removing: boolean, t: Tr = EN): string {
  return t(`workspace.bars.notice.${removing ? "removing" : "keeping"}.${WHERE[sides]}`);
}

/** The picture size once the bars are gone, for a full-frame size
 * ("3840×2160" → "3840×1600"). */
export function sizeWithoutBars(
  probe: Pick<Probe, "width" | "height">,
  crop: string | undefined,
  full: { width: number; height: number },
): { width: number; height: number } | null {
  const c = parseCrop(crop);
  if (!c) return null;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return {
    width: even((c.width / probe.width) * full.width),
    height: even((c.height / probe.height) * full.height),
  };
}

/** owner 2026-11-05: with the bars removed, each quality says the size
 * it makes (1920×866), as the bars setting does. */
export function withoutBars(choices: QualityChoice[], project: Project, t: Tr = EN): QualityChoice[] {
  const probe = project.probe;
  if (!probe || !removesBars(project) || barSides(project) === null) return choices;
  return choices.map((q) => {
    const full = q.eyeShort ? eyeSize(probe, q.eyeShort) : null;
    const size = full ? sizeWithoutBars(probe, project.crop, full) : null;
    return size ? { ...q, hint: t("workspace.bars.perEye", { size: `${size.width}×${size.height}` }) } : q;
  });
}
