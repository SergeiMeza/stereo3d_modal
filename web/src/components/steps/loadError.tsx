"use client";

/**
 * What a failed load says (owner 2026-11-04): never the gateway's raw "not
 * found"; on the finished sample every failure reads "The sample isn't
 * available right now." WorkspaceScreen marks the sample with
 * SampleProvider; the run files, earlier runs and the run tracker read it.
 */

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { GatewayError } from "@/lib/api/client";

export const SAMPLE_UNAVAILABLE = "The sample isn't available right now.";

const SampleContext = createContext(false);

export function SampleProvider({
  sample,
  children,
}: {
  sample: boolean;
  children: ReactNode;
}) {
  return (
    <SampleContext.Provider value={sample}>{children}</SampleContext.Provider>
  );
}

export function useIsSample(): boolean {
  return useContext(SampleContext);
}

/** The words for a failed load: the sample line on the sample, the
 * fallback for a 404 or anything without a message, else the message. */
export function loadErrorText(
  e: unknown,
  sample: boolean,
  fallback: string,
): string {
  if (sample) return SAMPLE_UNAVAILABLE;
  if (e instanceof GatewayError && e.status === 404) return fallback;
  if (e instanceof Error && e.message && !/not found/i.test(e.message))
    return e.message;
  return fallback;
}
