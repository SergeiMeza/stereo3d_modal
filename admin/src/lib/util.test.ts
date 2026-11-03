import { describe, expect, it } from "vitest";

import { buildCsp } from "./csp";
import { ageHours, money, parseDollars, parseSignedDollars, until } from "./format";
import { safeExternalUrl } from "./links";
import { parseRoute } from "./router";

describe("format", () => {
  it("formats cents", () => {
    expect(money(4972)).toBe("$49.72");
    expect(money(5)).toBe("$0.05");
    expect(money(-1243)).toBe("-$12.43");
    expect(money(123456789)).toBe("$1,234,567.89");
  });
  it("parses dollar input strictly", () => {
    expect(parseDollars("12.43")).toBe(1243);
    expect(parseDollars("$12.4")).toBe(1240);
    expect(parseDollars("12")).toBe(1200);
    expect(parseDollars("12.345")).toBeNull();
    expect(parseDollars("-1")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
    expect(parseSignedDollars("-5")).toBe(-500);
  });
  it("formats ages and deadlines", () => {
    expect(ageHours(5)).toBe("5h");
    expect(ageHours(28)).toBe("1d 4h");
    const now = Date.parse("2026-11-03T00:00:00Z");
    expect(until("2026-11-03T09:00:00Z", now)).toBe("in 9 h");
    expect(until("2026-11-02T21:00:00Z", now)).toBe("3 h overdue");
  });
});

describe("safeExternalUrl", () => {
  it("allows https links to known hosts only", () => {
    expect(safeExternalUrl("https://dashboard.stripe.com/test/payments/pi_1")).toBe("https://dashboard.stripe.com/test/payments/pi_1");
    expect(safeExternalUrl("https://console.cloud.google.com/logs/query;query=x")).toContain("console.cloud.google.com");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("http://dashboard.stripe.com/x")).toBeNull();
    expect(safeExternalUrl("https://evil.example/x")).toBeNull();
    expect(safeExternalUrl("https://dashboard.stripe.com.evil.example/x")).toBeNull();
    expect(safeExternalUrl("https://user:pw@dashboard.stripe.com/x")).toBeNull();
    expect(safeExternalUrl("")).toBeNull();
  });
});

describe("csp", () => {
  it("names exactly the gateway and keeps scripts to self plus the Google popup loader", () => {
    const csp = buildCsp({ gateways: ["https://gw.example/v1"], forHeader: true });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' https://apis.google.com;");
    expect(csp).toContain("connect-src 'self' https://gw.example ");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe");
    expect(buildCsp({ gateways: ["https://gw.example"], forHeader: false })).not.toContain("frame-ancestors");
  });
});

describe("routes", () => {
  it("parses paths", () => {
    expect(parseRoute("/")).toEqual({ name: "cases" });
    expect(parseRoute("/cases/CASE-0042")).toEqual({ name: "case", id: "CASE-0042" });
    expect(parseRoute("/accounts/uid%2F1")).toEqual({ name: "account", uid: "uid/1" });
    expect(parseRoute("/disputes")).toEqual({ name: "disputes" });
    expect(parseRoute("/nope/x/y")).toEqual({ name: "not_found" });
  });
});

describe("vercel.json", () => {
  it("carries the same CSP header as the code, for both gateways", async () => {
    const { readFileSync } = await import("node:fs");
    const { GATEWAYS } = await import("./gateways");
    const cfg = JSON.parse(readFileSync(`${process.cwd()}/vercel.json`, "utf8"));
    const all = cfg.headers.find((h: { source: string }) => h.source === "/(.*)");
    const csp = all.headers.find((h: { key: string }) => h.key === "Content-Security-Policy").value;
    expect(csp).toBe(buildCsp({ gateways: [GATEWAYS.test, GATEWAYS.prod], forHeader: true }));
  });
});
