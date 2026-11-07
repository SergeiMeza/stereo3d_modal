import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, LOCALE_PARAM } from "@/lib/i18n/locales";
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
  // ?hl=<code> (the site's links): this request renders in it, and the
  // cookie keeps it; the page then takes the param off the address
  const hl = request.nextUrl.searchParams.get(LOCALE_PARAM);
  const lang = isLocale(hl) ? hl : null;
  if (lang !== null) request.cookies.set(LOCALE_COOKIE, lang);
  const response = lang !== null ? NextResponse.next({ request }) : NextResponse.next();
  if (lang !== null) {
    response.cookies.set(LOCALE_COOKIE, lang, {
      path: "/",
      maxAge: LOCALE_COOKIE_MAX_AGE,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
    });
  }
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
  // Pages only: not API routes, build assets, files with an extension, or
  // Apple's app-site-association (no extension, served untouched).
  matcher: ["/((?!api/|_next/|\\.well-known/|apple-app-site-association$|.*\\.[a-zA-Z0-9]+$).*)"],
};
