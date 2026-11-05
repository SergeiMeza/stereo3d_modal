/**
 * Conversion history (the workspace History page): ordering, state chips,
 * quoted totals, click-to-copy support handles, downloads expander with
 * inline previews, and failed-run error messages.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Conversion, Project } from "@/lib/api/types";
import { AuthProvider } from "@/lib/auth";
import { SettleProvider } from "@/components/pay/SettleSheet";
import { BillingProvider } from "@/lib/billing";
import { outstandingCents, payToDownload } from "@/lib/billingCopy";
import { mockDb } from "@/mocks/handlers";
import { server } from "@/mocks/server";

import projectFixture from "../../../fixtures/project.json";

import { HistoryList } from "./HistoryList";
import { stageLabel as stageLabelFor } from "./stageLabels";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  mockDb.reset();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const PROJECT_ID = (projectFixture as { project_id: string }).project_id;

const SUCCEEDED: Conversion = {
  conversion_id: "conv00000older",
  state: "succeeded",
  kind: "video",
  project_id: PROJECT_ID,
  step: "depth_preview",
  params: {
    preset: "draft",
    formats: ["anaglyph"],
    inpaint: "none",
    depth_res: 980,
    target_fps: 12,
  },
  quote: { amount_cents: 50, currency: "usd" },
  progress: 1,
  outputs: ["anaglyph", "half_sbs", "depth", "depth_vis"],
  created_at: "2026-07-02T09:00:00Z",
  updated_at: "2026-07-02T09:10:00Z",
};

const FAILED: Conversion = {
  conversion_id: "conv00000newer",
  state: "failed",
  kind: "video",
  project_id: PROJECT_ID,
  step: "production",
  params: {
    preset: "1080p",
    formats: ["mvhevc", "half_sbs"],
    inpaint: "propainter",
    depth_res: 1442,
    depth_scale: 1.1,
    scene_overrides: [
      { first: 0, displacement: 0.02 },
      { first: 266, shot_type: "wide" },
      { first: 314, shot_type: "close_up" },
    ],
  },
  quote: { amount_cents: 150, currency: "usd" },
  progress: 0.4,
  error: {
    code: "upstream_error",
    message:
      "Conversion failed — contact support with conversion_id conv00000newer.",
  },
  created_at: "2026-07-02T10:00:00Z",
  updated_at: "2026-07-02T10:05:00Z",
};

function renderWithHistory(conversions: Conversion[]) {
  // history reads props.project.conversions; the mock db must agree so the
  // downloads endpoint recognizes the succeeded run
  for (const c of conversions) {
    mockDb.conversions.set(c.conversion_id, structuredClone(c));
  }
  const project: Project = {
    ...(structuredClone(projectFixture) as unknown as Project),
    conversions: conversions.map((c) => structuredClone(c)),
  };
  render(
    <AuthProvider>
      <BillingProvider>
        <SettleProvider>
          <HistoryList project={project} />
        </SettleProvider>
      </BillingProvider>
    </AuthProvider>,
  );
}

describe("Files (screen 09)", () => {
  it("lists runs newest-first: what it is, method, state in a word, price with a word only when unusual", () => {
    renderWithHistory([SUCCEEDED, FAILED]);
    const [first, second] = screen.getAllByRole("listitem").filter((li) =>
      li.getAttribute("data-testid")?.startsWith("history-"),
    );
    expect(first.getAttribute("data-testid")).toBe("history-conv00000newer");
    expect(within(first).getByText("Full video")).toBeDefined();
    expect(within(first).getByTestId("run-status").textContent).toBe("Failed");
    expect(within(first).getByTestId("history-price").textContent).toBe(
      "$1.50 · Not charged",
    );
    expect(within(first).getByText("Something went wrong on our side.")).toBeDefined();
    expect(within(first).getByTestId("history-method").textContent).toBe("Classic 3D");

    expect(second.getAttribute("data-testid")).toBe("history-conv00000older");
    expect(within(second).getByText("Depth preview")).toBeDefined();
    expect(within(second).getByTestId("run-status").textContent).toBe("Ready");
    expect(within(second).getByTestId("history-price").textContent).toBe("$0.50");
    // a short line: quality and date, never internal values
    expect(within(first).getByTestId("history-params").textContent).toMatch(
      /^1080p · \S+/,
    );
    expect(document.body.textContent).not.toMatch(/propainter|depth_res|conv00000/);
  });

  it("lists a finished run's files by device, depth preview scoped to its depth video", async () => {
    renderWithHistory([SUCCEEDED]);
    const files = await screen.findByTestId("run-files");
    // the depth run sells its depth video only; depth_vis is never offered
    expect(within(files).getByTestId("file-group-depth")).toBeDefined();
    expect(within(files).queryByTestId("file-group-anaglyph")).toBeNull();
    const link = within(files).getByRole("link", { name: "Download" });
    // S3D-31: the gateway names the file (Content-Disposition); we never rename it
    expect(link.getAttribute("download")).toBe("");
  });

  it("while a payment is outstanding, downloads read Pay $X to download (S3D-35)", async () => {
    const other: Conversion = { ...SUCCEEDED, conversion_id: "conv00000owed", quote: { amount_cents: 1250, currency: "usd" } };
    mockDb.conversions.set(other.conversion_id, structuredClone(other));
    mockDb.failCharge(other.conversion_id);
    const made: Conversion = {
      ...SUCCEEDED,
      conversion_id: "conv00000made",
      step: "production",
      params: { preset: "1080p", formats: ["sbs"] },
      outputs: ["sbs"],
    };
    renderWithHistory([made]);
    const pay = await screen.findByTestId("pay-to-download");
    expect(pay.textContent).toBe("Pay $12.50 to download");
    const files = screen.getByTestId("run-files");
    expect(within(files).queryByRole("link", { name: "Download" })).toBeNull();
    // playing the file is the same access: View in 3D reads Pay $X to play
    expect(within(files).queryByTestId("view-in-3d")).toBeNull();
    const play = within(files).getByTestId("pay-to-play");
    expect(play.textContent).toBe("Pay $12.50 to play");
    // P9: either opens the settle sheet (P2)
    fireEvent.click(pay);
    expect(await screen.findByTestId("settle-sheet")).toBeTruthy();
  });

  it("sums what's owed; nothing owed means plain downloads", () => {
    expect(outstandingCents(null)).toBe(0);
    expect(
      outstandingCents({
        unpaid: [
          { amount_cents: 300, currency: "usd", needs_action: false },
          { amount_cents: 1200, currency: "usd", needs_action: false },
        ],
      }),
    ).toBe(1500);
    expect(payToDownload(1500)).toBe("Pay $15 to download");
    expect(payToDownload(725, "play")).toBe("Pay $7.25 to play");
  });

  it("refreshes expired links on click", async () => {
    const fetches: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname.endsWith("/downloads")) fetches.push(request.url);
    });
    renderWithHistory([
      { ...SUCCEEDED, step: "production", params: { preset: "1080p", formats: ["sbs"] } },
    ]);
    const files = await screen.findByTestId("run-files");
    expect(fetches).toHaveLength(1);
    const link = within(files).getAllByRole("link")[0] as HTMLAnchorElement;
    // a live link downloads as is
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(fetches).toHaveLength(1);
    // past expires_in: fresh links first
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 400 * 24 * 3600 * 1000);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(fetches).toHaveLength(2));
  });
});

describe("Files in a headset browser (S3D-47, screen 13b)", () => {
  it("puts this headset's files first with View in 3D on every row and one hint", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 OculusBrowser/35.1.0.0 Chrome/126.0.0.0 VR Safari/537.36",
    );
    renderWithHistory([
      {
        ...SUCCEEDED,
        step: "production",
        params: { preset: "1080p", formats: ["mvhevc", "half_sbs"] },
        outputs: ["mvhevc", "half_sbs"],
      },
    ]);
    const files = await screen.findByTestId("run-files");
    const mine = within(files).getByTestId("file-group-half_sbs");
    expect(within(mine).getByText("This headset")).toBeDefined();
    expect(within(mine).getAllByTestId("view-in-3d")[0].textContent).toBe("View in 3D");
    expect(within(files).getAllByTestId("view-in-3d-hint")).toHaveLength(1);
    // the Vision Pro file folds away
    const others = within(files).getByTestId("other-files") as HTMLDetailsElement;
    expect(others.open).toBe(false);
    expect(within(others).getByTestId("file-group-mvhevc")).toBeDefined();
  });
});

describe("a running row says where it is (owner 2026-11-05)", () => {
  it("the current step, a thin bar and the time left, from the run's own polls", async () => {
    const running: Conversion = {
      ...FAILED,
      conversion_id: "conv0000running",
      state: "processing",
      stage: "render",
      progress: 0.3,
      eta_seconds: 360,
      created_at: "2026-11-05T09:00:00Z",
    };
    renderWithHistory([running]);
    const row = screen.getByTestId("history-conv0000running");
    expect(within(row).getByTestId("run-compact-step").textContent).toBe("Making the 3D video · Rendering in 3D");
    expect(within(row).getByTestId("run-compact-eta").textContent).toBe("about 6 min left");
    expect(within(row).getByRole("progressbar")).toBeTruthy();
    // one state chip: the row's own
    expect(within(row).getAllByTestId("run-status")).toHaveLength(1);
    // the run moves on (the mock's next poll): the row follows it
    expect(
      await within(row).findByText(`Making the 3D video · ${stageLabelFor("video_stereo")}`, undefined, { timeout: 4000 }),
    ).toBeTruthy();
  });
});
