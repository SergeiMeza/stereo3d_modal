import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AuthProvider } from "@/lib/auth";
import type { Conversion } from "@/lib/api/types";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import { ConversionTracker } from "./ConversionTracker";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

function overdueRun(): Conversion {
  return {
    conversion_id: "c0000000stuk",
    state: "processing",
    kind: "video",
    params: {} as Conversion["params"],
    project_id: "p00000000001",
    step: "depth_preview",
    quote: { amount_cents: 50, currency: "usd" },
    progress: 0.2,
    stage: "profiling",
    overdue: true,
    created_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

// 2026-10-27: runs sat at "Profiling scenes" for hours with a bar that
// never moved and no way to tell us.
describe("ConversionTracker overdue run", () => {
  it("lets the user report it with a note, then thanks them", async () => {
    let sent: unknown = null;
    server.use(
      http.get(`${GATEWAY}/v1/conversions/:id`, () =>
        HttpResponse.json(overdueRun()),
      ),
      http.post(`${GATEWAY}/v1/conversions/:id/report`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({
          ...overdueRun(),
          reported_at: new Date().toISOString(),
        });
      }),
    );
    render(
      <AuthProvider>
        <ConversionTracker
          conversion={overdueRun()}
          onProjectChanged={() => {}}
        />
      </AuthProvider>,
    );
    expect(
      screen.getByText("This is taking much longer than expected."),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText("Anything we should know? (optional)"),
      {
        target: { value: "stuck since lunch" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Report it" }));
    expect(await screen.findByTestId("overdue-reported")).toBeTruthy();
    expect(sent).toEqual({ note: "stuck since lunch" });
  });

  it("stays quiet while a run is on time", () => {
    render(
      <AuthProvider>
        <ConversionTracker
          conversion={{ ...overdueRun(), overdue: false }}
          onProjectChanged={() => {}}
        />
      </AuthProvider>,
    );
    expect(screen.queryByTestId("overdue-notice")).toBeNull();
  });
});
