/**
 * Region detection (China mode): the edge decision the proxy makes, the
 * browser's reading of it (cookie and ?region= override), and the gateway
 * host each region talks to.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTE_STORAGE_KEY } from "@/lib/gatewayRoute";
import {
  REGION_COOKIE,
  REGION_PIN_COOKIE,
  currentRegion,
  decideRegion,
  deriveCnGatewayUrl,
  gatewayBaseUrl,
  gatewayFetch,
  prepareGatewayRoute,
  regionForCountry,
  resetGatewayRouteForTests,
  subscribeRegion,
} from "@/lib/region";

function clearCookies(): void {
  for (const name of [REGION_COOKIE, REGION_PIN_COOKIE]) {
    document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

function setSearch(search: string): void {
  window.history.replaceState(null, "", `/signin${search}`);
}

afterEach(() => {
  clearCookies();
  setSearch("");
  window.localStorage.clear();
  vi.unstubAllGlobals();
  resetGatewayRouteForTests();
});

describe("regionForCountry", () => {
  it("is cn for mainland China only", () => {
    expect(regionForCountry("CN")).toBe("cn");
    expect(regionForCountry("cn")).toBe("cn");
    for (const c of ["HK", "MO", "TW", "US", "JP", "", null, undefined]) {
      expect(regionForCountry(c)).toBe("global");
    }
  });
});

describe("decideRegion (edge)", () => {
  it("follows the country when nothing is pinned", () => {
    expect(decideRegion({ param: null, pin: undefined, country: "CN" })).toEqual(
      { region: "cn", pin: undefined },
    );
    expect(decideRegion({ param: null, pin: undefined, country: "US" })).toEqual(
      { region: "global", pin: undefined },
    );
    expect(decideRegion({ param: null, pin: undefined, country: null })).toEqual(
      { region: "global", pin: undefined },
    );
  });

  it("pins ?region=cn / ?region=global over the country", () => {
    expect(decideRegion({ param: "cn", pin: undefined, country: "US" })).toEqual(
      { region: "cn", pin: "cn" },
    );
    expect(decideRegion({ param: "global", pin: "cn", country: "CN" })).toEqual(
      { region: "global", pin: "global" },
    );
  });

  it("keeps a stored pin on later requests", () => {
    expect(decideRegion({ param: null, pin: "cn", country: "US" })).toEqual({
      region: "cn",
      pin: undefined,
    });
  });

  it("?region=auto clears the pin and goes back to the country", () => {
    expect(decideRegion({ param: "auto", pin: "cn", country: "US" })).toEqual({
      region: "global",
      pin: null,
    });
  });

  it("ignores junk values", () => {
    expect(decideRegion({ param: "mars", pin: "moon", country: "US" })).toEqual(
      { region: "global", pin: undefined },
    );
  });
});

describe("currentRegion (browser)", () => {
  it("is global without a cookie — the default path", () => {
    expect(currentRegion()).toBe("global");
  });

  it("reads the cookie the proxy set", () => {
    document.cookie = `${REGION_COOKIE}=cn; Path=/`;
    expect(currentRegion()).toBe("cn");
  });

  it("honors ?region= and remembers it after the parameter is gone", () => {
    setSearch("?region=cn");
    expect(currentRegion()).toBe("cn");
    setSearch("");
    expect(currentRegion()).toBe("cn");
    expect(document.cookie).toContain(`${REGION_PIN_COOKIE}=cn`);

    setSearch("?region=global");
    expect(currentRegion()).toBe("global");
    setSearch("");
    expect(currentRegion()).toBe("global");
  });
});

describe("gateway host", () => {
  it("inserts cn. in front of the gateway host", () => {
    expect(deriveCnGatewayUrl("https://api.stereo3d.studio")).toBe(
      "https://cn.api.stereo3d.studio",
    );
    expect(deriveCnGatewayUrl("https://api.dev.stereo3d.studio/")).toBe(
      "https://cn.api.dev.stereo3d.studio",
    );
    expect(deriveCnGatewayUrl("https://cn.api.stereo3d.studio")).toBe(
      "https://cn.api.stereo3d.studio",
    );
  });

  it("uses the cn. host in China mode only", () => {
    const base = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
    expect(gatewayBaseUrl()).toBe(base);
    document.cookie = `${REGION_COOKIE}=cn; Path=/`;
    expect(gatewayBaseUrl()).toBe(deriveCnGatewayUrl(base));
  });
});

// ------------------------------------------------------- BL-34: the route

const BASE = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const CN = deriveCnGatewayUrl(BASE);

/** A stubbed network: per URL prefix, a status or "fail" (no connection). */
function network(answers: { direct?: number | "fail"; relay?: number | "fail"; request?: number | "fail" }) {
  const urls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const health = url.endsWith("/health");
    const a = health ? (url.startsWith(CN) ? answers.relay : answers.direct) : answers.request;
    if (a === "fail") throw new TypeError("Failed to fetch");
    return new Response(health ? null : "{}", { status: a ?? 200 });
  });
  vi.stubGlobal("fetch", fn);
  return urls;
}

