/**
 * Per-project draft of the Stereo page's tweaks (per-scene overrides +
 * master depth_scale), persisted in localStorage so tab switches and reloads
 * don't lose them, and so the Deliver page can send production THE SAME
 * parameters the user tuned on Stereo.
 *
 * The key is versioned by scenes_version: override `first` values are only
 * meaningful against the cut list they were edited on, so a re-cut project
 * starts a fresh draft rather than sending misaligned frames.
 */

import type { SceneOverride, ShotType } from "@/lib/api/types";

/** One scene row's user edits; keys absent = "auto" (adaptive default). */
export interface RowOverride {
  shot_type?: ShotType;
  displacement?: number;
}

export interface StereoDraft {
  /** scene start frame (0 or a cuts value) → that row's edits */
  overrides: Record<string, RowOverride>;
  depth_scale: number;
}

export function emptyStereoDraft(): StereoDraft {
  return { overrides: {}, depth_scale: 1 };
}

export function stereoDraftKey(projectId: string, scenesVersion: number): string {
  return `stereo-overrides:${projectId}:v${scenesVersion}`;
}

export function loadStereoDraft(
  projectId: string,
  scenesVersion: number,
): StereoDraft {
  try {
    const raw = window.localStorage.getItem(stereoDraftKey(projectId, scenesVersion));
    if (!raw) return emptyStereoDraft();
    const parsed = JSON.parse(raw) as Partial<StereoDraft>;
    return {
      overrides: parsed.overrides ?? {},
      depth_scale: typeof parsed.depth_scale === "number" ? parsed.depth_scale : 1,
    };
  } catch {
    return emptyStereoDraft(); // corrupt/unavailable storage never blocks the UI
  }
}

export function saveStereoDraft(
  projectId: string,
  scenesVersion: number,
  draft: StereoDraft,
): void {
  try {
    window.localStorage.setItem(
      stereoDraftKey(projectId, scenesVersion),
      JSON.stringify(draft),
    );
  } catch {
    /* storage full/unavailable — drafts are a convenience, not state */
  }
}

/** Request-shape scene_overrides from a draft: ONLY rows the user actually
 * changed, restricted to starts that exist on the CURRENT cut list, sorted
 * ascending (the gateway requires strictly increasing `first`). */
export function draftToSceneOverrides(
  draft: StereoDraft,
  validStarts: number[],
): SceneOverride[] {
  const valid = new Set(validStarts);
  return Object.entries(draft.overrides)
    .map(([first, row]) => ({ first: Number(first), row }))
    .filter(
      ({ first, row }) =>
        valid.has(first) &&
        (row.shot_type !== undefined || row.displacement !== undefined),
    )
    .sort((a, b) => a.first - b.first)
    .map(({ first, row }) => ({
      first,
      ...(row.shot_type !== undefined ? { shot_type: row.shot_type } : {}),
      ...(row.displacement !== undefined ? { displacement: row.displacement } : {}),
    }));
}
