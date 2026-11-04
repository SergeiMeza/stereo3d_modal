"use client";

/**
 * Make 3D's choices for one project (ADR 0138): what the person picked on
 * the page, in one atom per project, so the price, the quality cards and
 * the button all build the same request, and a tab switch keeps the picks.
 * `null` means "not picked": the page shows its preselection (the headset
 * in use, the devices' files, the highest quality, Express on a plan).
 */

import { atom, useAtom, type SetStateAction } from "jotai";
import { atomFamily } from "jotai-family";

import type { PayMode } from "@/components/plans/QuotePlans";
import type { Bitrate, Format, Preset } from "@/lib/api/types";

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
  bitrate: Bitrate;
  master: boolean;
  express: boolean | null;
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
  bitrate: "auto",
  master: false,
  express: null,
  payMode: "once",
};

/** One project's Make 3D choices. */
export const make3dChoicesAtom = atomFamily((projectId: string) => {
  void projectId;
  return atom<Make3dChoices>(MAKE3D_DEFAULTS);
});

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
  for (const id of [...make3dChoicesAtom.getParams()]) make3dChoicesAtom.remove(id);
}
