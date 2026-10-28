"use client";

/**
 * Memoized GatewayClient bound to the auth context's token provider.
 * Screens use this instead of constructing clients themselves. The base
 * URL is picked per request: the cn. host in China mode (lib/region.ts),
 * NEXT_PUBLIC_GATEWAY_URL otherwise.
 */

import { useMemo } from "react";

import { GatewayClient } from "@/lib/api/client";
import { useAuth } from "@/lib/auth";
import { gatewayBaseUrl } from "@/lib/region";

export function useGateway(): GatewayClient {
  const { getToken } = useAuth();
  return useMemo(
    () =>
      new GatewayClient({
        baseUrl: gatewayBaseUrl,
        getToken,
      }),
    [getToken],
  );
}
