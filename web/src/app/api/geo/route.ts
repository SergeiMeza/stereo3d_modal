import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requiresAnalyticsConsent } from "@/lib/geoConsent";

/**
 * GET /api/geo — must this visitor opt in before analytics run? Decided
 * from Vercel's x-vercel-ip-country geolocation header (set on every
 * Vercel deployment; absent in local dev, where the answer defaults to
 * "yes"). Reading request headers makes the route dynamic, so the answer
 * is always per-request.
 */
export function GET(request: NextRequest): NextResponse {
  const country = request.headers.get("x-vercel-ip-country");
  return NextResponse.json(
    { country, requires_consent: requiresAnalyticsConsent(country) },
    { headers: { "cache-control": "no-store" } },
  );
}