describe("the route (BL-34)", () => {
  it("is off under test by default: no probe, the region as before", async () => {
    const urls = network({ direct: "fail" });
    await prepareGatewayRoute();
    expect(urls).toEqual([]);
    expect(currentRegion()).toBe("global");
    expect(gatewayBaseUrl()).toBe(BASE);
  });

  it("outside China, a direct host that answers changes nothing", async () => {
    resetGatewayRouteForTests({ enabled: () => true });
    const urls = network({});
    await prepareGatewayRoute();
    expect(urls).toEqual([`${BASE}/health`]);
    expect(currentRegion()).toBe("global");
    expect(gatewayBaseUrl()).toBe(BASE);
    expect(window.localStorage.getItem(ROUTE_STORAGE_KEY)).toBeNull();
  });

  it("an HTTP error from the direct host is an answer: no China mode", async () => {
    resetGatewayRouteForTests({ enabled: () => true });
    network({ direct: 503 });
    await prepareGatewayRoute();
    expect(currentRegion()).toBe("global");
  });

  it("a direct host that can't be reached puts the browser in China mode", async () => {
    resetGatewayRouteForTests({ enabled: () => true });
    network({ direct: "fail" });
    const changed = vi.fn();
    const off = subscribeRegion(changed);
    await prepareGatewayRoute();
    off();
    expect(changed).toHaveBeenCalled();
    expect(currentRegion()).toBe("cn");
    expect(gatewayBaseUrl()).toBe(CN);
    // remembered for the next page load
    resetGatewayRouteForTests({ enabled: () => true });
    expect(currentRegion()).toBe("cn");
  });

  it("gatewayFetch waits for the route, then goes the way it chose", async () => {
    resetGatewayRouteForTests({ enabled: () => true });
    const urls = network({ direct: "fail" });
    await gatewayFetch("/v1/pro");
    expect(urls).toEqual([`${BASE}/health`, `${CN}/health`, `${CN}/v1/pro`]);
  });

  it("a request that can't connect asks for the route again; an HTTP error doesn't", async () => {
    resetGatewayRouteForTests({ enabled: () => true });
    const urls = network({ request: 500 });
    await gatewayFetch("/v1/pro");
    expect(urls).toEqual([`${BASE}/health`, `${BASE}/v1/pro`]);
    await prepareGatewayRoute();
    expect(urls.length).toBe(2);

    urls.length = 0;
    network({ request: "fail", direct: "fail" });
    await expect(gatewayFetch("/v1/pro")).rejects.toBeInstanceOf(TypeError);
    await prepareGatewayRoute();
    expect(currentRegion()).toBe("cn");
  });

  it("?region=global pins the direct host, even with the relay remembered", async () => {
    window.localStorage.setItem(ROUTE_STORAGE_KEY, JSON.stringify({ route: "cn_relay", directCheckedAt: 0 }));
    resetGatewayRouteForTests({ enabled: () => true });
    const urls = network({ direct: "fail" });
    setSearch("?region=global");
    expect(currentRegion()).toBe("global");
    setSearch("");
    await prepareGatewayRoute();
    expect(urls).toEqual([]);
    expect(currentRegion()).toBe("global");
    expect(gatewayBaseUrl()).toBe(BASE);
    // ?region=auto gives the choice back to the route
    setSearch("?region=auto");
    expect(currentRegion()).toBe("cn");
  });

  it("?region=cn pins the cn. host without a probe", async () => {
    resetGatewayRouteForTests({ enabled: () => true });
    const urls = network({ relay: "fail" });
    setSearch("?region=cn");
    await prepareGatewayRoute();
    expect(urls).toEqual([]);
    expect(currentRegion()).toBe("cn");
    expect(gatewayBaseUrl()).toBe(CN);
  });

  it("China mode by country stays the default for CN visitors, with no probe", async () => {
    document.cookie = `${REGION_COOKIE}=cn; Path=/`;
    resetGatewayRouteForTests({ enabled: () => true });
    const urls = network({ relay: "fail" });
    await prepareGatewayRoute();
    expect(urls).toEqual([]);
    expect(currentRegion()).toBe("cn");
  });
});
