"use client";

/**
 * Memoized GatewayClient bound to the auth context's token provider.
 * Screens use this instead of constructing clients themselves.
 */

import { useMemo } from "react";

import { GatewayClient } from "@/lib/api/client";
import { useAuth } from "@/lib/auth";

const DEFAULT_GATEWAY_URL = "http://localhost:8787";

export function useGateway(): GatewayClient {
  const { getToken } = useAuth();
  return useMemo(
    () =>
      new GatewayClient({
        baseUrl: process.env.NEXT_PUBLIC_GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
        getToken,
      }),
    [getToken],
  );
}
