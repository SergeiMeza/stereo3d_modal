/**
 * Region detection (China mode): the edge decision the proxy makes, the
 * browser's reading of it (cookie and ?region= override), and the gateway
 * host each region talks to.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  REGION_COOKIE,
  REGION_PIN_COOKIE,
  currentRegion,
  decideRegion,
  deriveCnGatewayUrl,
  gatewayBaseUrl,
  regionForCountry,
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
