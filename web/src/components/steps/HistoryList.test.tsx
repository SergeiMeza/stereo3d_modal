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

import { HttpResponse, http } from "msw";

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

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
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

describe("Files: Details (owner 2026-11-07)", () => {
  const PREVIEW: Conversion = {
    conversion_id: "conv0000lifeprev",
    state: "succeeded",
    kind: "video",
    project_id: PROJECT_ID,
    step: "lifelike_preview",
    method: "lifelike",
    params: { preset: "1080p", formats: ["sbs"], from_frame: 24, to_frame: 144, target_fps: 12 },
    quote: { amount_cents: 0, currency: "usd", breakdown: { free_preview: true } },
    billing: { status: "free_preview" },
    progress: 1,
    outputs: ["sbs"],
    created_at: "2026-11-06T09:00:00Z",
    updated_at: "2026-11-06T09:04:00Z",
  };
  const FULL: Conversion = {
    conversion_id: "conv0000lifefull",
    state: "succeeded",
    kind: "video",
    project_id: PROJECT_ID,
    step: "production",
    method: "lifelike",
    params: { preset: "1080p", formats: ["mvhevc", "sbs"], original_eye: "left", express: true },
    quote: {
      amount_cents: 1700,
      currency: "usd",
      breakdown: { pro_discount_pct: 0.15, pro_discount_cents: 300 },
    },
    billing: { status: "charged", charged_cents: 1700 },
    progress: 1,
    outputs: ["mvhevc", "sbs"],
    created_at: "2026-11-07T09:00:00Z",
    updated_at: "2026-11-07T09:12:00Z",
  };
  const details = (li: HTMLElement) => within(li).queryByTestId("run-details");
  const row = (li: HTMLElement, label: string) =>
    within(li).queryByTestId(`detail-${label}`)?.querySelector("dd")?.textContent ?? null;
  const item = (id: string) => screen.getByTestId(`history-${id}`);

  it("closed by default; opening one leaves the others closed", () => {
    renderWithHistory([PREVIEW, FULL]);
    expect(screen.queryAllByTestId("run-details")).toHaveLength(0);
    const toggle = within(item(PREVIEW.conversion_id)).getByTestId("run-details-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(details(item(PREVIEW.conversion_id))).not.toBeNull();
    expect(details(item(FULL.conversion_id))).toBeNull();
    fireEvent.click(toggle);
    expect(details(item(PREVIEW.conversion_id))).toBeNull();
  });

  it("a preview: what, part, output, price; rows it has no data for are left out", () => {
    renderWithHistory([PREVIEW]);
    const li = item(PREVIEW.conversion_id);
    fireEvent.click(within(li).getByTestId("run-details-toggle"));
    expect(row(li, "What")).toBe("Preview · Lifelike 3D · Quick look");
    expect(row(li, "Part")).toMatch(/^0:01 – 0:06 · 5 s/);
    expect(row(li, "Frame rate")).toBe("12 fps");
    expect(row(li, "Files made")).toBe("Side by side .mp4");
    expect(row(li, "Price")).toBe("Free preview");
    expect(row(li, "Ordered")).toMatch(/^Nov 6/);
    expect(row(li, "Took")).toBe("about 4 min");
    // nothing stored, nothing shown
    for (const label of ["3D strength", "Depth detail", "Original eye", "Discount", "Receipt"]) {
      expect(row(li, label)).toBeNull();
    }
    // a Lifelike run's add-ons always read On or Off (owner 2026-11-07)
    expect(row(li, "Foveated Detail")).toBe("Off");
    expect(row(li, "Master bitrate")).toBe("Off");
    expect(row(li, "Express")).toBe("Off");
  });

  it("a full run: stored settings, the Pro discount, and the receipt from the purchases list", async () => {
    server.use(
      http.get(`${GATEWAY}/v1/billing/history`, () =>
        HttpResponse.json({
          rows: [
            {
              row_id: "r1",
              created_at: FULL.created_at,
              amount_cents: 1700,
              currency: "usd",
              status: "paid",
              receipt_url: "https://pay.example/receipt/r1",
              items: [{ conversion_id: FULL.conversion_id, project_id: PROJECT_ID, amount_cents: 1700 }],
            },
          ],
        }),
      ),
    );
    renderWithHistory([FULL]);
    const li = item(FULL.conversion_id);
    fireEvent.click(within(li).getByTestId("run-details-toggle"));
    expect(row(li, "What")).toBe("Full video · Lifelike 3D");
    expect(row(li, "Part")).toMatch(/^Whole video · /);
    expect(row(li, "Files made")).toBe("Vision Pro .mov, Side by side .mp4");
    expect(row(li, "Original eye")).toBe("Left");
    expect(row(li, "Express")).toBe("On");
    expect(row(li, "Foveated Detail")).toBe("Off");
    expect(row(li, "Master bitrate")).toBe("Off");
    expect(row(li, "Price")).toBe("$17.00");
    expect(row(li, "Discount")).toBe("Pro 15% · −$3.00");
    const receipt = await within(li).findByRole("link", { name: "View receipt" });
    expect(receipt.getAttribute("href")).toBe("https://pay.example/receipt/r1");
  });

  it("a failed classic run: its stored look, no finish time taken, files ordered", () => {
    renderWithHistory([FAILED]);
    const li = item(FAILED.conversion_id);
    fireEvent.click(within(li).getByTestId("run-details-toggle"));
    expect(row(li, "3D strength")).toBe("×1.10");
    expect(row(li, "Scenes tuned")).toBe("3");
    expect(row(li, "Files ordered")).toBe("Vision Pro .mov, Side by side (half size) .mp4");
    expect(row(li, "Took")).toBeNull();
    expect(row(li, "Price")).toBe("Not charged");
    // Classic runs have no add-ons
    for (const label of ["Foveated Detail", "Master bitrate", "Express"]) expect(row(li, label)).toBeNull();
  });

  it("a Lifelike run with Foveated Detail and Master bitrate reads On (owner 2026-11-07)", () => {
    const run: Conversion = {
      ...FULL,
      conversion_id: "conv0000lifefov",
      params: { ...FULL.params, foveation: "static", bitrate: "master", express: false } as Conversion["params"],
    };
    renderWithHistory([run]);
    const li = item(run.conversion_id);
    fireEvent.click(within(li).getByTestId("run-details-toggle"));
    expect(row(li, "Foveated Detail")).toBe("On");
    expect(row(li, "Master bitrate")).toBe("On");
    expect(row(li, "Express")).toBe("Off");
  });

  it("the Run ID copies for support", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithHistory([PREVIEW]);
    const li = item(PREVIEW.conversion_id);
    fireEvent.click(within(li).getByTestId("run-details-toggle"));
    expect(within(li).getByTestId("run-id").textContent).toBe(PREVIEW.conversion_id);
    fireEvent.click(within(li).getByTestId("run-id-copy"));
    expect(writeText).toHaveBeenCalledWith(PREVIEW.conversion_id);
    expect(await within(li).findByText("Copied")).toBeTruthy();
  });
});
