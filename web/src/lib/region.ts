/**
 * Region ("China mode"). Visitors in mainland China can't reach Google, so
 * the site there signs in through the gateway (lib/gatewayAuth.ts), calls
 * the gateway's cn. host, and never loads the Firebase SDK or analytics.
 *
 * Detection happens at the edge: src/proxy.ts reads Vercel's
 * x-vercel-ip-country header on every page request and sets the
 * s3d_region cookie ("cn" | "global"), which the browser reads here.
 * `?region=cn` / `?region=global` pins a region (for testing from outside
 * China) in s3d_region_pin, which wins over the country until
 * `?region=auto` clears it. No cookie (local dev without the proxy, tests)
 * means "global": the default path is the one that always worked.
 *
 * Rendering reads the region through useRegion() (lib/useRegion.ts), which is null during
 * server rendering and hydration (static pages can't know the visitor),
 * so nothing region-specific is ever baked into prerendered HTML.
 * Non-render code (tokens, gateway URLs, analytics start) reads
 * currentRegion() at call time, which on the client is always settled.
 */

export type Region = "cn" | "global";

export const REGION_COOKIE = "s3d_region";
export const REGION_PIN_COOKIE = "s3d_region_pin";
export const REGION_PARAM = "region";
/** One year: a pin set for testing stays until ?region=auto. */
export const REGION_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function parseRegion(value: string | null | undefined): Region | null {
  return value === "cn" || value === "global" ? value : null;
}

/** Mainland China only; Hong Kong, Macau and Taiwan reach Google. */
export function regionForCountry(country: string | null | undefined): Region {
  return country?.trim().toUpperCase() === "CN" ? "cn" : "global";
}

export interface RegionDecision {
  region: Region;
  /** New pin to store; null clears it; undefined leaves it as it is. */
  pin: Region | null | undefined;
}

/** The edge's decision for one request (src/proxy.ts). */
export function decideRegion(input: {
  param: string | null;
  pin: string | null | undefined;
  country: string | null | undefined;
}): RegionDecision {
  if (input.param === "auto") {
    return { region: regionForCountry(input.country), pin: null };
  }
  const asked = parseRegion(input.param);
  if (asked !== null) return { region: asked, pin: asked };
  const pinned = parseRegion(input.pin);
  if (pinned !== null) return { region: pinned, pin: undefined };
  return { region: regionForCountry(input.country), pin: undefined };
}

// ---------------------------------------------------------------- browser

function readCookie(name: string): string | null {
  try {
    for (const part of document.cookie.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === name) return decodeURIComponent(v.join("="));
    }
  } catch {
    // cookies blocked
  }
  return null;
}

function writeCookie(name: string, value: string | null): void {
  try {
    document.cookie =
      value === null
        ? `${name}=; Path=/; Max-Age=0; SameSite=Lax`
        : `${name}=${value}; Path=/; Max-Age=${REGION_COOKIE_MAX_AGE}; SameSite=Lax`;
  } catch {
    // cookies blocked: the region simply isn't remembered
  }
}

/**
 * The visitor's region, in the browser ("global" on the server). Honors a
 * `?region=` in the address too and stores it, in case the page was
 * served without the proxy.
 */
export function currentRegion(): Region {
  if (typeof window === "undefined") return "global";
  let param: string | null = null;
  try {
    param = new URLSearchParams(window.location.search).get(REGION_PARAM);
  } catch {
    param = null;
  }
  const asked = parseRegion(param);
  if (asked !== null) {
    if (readCookie(REGION_PIN_COOKIE) !== asked) {
      writeCookie(REGION_PIN_COOKIE, asked);
      writeCookie(REGION_COOKIE, asked);
    }
    return asked;
  }
  if (param === "auto") writeCookie(REGION_PIN_COOKIE, null);
  return parseRegion(readCookie(REGION_COOKIE)) ?? "global";
}

// ---------------------------------------------------------------- gateway

const DEFAULT_GATEWAY_URL = "http://localhost:8787";

/** NEXT_PUBLIC_GATEWAY_URL with "cn." in front of the host:
 * https://api.stereo3d.studio → https://cn.api.stereo3d.studio. */
export function deriveCnGatewayUrl(base: string): string {
  try {
    const url = new URL(base);
    if (!url.hostname.startsWith("cn.")) url.hostname = `cn.${url.hostname}`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return base;
  }
}

export function globalGatewayUrl(): string {
  return process.env.NEXT_PUBLIC_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
}

export function cnGatewayUrl(): string {
  return (
    process.env.NEXT_PUBLIC_GATEWAY_CN_URL ??
    deriveCnGatewayUrl(globalGatewayUrl())
  );
}

/** The gateway base URL for this visitor, decided at call time. The mock
 * gateway (NEXT_PUBLIC_API_MOCK=1) only answers on the plain URL. */
export function gatewayBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_MOCK === "1") return globalGatewayUrl();
  return currentRegion() === "cn" ? cnGatewayUrl() : globalGatewayUrl();
}
