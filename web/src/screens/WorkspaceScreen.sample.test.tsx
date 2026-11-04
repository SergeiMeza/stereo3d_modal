/**
 * A fresh account's sample (owner 2026-11-04): it opens from the welcome
 * on the same routes as any project (GET /v1/projects/{id}, the run's GET
 * /v1/conversions/{id}/downloads), and a failure there reads "The sample
 * isn't available right now", never a raw "not found".
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SAMPLE_UNAVAILABLE } from "@/components/steps/loadError";
import { AuthProvider } from "@/lib/auth";
import { BillingProvider } from "@/lib/billing";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";
import WorkspaceScreen from "@/screens/WorkspaceScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/projects/samplesunset",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/paymentRegion", () => ({ chinaPayments: () => false }));

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const requests: string[] = [];

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
  });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  requests.length = 0;
  window.history.replaceState(null, "", window.location.pathname);
});
afterAll(() => server.close());

/** A new account: no projects, the sample seeded on the first list. */
async function freshAccountWithSample(): Promise<void> {
  mockDb.projects.clear();
  mockDb.conversions.clear();
  mockDb.sampleSeeding = true;
  const list = (await (await fetch(`${GATEWAY}/v1/projects`)).json()) as { projects: { project_id: string; sample?: boolean }[] };
  expect(list.projects.find((p) => p.sample)?.project_id).toBe("samplesunset");
  requests.length = 0;
}

function open(): void {
  window.history.replaceState(null, "", "#tab=files");
  render(
    <AuthProvider>
      <BillingProvider>
        <WorkspaceScreen projectId="samplesunset" />
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("a fresh account's sample", () => {
  it("opens with its files, on the project and downloads routes only", async () => {
    await freshAccountWithSample();
    open();
    expect(await screen.findByText("Sunset session")).toBeTruthy();
    await waitFor(() => expect(requests).toContain("GET /v1/conversions/samplesunset-3d/downloads"));
    expect(requests).toContain("GET /v1/projects/samplesunset");
    const conversionRoutes = requests.filter((r) => r.includes("/v1/conversions/"));
    expect(conversionRoutes.every((r) => /^GET \/v1\/conversions\/samplesunset-3d(\/downloads)?$/.test(r))).toBe(true);
    expect(screen.queryByText(SAMPLE_UNAVAILABLE)).toBeNull();
    expect(document.body.textContent).not.toMatch(/not found/i);
  });

  it("says the sample isn't available when its run can't be read", async () => {
    await freshAccountWithSample();
    server.use(
      http.get(`${GATEWAY}/v1/conversions/:id/downloads`, () =>
        HttpResponse.json({ error: { code: "not_found", message: "conversion not found" } }, { status: 404 }),
      ),
    );
    open();
    expect(await screen.findByText(SAMPLE_UNAVAILABLE)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/not found/i);
  });
});
