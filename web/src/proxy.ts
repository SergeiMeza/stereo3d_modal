import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  REGION_COOKIE,
  REGION_COOKIE_MAX_AGE,
  REGION_PARAM,
  REGION_PIN_COOKIE,
  decideRegion,
} from "@/lib/region";

/**
 * Edge region detection (lib/region.ts): on every page request, set the
 * s3d_region cookie from Vercel's x-vercel-ip-country (or a ?region= pin)
 * so the browser knows whether to run in China mode. Only cookies change;
 * the page itself is served exactly as before, cache included.
 */
export function proxy(request: NextRequest): NextResponse {
  const decision = decideRegion({
    param: request.nextUrl.searchParams.get(REGION_PARAM),
    pin: request.cookies.get(REGION_PIN_COOKIE)?.value,
    country: request.headers.get("x-vercel-ip-country"),
  });
  const response = NextResponse.next();
  const options = {
    path: "/",
    maxAge: REGION_COOKIE_MAX_AGE,
    sameSite: "lax" as const,
    secure: request.nextUrl.protocol === "https:",
  };
  if (request.cookies.get(REGION_COOKIE)?.value !== decision.region) {
    response.cookies.set(REGION_COOKIE, decision.region, options);
  }
  if (decision.pin === null) {
    if (request.cookies.has(REGION_PIN_COOKIE)) {
      response.cookies.set(REGION_PIN_COOKIE, "", { ...options, maxAge: 0 });
    }
  } else if (decision.pin !== undefined) {
    response.cookies.set(REGION_PIN_COOKIE, decision.pin, options);
  }
  return response;
}

export const config = {
  // Pages only: not API routes, build assets, or files with an extension.
  matcher: ["/((?!api/|_next/|.*\\.[a-zA-Z0-9]+$).*)"],
};
