/**
 * Mock-gateway contract tests: the MSW handlers must enforce the SAME
 * validation rules and quote math as the real gateway (per-scene adaptive
 * contract), because every panel test binds against them. Raw fetches, no
 * components — this file pins the wire behavior.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import projectFixture from "../../fixtures/project.json";
import sceneProfileFixture from "../../fixtures/scene_profile.json";
import type { Conversion, Project, StepQuoteResponse } from "@/lib/api/types";

import { mockDb } from "./handlers";
import { server } from "./server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  mockDb.reset();
});
afterAll(() => server.close());

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";
const FIXTURE = projectFixture as unknown as Project;
const PID = FIXTURE.project_id;
const CUTS = FIXTURE.scenes!.cuts;

async function quote(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${GATEWAY}/v1/projects/${PID}/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectInvalid(body: Record<string, unknown>, message: string) {
  const res = await quote(body);
  expect(res.status).toBe(400);
  const parsed = (await res.json()) as { error: string; message: string };
  expect(parsed.error).toBe("invalid_request");
  expect(parsed.message).toBe(message);
}

describe("mock gateway validation", () => {
  it("rejects top-level displacement on every pro step with the exact message", async () => {
    for (const step of ["depth_preview", "stereo_preview", "production"]) {
      await expectInvalid(
        { step, displacement: 0.015 },
        "displacement is not a pro-step parameter; use scene_overrides[].displacement or depth_scale",
      );
    }
  });

  it("rejects depth_res outside multiples of 14 in [140, 2520]", async () => {
    for (const depth_res of [981, 126, 2534, 14.5]) {
      await expectInvalid(
        { step: "depth_preview", depth_res },
        "depth_res must be a multiple of 14 in [140, 2520]",
      );
    }
    // boundary values pass
    for (const depth_res of [140, 2520]) {
      expect((await quote({ step: "depth_preview", depth_res })).status).toBe(200);
    }
  });

  it("rejects depth_scale and depth-knob scene_overrides on depth_preview; passthrough-only is accepted", async () => {
    await expectInvalid(
      { step: "depth_preview", depth_scale: 1.1 },
      "depth_scale is not a depth_preview parameter",
    );
    // depth knobs stay stereo/production-only on this step…
    await expectInvalid(
      { step: "depth_preview", scene_overrides: [{ first: 0, shot_type: "wide" }] },
      "scene_overrides[]: depth_preview accepts passthrough only; displacement/shot_type/placement apply to stereo_preview and production",
    );
    await expectInvalid(
      {
        step: "depth_preview",
        scene_overrides: [
          { first: 0, passthrough: true },
          { first: 240, displacement: 0.02 },
        ],
      },
      "scene_overrides[]: depth_preview accepts passthrough only; displacement/shot_type/placement apply to stereo_preview and production",
    );
    // …but passthrough-only overrides are the depth step's scene input
    // (those scenes ship as 2D: black depth, no AI pass)
    const ok = await quote({
      step: "depth_preview",
      scene_overrides: [{ first: 0, passthrough: true }],
    });
    expect(ok.status).toBe(200);
  });

  it("rejects depth_scale outside [0.3, 1.5]", async () => {
    await expectInvalid(
      { step: "stereo_preview", depth_scale: 0.2 },
      "depth_scale must be in [0.3, 1.5]",
    );
    await expectInvalid(
      { step: "production", depth_scale: 1.6 },
      "depth_scale must be in [0.3, 1.5]",
    );
  });

  it("enforces every scene_overrides rule", async () => {
    const step = "stereo_preview";
    // first must be 0 or a CURRENT cut
    await expectInvalid(
      { step, scene_overrides: [{ first: 123, shot_type: "wide" }] },
      "scene_overrides[].first 123 is not 0 or a current scene cut",
    );
    // strictly increasing
    await expectInvalid(
      {
        step,
        scene_overrides: [
          { first: CUTS[1], shot_type: "wide" },
          { first: CUTS[0], shot_type: "wide" },
        ],
      },
      "scene_overrides[].first must be strictly increasing",
    );
    // at least one key per entry
    await expectInvalid(
      { step, scene_overrides: [{ first: 0 }] },
      "scene_overrides entries need at least one of shot_type|displacement|placement",
    );
    // displacement (0, 0.03]
    await expectInvalid(
      { step, scene_overrides: [{ first: 0, displacement: 0.05 }] },
      "scene_overrides[].displacement must be in (0, 0.03]",
    );
    await expectInvalid(
      { step, scene_overrides: [{ first: 0, displacement: 0 }] },
      "scene_overrides[].displacement must be in (0, 0.03]",
    );
    // shot_type enum
    await expectInvalid(
      { step, scene_overrides: [{ first: 0, shot_type: "macro" }] },
      "scene_overrides[].shot_type must be close_up|standard|dynamic|wide",
    );
    // placement [near, far], -1.5<=near<far<=1.5
    await expectInvalid(
      { step, scene_overrides: [{ first: 0, placement: [0.5, 0.2] }] },
      "scene_overrides[].placement must be [near, far] with -1.5<=near<far<=1.5",
    );
    await expectInvalid(
      { step, scene_overrides: [{ first: 0, placement: [-2, 0.5] }] },
      "scene_overrides[].placement must be [near, far] with -1.5<=near<far<=1.5",
    );
    // a fully valid set passes (0 and real cuts, increasing)
    const ok = await quote({
      step,
      scene_overrides: [
        { first: 0, displacement: 0.02 },
        { first: CUTS[0], shot_type: "wide", placement: [-0.2, 0.4] },
      ],
    });
    expect(ok.status).toBe(200);
  });

  it("passthrough is mutually exclusive with the depth keys; a bare {first, passthrough:true} passes", async () => {
    const step = "stereo_preview";
    for (const extra of [
      { shot_type: "wide" },
      { displacement: 0.01 },
      { placement: [-0.2, 0.4] },
    ]) {
      await expectInvalid(
        { step, scene_overrides: [{ first: 0, passthrough: true, ...extra }] },
        "scene_overrides[].passthrough cannot be combined with shot_type|displacement|placement",
      );
    }
    const ok = await quote({
      step,
      scene_overrides: [
        { first: 0, passthrough: true },
        { first: CUTS[0], displacement: 0.02 },
      ],
    });
    expect(ok.status).toBe(200);
    const echoed = (await ok.json()) as StepQuoteResponse;
    expect(echoed.params.scene_overrides).toEqual([
      { first: 0, passthrough: true },
      { first: CUTS[0], displacement: 0.02 },
    ]);
    // production accepts it too
    expect(
      (
        await quote({
          step: "production",
          scene_overrides: [{ first: 0, passthrough: true }],
        })
      ).status,
    ).toBe(200);
  });

  it("still caps target_fps at the source rate and validates inpaint", async () => {
    await expectInvalid(
      { step: "stereo_preview", target_fps: 60 },
      "target_fps cannot exceed the source frame rate",
    );
    await expectInvalid(
      { step: "stereo_preview", inpaint: "lama" },
      "inpaint must be none|propainter",
    );
  });
});

describe("mock gateway quote math + params echo", () => {
  it("depth_preview: the WHOLE subtotal scales with the aspect-aware depth factor, clamped to [0.5, 5.0]", async () => {
    // absent target_fps → half rate (12/24 = fps factor 0.5):
    // base = ceil(149.458/60 × 75¢ cost × 3 margin × 0.5) = 281¢. The fixture is
    // letterboxed 2.39:1 (crop 3840:1606), so factors are elongation-aware:
    // factor = depth_res² × 2.391 / (980² × 16⁄9).
    // Absent depth_res = the draft preset's input_size 518 → 0.376 → 0.5.
    const std = (await (await quote({ step: "depth_preview" })).json()) as StepQuoteResponse;
    expect(std.quote.breakdown).toMatchObject({
      base_cents: 281,
      fps_factor: 0.5,
      depth_res: 518, // the draft preset's input_size when absent
      depth_res_factor: 0.5,
      subtotal_cents: 141,
    });
    expect(std.quote.breakdown!.inpaint_multiplier).toBeUndefined();

    const hi = (await (
      await quote({ step: "depth_preview", depth_res: 1442 })
    ).json()) as StepQuoteResponse;
    expect(hi.quote.breakdown).toMatchObject({
      base_cents: 281,
      depth_res: 1442,
      depth_res_factor: 2.912, // 1442²×2.391 / (980²×16⁄9), 4 dp
      subtotal_cents: 818, // round(281 × 2.91197…)
    });

    // clamps: 518 → 0.5, 2520 (8.89× the base MP) → the 5.0 ceiling
    const lo = (await (
      await quote({ step: "depth_preview", depth_res: 518 })
    ).json()) as StepQuoteResponse;
    expect(lo.quote.breakdown!.depth_res_factor).toBe(0.5);
    const max = (await (
      await quote({ step: "depth_preview", depth_res: 2520 })
    ).json()) as StepQuoteResponse;
    expect(max.quote.breakdown!.depth_res_factor).toBe(5);
  });

  it("stereo/production apply the factor to 0.35 of the base; stereo+propainter adds ×1.6", async () => {
    // stereo base = ceil(149.458/60 × 120¢ × 3 × 0.5 half-rate) = 449¢
    const stereo = (await (
      await quote({ step: "stereo_preview", depth_res: 1442 })
    ).json()) as StepQuoteResponse;
    // 449 × (1 + 0.35 × 1.91197…) = 749.47… → 749
    expect(stereo.quote.breakdown!.subtotal_cents).toBe(749);

    const inpainted = (await (
      await quote({ step: "stereo_preview", inpaint: "propainter" })
    ).json()) as StepQuoteResponse;
    // absent depth_res → 1080p preset's 980 → aspect factor 1.34496 on the
    // 0.35 share → 280¢, then ×1.6
    expect(inpainted.quote.breakdown).toMatchObject({
      base_cents: 449,
      inpaint_multiplier: 1.6,
      subtotal_cents: 805, // round(round(449 × 1.12074) × 1.6)
    });

    // production propainter is the default and NOT multiplied; full source
    // rate (fps factor 1): base = ceil(149.458/60 × 450¢) = 1121¢
    const prod = (await (
      await quote({ step: "production", inpaint: "propainter" })
    ).json()) as StepQuoteResponse;
    expect(prod.quote.breakdown!.inpaint_multiplier).toBeUndefined();
    expect(prod.quote.breakdown!.fps_factor).toBe(1);
    expect(prod.quote.breakdown!.subtotal_cents).toBe(1256); // round(1121 × 1.12074)
  });

  it("echoes depth_res/depth_scale/inpaint/scene_overrides in params, with step defaults", async () => {
    const res = (await (
      await quote({
        step: "stereo_preview",
        depth_scale: 1.1,
        scene_overrides: [{ first: 0, displacement: 0.02 }],
      })
    ).json()) as StepQuoteResponse;
    expect(res.params).toMatchObject({
      formats: ["sbs"], // stereo_preview default
      inpaint: "none",
      depth_res: 980,
      depth_scale: 1.1,
      scene_overrides: [{ first: 0, displacement: 0.02 }],
    });

    const depth = (await (
      await quote({ step: "depth_preview" })
    ).json()) as StepQuoteResponse;
    expect(depth.params.formats).toEqual(["anaglyph"]);
    expect(depth.params.inpaint).toBe("none");

    const prod = (await (
      await quote({ step: "production" })
    ).json()) as StepQuoteResponse;
    expect(prod.params.formats).toEqual(["mvhevc", "half_sbs"]);
    expect(prod.params.inpaint).toBe("propainter");
    expect(prod.params.target_fps).toBeUndefined(); // full rate
  });
});

describe("mock gateway quote eta", () => {
  it("every quote response carries a plausible top-level eta_seconds", async () => {
    for (const step of ["depth_preview", "stereo_preview", "production"] as const) {
      const res = (await (await quote({ step })).json()) as StepQuoteResponse;
      expect(typeof res.eta_seconds).toBe("number");
      expect(res.eta_seconds!).toBeGreaterThan(0);
    }
    // production estimates longer than a preview of the same footage
    const prev = (await (
      await quote({ step: "depth_preview" })
    ).json()) as StepQuoteResponse;
    const prod = (await (
      await quote({ step: "production" })
    ).json()) as StepQuoteResponse;
    expect(prod.eta_seconds!).toBeGreaterThan(prev.eta_seconds!);
  });
});

describe("mock gateway analyze lifecycle", () => {
  it("a new project reports progress/stage/eta on each poll, then the analysis folds in", async () => {
    const createRes = await fetch(`${GATEWAY}/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gcs_key: "stereo3d/test/users/dev-user/newproj00001/source.mp4",
        name: "progress test",
      }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as Project;
    expect(created.analyze.state).toBe("running");
    expect(created.analyze.stage).toBe("analyze");
    expect(created.analyze.progress).toBeGreaterThan(0);
    expect(created.analyze.eta_seconds).toBeGreaterThan(0);

    // each GET advances exactly one stage, monotonically
    const seen: Array<{ stage?: string; progress?: number }> = [];
    let p = created;
    for (let i = 0; i < 10 && p.analyze.state === "running"; i++) {
      p = (await (
        await fetch(`${GATEWAY}/v1/projects/${created.project_id}`)
      ).json()) as Project;
      if (p.analyze.state === "running") {
        seen.push({ stage: p.analyze.stage, progress: p.analyze.progress });
      }
    }
    expect(seen.map((s) => s.stage)).toEqual([
      "analyze",
      "proxy",
      "scene_detect",
      "thumbnails",
    ]);
    const progresses = seen.map((s) => s.progress!);
    expect([...progresses].sort((a, b) => a - b)).toEqual(progresses);

    // terminal fold-in: succeeded, probe/scenes present, progress fields gone
    expect(p.analyze.state).toBe("succeeded");
    expect(p.analyze.progress).toBeUndefined();
    expect(p.probe).toBeDefined();
    expect(p.scenes).toBeDefined();
  });
});

describe("mock gateway free profile endpoint", () => {
  async function startProfile(): Promise<Response> {
    return fetch(`${GATEWAY}/v1/projects/${PID}/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  }

  it("starts a running profile, 409s a duplicate, advances on GET 1, completes on GET 2 with a cuts-derived scene_profile", async () => {
    const res = await startProfile();
    expect(res.status).toBe(200);
    const started = (await res.json()) as Project;
    expect(started.profile).toMatchObject({
      state: "running",
      scenes_version: FIXTURE.scenes!.version,
      stage: "profiling",
    });
    expect(started.profile!.progress).toBeGreaterThan(0);
    expect(started.scene_profile).toBeUndefined();

    // a second start while running → conflict, like the gateway
    const dup = await startProfile();
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe("conflict");

    // GET 1: still running, progress advanced
    const mid = (await (
      await fetch(`${GATEWAY}/v1/projects/${PID}`)
    ).json()) as Project;
    expect(mid.profile!.state).toBe("running");
    expect(mid.profile!.progress!).toBeGreaterThan(started.profile!.progress!);

    // GET 2: succeeded — progress/stage gone, scene_profile folded in
    const done = (await (
      await fetch(`${GATEWAY}/v1/projects/${PID}`)
    ).json()) as Project;
    expect(done.profile).toMatchObject({
      state: "succeeded",
      scenes_version: FIXTURE.scenes!.version,
    });
    expect(done.profile!.progress).toBeUndefined();
    expect(done.profile!.stage).toBeUndefined();

    const profile = done.scene_profile!;
    expect(profile.conversion_id).toMatch(/^profile:/);
    expect(profile.scenes_version).toBe(done.scenes!.version);
    // shots tile [0, num_frames) exactly along the CURRENT cuts
    expect(profile.shots[0].first_src).toBe(0);
    expect(profile.shots.at(-1)!.last_src).toBe(FIXTURE.probe!.num_frames);
    expect(profile.shots.map((s) => s.first_src)).toEqual([0, ...CUTS]);
    for (let i = 1; i < profile.shots.length; i++) {
      expect(profile.shots[i].first_src).toBe(profile.shots[i - 1].last_src);
    }
    for (const s of profile.shots) {
      expect(["close_up", "standard", "dynamic", "wide"]).toContain(s.shot_type);
      expect(s.displacement).toBeGreaterThan(0);
      expect(s.displacement).toBeLessThanOrEqual(0.03);
      expect(s.placement[0]).toBeLessThan(s.placement[1]);
    }

    // a NEW profile can start once the previous one settled
    expect((await startProfile()).status).toBe(200);
  });

  it("409s before analysis has completed", async () => {
    const createRes = await fetch(`${GATEWAY}/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gcs_key: "stereo3d/test/users/dev-user/profearly0001/source.mp4",
      }),
    });
    const created = (await createRes.json()) as Project;
    const res = await fetch(
      `${GATEWAY}/v1/projects/${created.project_id}/profile`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(409);
  });
});

describe("mock gateway success side effects", () => {
  it("a succeeded conversion stamps scene_profile (current scenes version) and exposes depth_vis", async () => {
    // create (enters at "paid" — billing verified, no payment step) → poll
    // to succeeded (one tick per poll)
    const createRes = await fetch(`${GATEWAY}/v1/projects/${PID}/conversions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "depth_preview" }),
    });
    expect(createRes.status).toBe(200);
    const conv = (await createRes.json()) as Conversion;
    expect(conv.state).toBe("paid");
    let state: string = conv.state;
    for (let i = 0; i < 10 && state !== "succeeded"; i++) {
      const poll = (await (
        await fetch(`${GATEWAY}/v1/conversions/${conv.conversion_id}`)
      ).json()) as Conversion;
      state = poll.state;
    }
    expect(state).toBe("succeeded");

    // GET project now carries the scene_profile, stamped to THIS run and
    // the CURRENT scenes version, shots tiling the timeline
    const project = (await (
      await fetch(`${GATEWAY}/v1/projects/${PID}`)
    ).json()) as Project;
    expect(project.scene_profile).toBeDefined();
    expect(project.scene_profile!.conversion_id).toBe(conv.conversion_id);
    expect(project.scene_profile!.scenes_version).toBe(project.scenes!.version);
    expect(project.scene_profile!.shots).toEqual(
      (sceneProfileFixture as { scene_profile: { shots: unknown } }).scene_profile
        .shots,
    );

    // downloads include the browser-playable depth_vis
    const downloads = (await (
      await fetch(`${GATEWAY}/v1/conversions/${conv.conversion_id}/downloads`)
    ).json()) as { downloads: Record<string, string> };
    expect(Object.keys(downloads.downloads).sort()).toEqual([
      "anaglyph",
      "depth",
      "depth_vis",
    ]);
    expect(downloads.downloads.depth_vis).toMatch(/^https:\/\//);
  });
});
