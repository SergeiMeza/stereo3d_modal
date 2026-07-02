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

  it("rejects depth_scale and scene_overrides on depth_preview", async () => {
    await expectInvalid(
      { step: "depth_preview", depth_scale: 1.1 },
      "depth_scale is not a depth_preview parameter",
    );
    await expectInvalid(
      { step: "depth_preview", scene_overrides: [{ first: 0, shot_type: "wide" }] },
      "scene_overrides is not a depth_preview parameter",
    );
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
  it("depth_preview: the WHOLE subtotal scales with the depth_res factor, clamped to [0.5, 4.0]", async () => {
    // base = ceil(149.458/60 × 10¢) = 25¢
    const std = (await (await quote({ step: "depth_preview" })).json()) as StepQuoteResponse;
    expect(std.quote.breakdown).toMatchObject({
      base_cents: 25,
      depth_res: 980, // preset default when absent
      depth_res_factor: 1,
      subtotal_cents: 25,
    });
    expect(std.quote.breakdown!.inpaint_multiplier).toBeUndefined();

    const hi = (await (
      await quote({ step: "depth_preview", depth_res: 1442 })
    ).json()) as StepQuoteResponse;
    expect(hi.quote.breakdown).toMatchObject({
      base_cents: 25,
      depth_res: 1442,
      depth_res_factor: 2.1651, // (1442/980)², 4 dp
      subtotal_cents: 54, // round(25 × 2.16510…)
    });

    // clamps: 518 → 0.5, 2520 → 4.0
    const lo = (await (
      await quote({ step: "depth_preview", depth_res: 518 })
    ).json()) as StepQuoteResponse;
    expect(lo.quote.breakdown!.depth_res_factor).toBe(0.5);
    const max = (await (
      await quote({ step: "depth_preview", depth_res: 2520 })
    ).json()) as StepQuoteResponse;
    expect(max.quote.breakdown!.depth_res_factor).toBe(4);
  });

  it("stereo/production apply the factor to 0.35 of the base; stereo+propainter adds ×1.6", async () => {
    // stereo base = ceil(149.458/60 × 25¢) = 63¢
    const stereo = (await (
      await quote({ step: "stereo_preview", depth_res: 1442 })
    ).json()) as StepQuoteResponse;
    // 63 × (1 + 0.35 × 1.16510…) = 88.69… → 89
    expect(stereo.quote.breakdown!.subtotal_cents).toBe(89);

    const inpainted = (await (
      await quote({ step: "stereo_preview", inpaint: "propainter" })
    ).json()) as StepQuoteResponse;
    expect(inpainted.quote.breakdown).toMatchObject({
      base_cents: 63,
      inpaint_multiplier: 1.6,
      subtotal_cents: 101, // round(63 × 1.6)
    });

    // production propainter is the default and NOT multiplied
    const prod = (await (
      await quote({ step: "production", inpaint: "propainter" })
    ).json()) as StepQuoteResponse;
    expect(prod.quote.breakdown!.inpaint_multiplier).toBeUndefined();
    expect(prod.quote.breakdown!.subtotal_cents).toBe(250);
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

describe("mock gateway success side effects", () => {
  it("a succeeded conversion stamps scene_profile (current scenes version) and exposes depth_vis", async () => {
    // create → confirm payment → poll to succeeded (one tick per poll)
    const createRes = await fetch(`${GATEWAY}/v1/projects/${PID}/conversions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "depth_preview" }),
    });
    expect(createRes.status).toBe(200);
    const conv = (await createRes.json()) as Conversion;
    await fetch(`${GATEWAY}/__mock__/confirm-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversion_id: conv.conversion_id }),
    });
    let state = "created";
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
