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

import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { SceneOverride, ShotType } from "@/lib/api/types";

/** One scene row's user edits; keys absent = "auto" (adaptive default).
 *
 * `passthrough: true` = ship the scene as 2D (both eyes the untouched
 * source). The depth keys are KEPT in the draft while passthrough is on —
 * the request builder drops them (the gateway rejects the combination), so
 * toggling back to 3D restores them. */
export interface RowOverride {
  shot_type?: ShotType;
  displacement?: number;
  passthrough?: boolean;
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
 * ascending (the gateway requires strictly increasing `first`).
 *
 * A passthrough row emits EXACTLY {first, passthrough: true} — the gateway
 * 400s passthrough combined with any depth key, so the draft's stashed
 * shot_type/displacement are dropped from the wire (but kept in the draft
 * for when the scene is toggled back to 3D). */
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
        (row.passthrough === true ||
          row.shot_type !== undefined ||
          row.displacement !== undefined),
    )
    .sort((a, b) => a.first - b.first)
    .map(({ first, row }) =>
      row.passthrough === true
        ? { first, passthrough: true }
        : {
            first,
            ...(row.shot_type !== undefined ? { shot_type: row.shot_type } : {}),
            ...(row.displacement !== undefined
              ? { displacement: row.displacement }
              : {}),
          },
    );
}

/** The shared draft as React state, persisted to the versioned localStorage
 * key — the Stereo AND Depth pages mount this against the same key, so the
 * per-scene passthrough toggle is one shared switch. Re-keys itself if the
 * scene version moves while mounted (adjust-during-render, per the React
 * docs pattern). */
export function useStereoDraft(
  projectId: string,
  scenesVersion: number,
): [StereoDraft, Dispatch<SetStateAction<StereoDraft>>] {
  const key = stereoDraftKey(projectId, scenesVersion);
  const [draft, setDraft] = useState<StereoDraft>(() =>
    loadStereoDraft(projectId, scenesVersion),
  );
  const [loadedKey, setLoadedKey] = useState(key);
  if (loadedKey !== key) {
    setLoadedKey(key);
    setDraft(loadStereoDraft(projectId, scenesVersion));
  }
  useEffect(() => {
    saveStereoDraft(projectId, scenesVersion, draft);
  }, [projectId, scenesVersion, draft]);
  return [draft, setDraft];
}

/** Flip one scene's 2D-passthrough flag, preserving its other draft keys
 * (so toggling back to 3D restores them). Shared by the Stereo rows and the
 * Depth page's scenes strip. */
export function setRowPassthrough(
  draft: StereoDraft,
  start: number,
  passthrough: boolean,
): StereoDraft {
  const overrides = { ...draft.overrides };
  const next: RowOverride = { ...overrides[start] };
  if (passthrough) next.passthrough = true;
  else delete next.passthrough;
  if (Object.keys(next).length === 0) delete overrides[start];
  else overrides[start] = next;
  return { ...draft, overrides };
}
