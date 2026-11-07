/**
 * BL-34: the three payment call sites that named the global gateway URL
 * (CheckoutPane's stand-in confirm, one-tap's bank check, the outstanding
 * charge's 3DS) take the routed base URL: the cn. host in China mode, by
 * country or by route, and the direct host as before everywhere else.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { completeChargeAction } from "@/components/billing/settleAction";
import { CheckoutPane } from "@/components/pay/CheckoutPane";
import { handleOneTapAction } from "@/components/pay/oneTap";
import { deriveCnGatewayUrl, prepareGatewayRoute, REGION_COOKIE, resetGatewayRouteForTests } from "@/lib/region";

const BASE = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const CN = deriveCnGatewayUrl(BASE);

function stubNetwork(directHealth: "ok" | "fail" = "ok"): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === `${BASE}/health` && directHealth === "fail") throw new TypeError("Failed to fetch");
      if (url.endsWith("/health")) return new Response(null, { status: 200 });
      return Response.json({ status: "succeeded", result: "paid" });
    }),
  );
  return urls;
}

async function payThreeWays(): Promise<void> {
  await completeChargeAction("pk_test", "pi_secret_1");
  await handleOneTapAction("pk_test", "pi_secret_2");
  render(
    <CheckoutPane clientSecret="cs_mock_1">
      {(form, body) => (
        <div>
          {body}
          <button type="button" onClick={() => void form.confirm()}>
            pay
          </button>
        </div>
      )}
    </CheckoutPane>,
  );
  fireEvent.click(screen.getByText("pay"));
}

const paths = ["/__mock__/complete-3ds", "/__mock__/one-tap-action", "/__mock__/checkout/cs_mock_1/confirm"];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = `${REGION_COOKIE}=; Path=/; Max-Age=0`;
  window.localStorage.clear();
  resetGatewayRouteForTests();
});

describe("payment call sites use the routed gateway URL", () => {
  it("outside China: the direct host, unchanged", async () => {
    const urls = stubNetwork();
    await payThreeWays();
    await waitFor(() => expect(urls).toHaveLength(3));
    expect(urls).toEqual(paths.map((p) => `${BASE}${p}`));
  });

  it("China mode by country: the cn. host", async () => {
    document.cookie = `${REGION_COOKIE}=cn; Path=/`;
    const urls = stubNetwork();
    await payThreeWays();
    await waitFor(() => expect(urls).toHaveLength(3));
    expect(urls).toEqual(paths.map((p) => `${CN}${p}`));
  });

  it("on the relay route: the cn. host", async () => {
    resetGatewayRouteForTests({ enabled: () => true });
    const urls = stubNetwork("fail");
    await prepareGatewayRoute();
    urls.length = 0;
    await payThreeWays();
    await waitFor(() => expect(urls).toHaveLength(3));
    expect(urls).toEqual(paths.map((p) => `${CN}${p}`));
  });
});
