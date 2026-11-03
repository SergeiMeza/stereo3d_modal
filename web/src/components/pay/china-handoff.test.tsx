/**
 * China mode (P5/P6) and paying on another device (P7/P8), spec v6 G2,
 * against the mock gateway's spec F shapes.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Conversion } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { ChinaPaySheet, setChinaNavigateForTests } from "./ChinaPaySheet";
import { countdown, HandoffSheet, shortLink } from "./HandoffSheet";
import { HandoffPage, setHandoffNavigateForTests } from "./HandoffPage";

const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/",
}));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  search.value = "";
});
afterAll(() => server.close());

function waitingRun(): Conversion {
  const c: Conversion = {
    conversion_id: "cwait0000001",
    state: "created",
    kind: "video",
    project_id: "a1b2c3d4e5f6",
    step: "production",
    params: { preset: "4k", formats: ["mvhevc"] },
    quote: { amount_cents: 4972, currency: "usd" },
    progress: 0,
    billing: { status: "requires_payment", reason: "no_method" },
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
  };
  mockDb.conversions.set(c.conversion_id, c);
  return c;
}

describe("China mode sheet (P6) and WeChat QR (P5)", () => {
  it("computer: Alipay and WeChat Pay; Alipay leaves for its page; WeChat shows the code", async () => {
    const c = waitingRun();
    const go = vi.fn();
    setChinaNavigateForTests(go);
    render(
      <AuthProvider>
        <ChinaPaySheet conversionId={c.conversion_id} projectId="a1b2c3d4e5f6" amountCents={4972} onClose={() => {}} />
      </AuthProvider>,
    );
    const sheet = screen.getByTestId("china-sheet");
    expect(within(sheet).getByRole("heading").textContent).toBe("Pay for your 3D video");
    expect(within(sheet).getByTestId("pay-lines").textContent).toContain("Charged in US dollars.");
    fireEvent.click(within(sheet).getByTestId("china-alipay"));
    await waitFor(() => expect(go).toHaveBeenCalled());
    expect(go.mock.calls[0][0]).toContain("mock-pay.example/alipay");
    cleanup();
    render(
      <AuthProvider>
        <ChinaPaySheet conversionId={c.conversion_id} amountCents={4972} onClose={() => {}} />
      </AuthProvider>,
    );
    fireEvent.click(screen.getByTestId("china-wechat"));
    expect(await screen.findByTestId("wechat-qr")).toBeTruthy();
    expect(screen.getByText("Scan with WeChat to pay $49.72")).toBeTruthy();
    expect(screen.getByText("Waiting for payment…")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Stripe|relay|proxy/i);
  });
});

describe("Pay on another device (P7)", () => {
  it("shows the short link, emails it, counts down, and closes once paid elsewhere", async () => {
    const c = waitingRun();
    const closed = vi.fn();
    render(
      <AuthProvider>
        <HandoffSheet conversionId={c.conversion_id} onPayHere={() => {}} onClose={closed} />
      </AuthProvider>,
    );
    const link = await screen.findByTestId("handoff-link");
    expect(link.textContent).toMatch(/^stereo3d\.studio\/p\/[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(screen.getByTestId("handoff-expires").textContent).toMatch(/^Expires in (29|30):\d\d$/);
    fireEvent.click(screen.getByRole("button", { name: "Email me the link" }));
    expect((await screen.findByTestId("handoff-email")).textContent).toBe("Sent to d•••@example.com.");
    expect(screen.getByRole("button", { name: "Pay here instead" })).toBeTruthy();
    // paid on the phone
    const [code] = [...mockDb.billing.handoffs.keys()];
    mockDb.billing.handoffs.get(code)!.state = "paid";
    mockDb.conversions.get(c.conversion_id)!.state = "paid";
    expect(await screen.findByText("Paid. Starting your 3D…", undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(closed).toHaveBeenCalledWith(true), { timeout: 3000 });
  });

  it("formats the link and the countdown", () => {
    expect(shortLink("https://stereo3d.studio/p/K7M2-QX9P")).toBe("stereo3d.studio/p/K7M2-QX9P");
    expect(countdown(29 * 60_000 + 41_000)).toBe("29:41");
    expect(countdown(-5)).toBe("0:00");
  });
});

describe("Hand-off page (P8)", () => {
  async function openCode(): Promise<string> {
    const c = waitingRun();
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787"}/v1/conversions/${c.conversion_id}/handoff`,
      { method: "POST", body: "{}" },
    );
    const { code } = (await res.json()) as { code: string };
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  it("ready: what it pays for, the two lines, Continue to payment; back from paying: Paid", async () => {
    const code = await openCode();
    const go = vi.fn();
    setHandoffNavigateForTests(go);
    render(
      <AuthProvider>
        <HandoffPage code={code} />
      </AuthProvider>,
    );
    expect((await screen.findByTestId("handoff-amount")).textContent).toBe("$49.72");
    expect(screen.getByText("3D video · 4K")).toBeTruthy();
    expect(screen.getByText("For d•••@example.com")).toBeTruthy();
    expect(screen.getByText("Refunded in full if it fails.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("handoff-continue"));
    await waitFor(() => expect(go).toHaveBeenCalled());
    expect(go.mock.calls[0][0]).toContain(`/p/${code}?back=1`);
    cleanup();
    search.value = "back=1";
    render(
      <AuthProvider>
        <HandoffPage code={code} />
      </AuthProvider>,
    );
    expect(await screen.findByText("Paid. You can go back to your headset.")).toBeTruthy();
  });

  it("a bad link and too many tries say so", async () => {
    render(
      <AuthProvider>
        <HandoffPage code="ZZZZ-ZZZZ" />
      </AuthProvider>,
    );
    expect(await screen.findByText("This link didn't work. Check it and try again.")).toBeTruthy();
    cleanup();
    mockDb.billing.handoffRateLimited = true;
    render(
      <AuthProvider>
        <HandoffPage code="ZZZZ-ZZZZ" />
      </AuthProvider>,
    );
    expect(await screen.findByText("Too many tries. Wait a minute.")).toBeTruthy();
  });
});
