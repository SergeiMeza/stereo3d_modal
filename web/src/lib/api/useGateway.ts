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
import { useT } from "@/lib/i18n/I18nProvider";
import { confirmItsYou } from "@/lib/reauth";
import { currentRegion, gatewayBaseUrl } from "@/lib/region";

const chunkedUploads = () => currentRegion() === "cn";

export function useGateway(): GatewayClient {
  const { getToken } = useAuth();
  const t = useT();
  return useMemo(
    () =>
      new GatewayClient({
        baseUrl: gatewayBaseUrl,
        getToken,
        resumableUploads: chunkedUploads,
        // owner 2026-11-06: sensitive routes after an old sign-in
        onReauthRequired: confirmItsYou,
        // the errors the client words itself, in the reader's language
        t,
      }),
    [getToken, t],
  );
}
