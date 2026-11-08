"use client";

import { useSyncExternalStore } from "react";

import { currentRegion, subscribeRegion } from "@/lib/region";
import type { Region } from "@/lib/region";

/** Region for rendering (lib/region.ts): null while server rendering and
 * hydrating, so prerendered HTML never depends on the visitor. Follows
 * the route (BL-34): a browser that moves to the cn. host renders China
 * mode from then on. */
export function useRegion(): Region | null {
  return useSyncExternalStore<Region | null>(
    subscribeRegion,
    currentRegion,
    () => null,
  );
}
