"use client";

/**
 * Make 3D's choices for one project (ADR 0138): what the person picked on
 * the page, in one atom per project, so the price, the quality cards and
 * the button all build the same request, and a tab switch keeps the picks.
 * `null` means "not picked": the page shows its preselection (the headset
 * in use, the devices' files, the highest quality, Express on a plan).
 *
 * Owner 2026-11-05: the picks also survive a reload, per project, in
 * localStorage (plain UI state, nothing sensitive; how to pay is not kept).
 * Storage that throws (private mode, blocked) just means no memory.
 */

import { useAtom, type SetStateAction } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";

import type { PayMode } from "@/components/plans/QuotePlans";
import type { Format, LifelikeDepth, OutputQuality, Preset } from "@/lib/api/types";
import { isDepthChoice } from "@/lib/depthChoice";

import { safeJSONStorage } from "@/lib/state/safeStorage";

import type { Device } from "./makeControls";

export interface Make3dChoices {
  preset: Preset | null;
  devices: Device[] | null;
  formats: Format[] | null;
  /** S3D-06: split a long video into parts (preselected) */
  split: boolean;
  trim: [number, number] | null;
  /** S3D-48: optional original eye up to 4K */
  optionalEye: "left" | "right" | null;
  /** S3D-65: the required original eye at 5K-8K */
  requiredEye: "left" | "right";
  foveated: boolean;
  /** owner 2026-11-07: File quality, Standard · High · Master */
  quality: OutputQuality;
  express: boolean | null;
  /** owner 2026-11-09: Commercial use, unticked by default (a plan that
   * still includes it shows it ticked and included instead) */
  commercial: boolean;
  /** owner 2026-11-10: Smoother motion, unticked by default */
  stabilize: boolean;
  /** owner 2026-11-10: the 3D depth, Standard by default; the preview
   * shares it */
  depth: LifelikeDepth;
  payMode: PayMode;
}

export const MAKE3D_DEFAULTS: Make3dChoices = {
  preset: null,
  devices: null,
  formats: null,
  split: true,
  trim: null,
  optionalEye: null,
  requiredEye: "left",
  foveated: true,
  quality: "standard",
  express: null,
  commercial: false,
  stabilize: false,
  depth: "standard",
  payMode: "once",
};

/** A saved File quality, or the old bitrate pick it replaces (owner
 * 2026-11-07): the Master add-on or a "master" bitrate → Master, anything
 * else (Automatic, Match the source, a number) → Standard. */
export function savedQuality(saved: { quality?: unknown; bitrate?: unknown; master?: unknown }): OutputQuality {
  if (saved.quality === "standard" || saved.quality === "high" || saved.quality === "master") return saved.quality;
  return saved.master === true || saved.bitrate === "master" ? "master" : "standard";
}

/** Where one project's picks are kept. */
export function make3dStorageKey(projectId: string): string {
  return `svs:make3d:${projectId}`;
}

/** localStorage, never throwing; a stored object fills in over the
 * defaults (a field added later starts at its default). */
const make3dStorage = {
  getItem(key: string, initial: Make3dChoices): Make3dChoices {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return initial;
      const saved = JSON.parse(raw) as Partial<Make3dChoices> & { bitrate?: unknown; master?: unknown };
      const known = Object.fromEntries(
        Object.entries(saved).filter(([k]) => k in MAKE3D_DEFAULTS && k !== "payMode"),
      ) as Partial<Make3dChoices>;
      // a stored depth the gateway wouldn't take falls back to Standard
      const depth = isDepthChoice(saved.depth) ? saved.depth : initial.depth;
      return { ...initial, ...known, quality: savedQuality(saved), depth };
    } catch {
      return initial;
    }
  },
  setItem(key: string, value: Make3dChoices): void {
    try {
      const { payMode: _pay, ...kept } = value;
      void _pay;
      window.localStorage.setItem(key, JSON.stringify(kept));
    } catch {
      // no memory then
    }
  },
  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // nothing to forget
    }
  },
};

/** One project's Make 3D choices, kept across reloads. */
export const make3dChoicesAtom = atomFamily((projectId: string) =>
  atomWithStorage<Make3dChoices>(make3dStorageKey(projectId), MAKE3D_DEFAULTS, make3dStorage, {
    getOnInit: true,
  }),
);

/** One choice as [value, set], like useState. */
export function useMake3dChoice<K extends keyof Make3dChoices>(
  projectId: string,
  key: K,
): [Make3dChoices[K], (v: SetStateAction<Make3dChoices[K]>) => void] {
  const [all, setAll] = useAtom(make3dChoicesAtom(projectId));
  const set = (v: SetStateAction<Make3dChoices[K]>): void =>
    setAll((prev) => ({
      ...prev,
      [key]: typeof v === "function" ? (v as (p: Make3dChoices[K]) => Make3dChoices[K])(prev[key]) : v,
    }));
  return [all[key], set];
}

/** Test hook: every project's choices back to the defaults. */
export function resetMake3dForTests(): void {
  for (const id of [...make3dChoicesAtom.getParams()]) {
    make3dStorage.removeItem(make3dStorageKey(id));
    make3dChoicesAtom.remove(id);
  }
}

/** The picked rate per `${projectId}/${step}` (ADR 0138): null until the
 * person picks one (the last run's rate shows meanwhile); kept across
 * reloads with the other Make 3D picks (owner 2026-11-05). */
export const fpsPickAtom = atomFamily((key: string) =>
  atomWithStorage<number | null>(`svs:fps:${key}`, null, safeJSONStorage<number | null>(), { getOnInit: true }),
);
