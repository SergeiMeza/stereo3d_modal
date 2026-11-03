"use client";

/**
 * GET /v1/limits, read once per page load and shared: the dropzone (length
 * cap and the method new projects get) and the workspace (whether Lifelike
 * can be chosen) both need it. null until it arrives, or when it fails —
 * callers treat that as "unknown" and let the gateway decide.
 */

import { useEffect, useState } from "react";

import type { GatewayLimits } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

let cached: Promise<GatewayLimits | null> | null = null;

/** Test hook: forget the shared answer. */
export function resetLimitsCache(): void {
  cached = null;
}

export function useLimits(): GatewayLimits | null {
  const gateway = useGateway();
  const [limits, setLimits] = useState<GatewayLimits | null>(null);
  useEffect(() => {
    let cancelled = false;
    cached ??= gateway.getLimits().catch(() => {
      cached = null; // try again on the next mount
      return null;
    });
    void cached.then((l) => {
      if (!cancelled) setLimits(l);
    });
    return () => {
      cancelled = true;
    };
  }, [gateway]);
  return limits;
}
