"use client";

/**
 * Memoized GatewayClient bound to the auth context's token provider.
 * Screens use this instead of constructing clients themselves. The base
 * URL is picked per request: the cn. host in China mode (lib/region.ts),
 * NEXT_PUBLIC_GATEWAY_URL otherwise. China mode also uploads in chunks
 * (resumable tickets), since its hosts carry at most 25 MB per request.
 */

import { useMemo } from "react";

import { GatewayClient } from "@/lib/api/client";
import { useAuth } from "@/lib/auth";
import { currentRegion, gatewayBaseUrl } from "@/lib/region";

const chunkedUploads = () => currentRegion() === "cn";

export function useGateway(): GatewayClient {
  const { getToken } = useAuth();
  return useMemo(
    () =>
      new GatewayClient({
        baseUrl: gatewayBaseUrl,
        getToken,
        resumableUploads: chunkedUploads,
      }),
    [getToken],
  );
}
