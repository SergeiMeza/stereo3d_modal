/**
 * Apple's app-site-association (passkeys for the SVS app): the file is
 * valid JSON with the app's id, both paths answer as application/json,
 * nothing redirects them, and the proxy leaves them alone.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error -- Next's own copy (the one its redirects use), untyped
import { pathToRegexp } from "next/dist/compiled/path-to-regexp";
import { describe, expect, it } from "vitest";

import nextConfig, { AASA_PATH, AASA_ROOT_PATH, BARE_TO_WWW_SOURCE } from "../next.config";
import { config as proxyConfig } from "@/proxy";

const APP_ID = "NMC6CQECM6.com.oliver-ai.spatial-photo-studio";

describe("apple-app-site-association", () => {
  it("is exactly the webcredentials JSON with the app id", () => {
    const raw = readFileSync(join(__dirname, "..", "public", AASA_PATH), "utf8");
    expect(raw).toBe(`{"webcredentials":{"apps":["${APP_ID}"]}}`);
    expect(JSON.parse(raw)).toEqual({ webcredentials: { apps: [APP_ID] } });
  });

  it("is served as application/json at both paths, the root one by rewrite", async () => {
    const headers = await nextConfig.headers!();
    for (const path of [AASA_PATH, AASA_ROOT_PATH]) {
      const entry = headers.find((h) => h.source === path);
      expect(entry?.headers).toEqual([{ key: "Content-Type", value: "application/json" }]);
    }
    const rewrites = await nextConfig.rewrites!();
    const list = Array.isArray(rewrites) ? rewrites : rewrites.afterFiles;
    expect(list).toContainEqual({ source: AASA_ROOT_PATH, destination: AASA_PATH });
  });

  it("redirects the bare domain to www for every path but Apple's", async () => {
    const [redirect] = await nextConfig.redirects!();
    expect(redirect).toMatchObject({
      source: BARE_TO_WWW_SOURCE,
      has: [{ type: "host", value: "stereo3d.studio" }],
      destination: "https://www.stereo3d.studio/:path",
      permanent: true,
    });
    const re = pathToRegexp(BARE_TO_WWW_SOURCE, [], {}) as RegExp;
    for (const p of ["/", "/plans", "/projects/abc", "/pricing", "/.well-knownish"]) {
      expect(re.test(p), p).toBe(true);
    }
    for (const p of [AASA_PATH, AASA_ROOT_PATH, "/.well-known/apple-developer-merchantid-domain-association"]) {
      expect(re.test(p), p).toBe(false);
    }
  });

  it("the proxy doesn't run on either path", () => {
    const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);
    expect(matcher.test("/plans")).toBe(true);
    expect(matcher.test(AASA_PATH)).toBe(false);
    expect(matcher.test(AASA_ROOT_PATH)).toBe(false);
  });
});
