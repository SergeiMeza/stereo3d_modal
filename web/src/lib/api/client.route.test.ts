/**
 * BL-34: the GatewayClient settles the route before a request (before the
 * token, which depends on it) and tells the route about a failure before
 * any answer, never about an HTTP status.
 */

import { describe, expect, it, vi } from "vitest";

import { GatewayClient, GatewayError } from "@/lib/api/client";

function client(fetchFn: typeof fetch) {
  const order: string[] = [];
  const onConnectionFailure = vi.fn();
  const c = new GatewayClient({
    baseUrl: () => {
      order.push("base");
      return "https://gw.test";
    },
    getToken: async () => {
      order.push("token");
      return "tok";
    },
    fetchFn,
    prepare: async () => {
      order.push("prepare");
    },
    onConnectionFailure,
  });
  return { c, order, onConnectionFailure };
}

describe("GatewayClient and the route", () => {
  it("settles the route before the token and the base URL", async () => {
    const { c, order } = client((async () => Response.json({ ok: true })) as typeof fetch);
    await c.getBilling();
    expect(order).toEqual(["prepare", "token", "base"]);
  });

  it("reports a connection failure and throws it", async () => {
    const failure = new TypeError("Failed to fetch");
    const { c, onConnectionFailure } = client((async () => {
      throw failure;
    }) as typeof fetch);
    await expect(c.getBilling()).rejects.toBe(failure);
    expect(onConnectionFailure).toHaveBeenCalledWith(failure);
  });

  for (const status of [404, 500, 503]) {
    it(`doesn't report an HTTP ${status}`, async () => {
      const { c, onConnectionFailure } = client((async () =>
        Response.json({ error: "server_error", message: "no" }, { status })) as typeof fetch);
      await expect(c.getBilling()).rejects.toBeInstanceOf(GatewayError);
      expect(onConnectionFailure).not.toHaveBeenCalled();
    });
  }

  it("the event stream and the CSV wait for the route too", async () => {
    const { c, order } = client((async () => new Response("a,b", { status: 200 })) as typeof fetch);
    await c.usageCsv("2026-11");
    expect(order.slice(0, 2)).toEqual(["prepare", "token"]);
    order.length = 0;
    await c.openEvents(null, new AbortController().signal);
    expect(order.slice(0, 2)).toEqual(["prepare", "token"]);
  });
});
