"use client";

/**
 * GET /v1/limits, read once per page load and shared: the dropzone (length
 * cap and the method new projects get) and the workspace (whether Lifelike
 * can be chosen) both need it. null until it arrives, or when it fails —
 * callers treat that as "unknown" and let the gateway decide.
 */

import type { GatewayLimits } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { sharedFetch } from "@/lib/state/sharedFetch";

// ADR 0138: one shared answer in an app-store atom
const limits = sharedFetch<GatewayLimits>();

/** Test hook: forget the shared answer. */
export function resetLimitsCache(): void {
  limits.reset();
}

export function useLimits(): GatewayLimits | null {
  const gateway = useGateway();
  return limits.use(() => gateway.getLimits());
}
