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
 * BL-34: a visitor outside China mode whose browser can't reach the
 * gateway's direct host moves to the cn. host (lib/gatewayRoute.ts: a 5 s
 * /health probe, connection failures only, remembered per browser,
 * `direct` asked again every 6 h), and is then in China mode too: the
 * same sign-in, uploads and payments as a visitor placed in China. A pin
 * fixes the route (`?region=cn` the cn. host, `?region=global` the direct
 * one), and China mode by country stays on the cn. host, as before.
 *
 * Rendering reads the region through useRegion() (lib/useRegion.ts), which is null during
 * server rendering and hydration (static pages can't know the visitor),
 * so nothing region-specific is ever baked into prerendered HTML.
 * Non-render code (tokens, gateway URLs, analytics start) reads
 * currentRegion() at call time; code that must know the route first
 * awaits prepareGatewayRoute() (gatewayFetch does).
 */

import { GatewayRoute, isConnectionFailure } from "@/lib/gatewayRoute";
import type { RouteName } from "@/lib/gatewayRoute";

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
  if (homeRegion() === "cn") return "cn";
  return route.current() === "cn_relay" ? "cn" : "global";
}

/** The region from the country header or a pin, before the route
 * (BL-34) has a say. Honors a `?region=` in the address too and stores
 * it, in case the page was served without the proxy. */
export function homeRegion(): Region {
  if (typeof window === "undefined") return "global";
  const param = regionParam();
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

function regionParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get(REGION_PARAM);
  } catch {
    return null;
  }
}

/** A `?region=cn|global` pin is in force (it fixes the route). */
function regionPinned(): boolean {
  if (typeof window === "undefined") return false;
  const param = regionParam();
  if (param === "auto") return false;
  return parseRegion(param) !== null || parseRegion(readCookie(REGION_PIN_COOKIE)) !== null;
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

/** The gateway base URL for this visitor, decided at call time: the cn.
 * host in China mode (by country, pin or route), the direct one otherwise.
 * The mock gateway (NEXT_PUBLIC_API_MOCK=1) only answers on the plain URL. */
export function gatewayBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_MOCK === "1") return globalGatewayUrl();
  return currentRegion() === "cn" ? cnGatewayUrl() : globalGatewayUrl();
}

// ---------------------------------------------------------- the route

/** Whether the route may move by reachability: a real gateway with a cn.
 * host of its own, not the mock or a test run, and not switched off with
 * NEXT_PUBLIC_GATEWAY_FALLBACK=0. */
function routeFallbackEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_GATEWAY_FALLBACK !== "0" &&
    process.env.NEXT_PUBLIC_API_MOCK !== "1" &&
    process.env.NODE_ENV !== "test" &&
    process.env.NEXT_PUBLIC_GATEWAY_URL !== undefined &&
    cnGatewayUrl() !== globalGatewayUrl()
  );
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const browserDeps = {
  enabled: routeFallbackEnabled,
  home: homeRegion,
  pinned: regionPinned,
  hosts: () => ({ direct: globalGatewayUrl(), cnRelay: cnGatewayUrl() }),
  // late-bound: tests (MSW) replace the global fetch
  fetch: ((input, init) => fetch(input, init)) as typeof fetch,
  storage: browserStorage,
  now: () => Date.now(),
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
};

const regionListeners = new Set<() => void>();

let route = new GatewayRoute(browserDeps);

/** Tests: a fresh route, its dependencies overridden. */
export function resetGatewayRouteForTests(
  deps: Partial<ConstructorParameters<typeof GatewayRoute>[0]> = {},
): GatewayRoute {
  route = new GatewayRoute({ ...browserDeps, ...deps });
  for (const fn of regionListeners) route.subscribe(fn);
  return route;
}

/** Called when the region may have changed (the route moved); returns
 * unsubscribe. For useRegion(). */
export function subscribeRegion(fn: () => void): () => void {
  regionListeners.add(fn);
  const off = route.subscribe(fn);
  return () => {
    regionListeners.delete(fn);
    off();
  };
}

/** The route the next gateway request takes. */
export function currentGatewayRoute(): RouteName {
  return currentRegion() === "cn" ? "cn_relay" : "direct";
}

/** Settles the route before the first gateway request of a page load
 * (at once when it's fixed). */
export function prepareGatewayRoute(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return route.prepare();
}

/** A gateway request failed before any answer: the route is asked again
 * (connection failures only; HTTP statuses never reach here). */
export function reportGatewayFailure(error: unknown): void {
  route.reportFailure(error);
}

/** On the relay by choice for 6 h or more: ask the direct host again (the
 * next page load goes back to it when it answers). */
export function recheckDirectGatewayRoute(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return route.recheckDirect();
}

/** fetch on the gateway at `path`, on this visitor's route: waits for the
 * route to settle, and reports a connection failure so the next request
 * can take the other host. Throws what fetch throws. */
export async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  await prepareGatewayRoute();
  try {
    return await fetch(`${gatewayBaseUrl()}${path}`, init);
  } catch (e) {
    if (isConnectionFailure(e)) reportGatewayFailure(e);
    throw e;
  }
}
