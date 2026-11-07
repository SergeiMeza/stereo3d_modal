/**
 * The edge half of region detection: the proxy turns Vercel's country
 * header (or a ?region= pin) into the s3d_region cookie the browser reads.
 */

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

function request(
  path: string,
  opts: { country?: string; cookie?: string } = {},
): NextRequest {
  const headers = new Headers();
  if (opts.country) headers.set("x-vercel-ip-country", opts.country);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  return new NextRequest(new URL(path, "https://www.stereo3d.studio"), {
    headers,
  });
}

describe("proxy region cookie", () => {
  it("sets s3d_region=cn for a mainland China visitor", () => {
    const res = proxy(request("/signin", { country: "CN" }));
    expect(res.cookies.get("s3d_region")?.value).toBe("cn");
    expect(res.cookies.get("s3d_region_pin")).toBeUndefined();
  });

  it("sets global elsewhere and leaves an up-to-date cookie alone", () => {
    expect(
      proxy(request("/", { country: "US" })).cookies.get("s3d_region")?.value,
    ).toBe("global");
    expect(
      proxy(request("/", { country: "US", cookie: "s3d_region=global" }))
        .cookies.get("s3d_region"),
    ).toBeUndefined();
  });

  it("pins ?region=cn from outside China, and the pin sticks", () => {
    const res = proxy(request("/signin?region=cn", { country: "JP" }));
    expect(res.cookies.get("s3d_region")?.value).toBe("cn");
    expect(res.cookies.get("s3d_region_pin")?.value).toBe("cn");

    const later = proxy(
      request("/projects", {
        country: "JP",
        cookie: "s3d_region=cn; s3d_region_pin=cn",
      }),
    );
    expect(later.cookies.get("s3d_region")).toBeUndefined(); // unchanged
  });

  it("?region=auto drops the pin", () => {
    const res = proxy(
      request("/?region=auto", {
        country: "JP",
        cookie: "s3d_region=cn; s3d_region_pin=cn",
      }),
    );
    expect(res.cookies.get("s3d_region")?.value).toBe("global");
    expect(res.cookies.get("s3d_region_pin")?.value).toBe("");
  });
});

describe("proxy ?hl= (owner 2026-11-07: the site's links carry their language)", () => {
  it("sets NEXT_LOCALE from a known ?hl= for a year, and the request reads it", () => {
    const req = request("/projects?hl=ja", { country: "JP" });
    const res = proxy(req);
    const c = res.cookies.get("NEXT_LOCALE");
    expect(c?.value).toBe("ja");
    expect(c?.maxAge).toBe(60 * 60 * 24 * 365);
    expect(req.cookies.get("NEXT_LOCALE")?.value).toBe("ja");
  });

  it("ignores an unknown ?hl= and leaves no cookie", () => {
    expect(proxy(request("/?hl=xx")).cookies.get("NEXT_LOCALE")).toBeUndefined();
    expect(proxy(request("/")).cookies.get("NEXT_LOCALE")).toBeUndefined();
  });
});
