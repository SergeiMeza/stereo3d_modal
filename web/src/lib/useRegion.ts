"use client";

import { useSyncExternalStore } from "react";

import { currentRegion } from "@/lib/region";
import type { Region } from "@/lib/region";

const noSubscribe = () => () => {};

/** Region for rendering (lib/region.ts): null while server rendering and
 * hydrating, so prerendered HTML never depends on the visitor. */
export function useRegion(): Region | null {
  return useSyncExternalStore<Region | null>(
    noSubscribe,
    currentRegion,
    () => null,
  );
}
