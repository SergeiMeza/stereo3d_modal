/**
 * MSW handlers — a stateful in-memory gateway seeded from REAL API fixtures
 * (web/fixtures/, captured from the test deployment; see build_fixtures.py).
 *
 * The mock implements the same rules as the gateway (scene-cut validation,
 * version conflicts, step templates, quote math with the default rates) so
 * screen tests exercise real binding behavior, not happy-path stubs.
 *
 * Lifecycle simulation: conversions auto-advance one state per GET poll
 * (created→[after mock payment]→paid→processing→succeeded), so polling UIs
 * can be tested deterministically: each refetch moves the world forward.
 * Tests can also force any state via mockDb.setConversionState().
 */

import { HttpResponse, http } from "msw";

import downloadsFixture from "../../fixtures/downloads_succeeded.json";
import projectFixture from "../../fixtures/project.json";
import sceneProfileFixture from "../../fixtures/scene_profile.json";
import type {
  Conversion,
  Project,
  SceneOverride,
  SceneProfile,
  Step,
  StepConversionRequest,
} from "@/lib/api/types";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787";

// Default rates — keep in sync with gateway/internal/pricing/pricing.go.
const RATES = {
  centsPerMinute: { draft: 25, "1080p": 100, qhd: 150, "3k": 200, "4k": 300 },
  stepCentsPerMinute: { depth_preview: 10, stereo_preview: 25 },
  minimumCents: 50,
  discountThresholdCents: 1000,
  discountPct: 0.1,
  stageShares: { depth: 0.35, preprocess: 0.05 },
  analyzeCreditCents: 50,
};

interface DB {
  projects: Map<string, Project>;
  conversions: Map<string, Conversion>;
  /** conversions that received a mock payment confirmation */
  paid: Set<string>;
  idem: Map<string, string>; // Idempotency-Key → conversion_id
}

function seed(): DB {
  const project = structuredClone(projectFixture) as unknown as Project;
  // real captures predate project management — the gateway now always sends
  // archived (and pinned when true), so default them here, not in fixtures
  project.archived = false;
  return {
    projects: new Map([[project.project_id, project]]),
    conversions: new Map(),
    paid: new Set(),
    idem: new Map(),
  };
}

export const mockDb = {
  ...seed(),
  reset() {
    const fresh = seed();
    this.projects = fresh.projects;
    this.conversions = fresh.conversions;
    this.paid = fresh.paid;
    this.idem = fresh.idem;
  },
  setConversionState(id: string, state: Conversion["state"]) {
    const c = this.conversions.get(id);
    if (!c) throw new Error(`no mock conversion ${id}`);
    c.state = state;
    if (state === "succeeded") {
      c.progress = 1;
      succeed(c);
    }
  },
};

function err(status: number, code: string, message: string) {
  return HttpResponse.json(
    { success: false, error: code, message },
    { status },
  );
}

let nextId = 1;
function newId(): string {
  return `m0c${String(nextId++).padStart(9, "0")}`;
}

const SHOT_TYPES = ["close_up", "standard", "dynamic", "wide"];

/** Mirror of the gateway's pro-step request validation — same rules, same
 * user-facing messages, so tests exercise real error surfacing. Returns an
 * error response or null. `body` is the raw JSON (so rejected fields the
 * typed request no longer carries — displacement — are still seen). */
function validateStepRequest(
  p: Project,
  body: Record<string, unknown>,
): ReturnType<typeof err> | null {
  const step = body.step as Step;
  if (!["depth_preview", "stereo_preview", "production"].includes(step)) {
    return err(400, "invalid_request", "step must be depth_preview|stereo_preview|production");
  }
  if (body.displacement !== undefined) {
    return err(
      400,
      "invalid_request",
      "displacement is not a pro-step parameter; use scene_overrides[].displacement or depth_scale",
    );
  }
  const depthRes = body.depth_res;
  if (depthRes !== undefined) {
    if (
      typeof depthRes !== "number" ||
      !Number.isInteger(depthRes) ||
      depthRes % 14 !== 0 ||
      depthRes < 140 ||
      depthRes > 2520
    ) {
      return err(400, "invalid_request", "depth_res must be a multiple of 14 in [140, 2520]");
    }
  }
  const depthScale = body.depth_scale;
  if (depthScale !== undefined) {
    if (step === "depth_preview") {
      return err(400, "invalid_request", "depth_scale is not a depth_preview parameter");
    }
    if (typeof depthScale !== "number" || depthScale < 0.3 || depthScale > 1.5) {
      return err(400, "invalid_request", "depth_scale must be in [0.3, 1.5]");
    }
  }
  const overrides = body.scene_overrides as SceneOverride[] | undefined;
  if (overrides !== undefined) {
    if (step === "depth_preview") {
      return err(400, "invalid_request", "scene_overrides is not a depth_preview parameter");
    }
    const cuts = new Set(p.scenes?.cuts ?? []);
    let prev = -1;
    for (const o of overrides) {
      if (o.first !== 0 && !cuts.has(o.first)) {
        return err(
          400,
          "invalid_request",
          `scene_overrides[].first ${o.first} is not 0 or a current scene cut`,
        );
      }
      if (o.first <= prev) {
        return err(400, "invalid_request", "scene_overrides[].first must be strictly increasing");
      }
      prev = o.first;
      if (
        o.shot_type === undefined &&
        o.displacement === undefined &&
        o.placement === undefined
      ) {
        return err(
          400,
          "invalid_request",
          "scene_overrides entries need at least one of shot_type|displacement|placement",
        );
      }
      if (o.displacement !== undefined && (o.displacement <= 0 || o.displacement > 0.03)) {
        return err(400, "invalid_request", "scene_overrides[].displacement must be in (0, 0.03]");
      }
      if (o.shot_type !== undefined && !SHOT_TYPES.includes(o.shot_type)) {
        return err(
          400,
          "invalid_request",
          "scene_overrides[].shot_type must be close_up|standard|dynamic|wide",
        );
      }
      if (o.placement !== undefined) {
        const [near, far] = o.placement;
        if (o.placement.length !== 2 || !(near >= -1.5 && near < far && far <= 1.5)) {
          return err(
            400,
            "invalid_request",
            "scene_overrides[].placement must be [near, far] with -1.5<=near<far<=1.5",
          );
        }
      }
    }
  }
  if (body.inpaint !== undefined && !["none", "propainter"].includes(body.inpaint as string)) {
    return err(400, "invalid_request", "inpaint must be none|propainter");
  }
  if ((typeof body.target_fps === "number" ? body.target_fps : 0) > p.probe!.fps * 1.001) {
    return err(400, "invalid_request", "target_fps cannot exceed the source frame rate");
  }
  return null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function quoteFor(
  project: Project,
  req: StepConversionRequest,
): {
  quote: Conversion["quote"];
  reuseStages: string[];
  params: Conversion["params"];
} {
  const probe = project.probe!;
  const from = req.from_frame ?? 0;
  const to = req.to_frame && req.to_frame < probe.num_frames ? req.to_frame : probe.num_frames;
  const billable = (to - from) / probe.fps;
  const step = req.step as Step;
  const preset = step === "depth_preview" ? "draft" : (req.preset ?? "1080p");
  const perMin =
    step === "production"
      ? RATES.centsPerMinute[preset as keyof typeof RATES.centsPerMinute]
      : RATES.stepCentsPerMinute[step];
  const base = Math.ceil((billable / 60) * perMin);
  // depth-resolution factor on the depth share: the WHOLE base is depth work
  // on depth_preview; 0.35 of it on the other steps. Absent depth_res =
  // preset default (the mock uses the 980 standard for every preset).
  const depthRes = req.depth_res ?? 980;
  const depthFactor = clamp((depthRes / 980) ** 2, 0.5, 4.0);
  const depthShare = step === "depth_preview" ? 1 : RATES.stageShares.depth;
  let subtotal = Math.round(base * (1 + depthShare * (depthFactor - 1)));
  const inpaint =
    step === "depth_preview" // depth_preview never inpaints
      ? "none"
      : (req.inpaint ?? (step === "production" ? "propainter" : "none"));
  // production preset rates already include inpainting; stereo previews
  // price the optional ProPainter pass explicitly.
  const inpaintMult = step === "stereo_preview" && inpaint === "propainter" ? 1.6 : 1;
  subtotal = Math.round(subtotal * inpaintMult);
  // reuse: production only, when a prior succeeded conversion exists
  const reuseStages: string[] = [];
  if (step === "production" && !req.from_scratch) {
    const hasPrior = [...mockDb.conversions.values()].some(
      (c) => c.project_id === project.project_id && c.state === "succeeded",
    );
    if (hasPrior) reuseStages.push("depth", "preprocess");
  }
  const share = reuseStages.reduce(
    (s, st) => s + (RATES.stageShares[st as keyof typeof RATES.stageShares] ?? 0),
    0,
  );
  const reuseDiscount = Math.round(subtotal * Math.min(share, 0.9));
  const afterReuse = subtotal - reuseDiscount;
  const bulk =
    afterReuse > RATES.discountThresholdCents
      ? Math.round(afterReuse * RATES.discountPct)
      : 0;
  const credit = project.analyze.credit_available ? RATES.analyzeCreditCents : 0;
  const total = Math.max(afterReuse - bulk - credit, RATES.minimumCents);
  return {
    quote: {
      amount_cents: total,
      currency: "usd",
      rate_version: "mock",
      breakdown: {
        step,
        preset,
        billable_seconds: Math.round(billable * 100) / 100,
        cents_per_minute: perMin,
        base_cents: base,
        depth_res: depthRes,
        depth_res_factor: Math.round(depthFactor * 10000) / 10000,
        ...(inpaintMult !== 1 ? { inpaint_multiplier: inpaintMult } : {}),
        subtotal_cents: subtotal,
        reuse_stages: reuseStages,
        reuse_discount_cents: reuseDiscount,
        discount_cents: bulk,
        analyze_credit_cents: credit,
      },
    },
    reuseStages,
    params: {
      preset,
      // step defaults: depth_preview always anaglyph; stereo_preview sbs;
      // production mvhevc+half_sbs
      formats:
        step === "depth_preview"
          ? ["anaglyph"]
          : (req.formats ??
            (step === "production" ? ["mvhevc", "half_sbs"] : ["sbs"])),
      inpaint,
      depth_res: depthRes,
      ...(req.depth_scale !== undefined ? { depth_scale: req.depth_scale } : {}),
      ...(req.scene_overrides?.length ? { scene_overrides: req.scene_overrides } : {}),
      // previews default to HALF the source rate; never above source
      target_fps:
        req.target_fps ||
        (step === "production"
          ? undefined
          : Math.round((probe.fps / 2) * 100) / 100),
      from_frame: req.from_frame || undefined,
      to_frame: req.to_frame || undefined,
      scene_cuts: project.scenes?.cuts,
      skip_reuse: req.from_scratch || undefined,
    },
  };
}

/** payment material is only returned on create, like the gateway */
function stripPayment(c: Conversion): Omit<Conversion, "payment"> {
  const clone = { ...c };
  delete clone.payment;
  return clone;
}

/** Success side effects, like the real pipeline's: the run's outputs gain
 * the depth artifacts (depth + the browser-playable depth_vis), and a pro
 * video conversion stamps the project's scene_profile (the adaptive
 * profiler's per-shot parameters) with the CURRENT scenes version. */
function succeed(c: Conversion) {
  c.outputs = [...(c.params.formats ?? []), "depth", "depth_vis"];
  const p = c.project_id ? mockDb.projects.get(c.project_id) : undefined;
  if (p && c.step) {
    const profile = structuredClone(
      sceneProfileFixture.scene_profile,
    ) as unknown as SceneProfile;
    p.scene_profile = {
      ...profile,
      conversion_id: c.conversion_id,
      scenes_version: p.scenes?.version ?? profile.scenes_version,
      updated_at: new Date().toISOString(),
    };
  }
}

/** One poll = one lifecycle tick (paid→processing→succeeded). */
function tick(c: Conversion) {
  if (c.state === "created" && mockDb.paid.has(c.conversion_id)) c.state = "paid";
  else if (c.state === "paid") {
    c.state = "processing";
    c.progress = 0.1;
    c.stage = "preprocess";
  } else if (c.state === "processing") {
    c.progress = Math.min((c.progress ?? 0) + 0.3, 1);
    c.stage = c.progress < 0.5 ? "video_depth" : "video_stereo";
    if (c.progress >= 1) {
      c.state = "succeeded";
      c.stage = "";
      succeed(c);
    }
  }
}

export const handlers = [
  http.post(`${GATEWAY}/v1/customers`, () =>
    HttpResponse.json({ customer_id: "cus_mock" }),
  ),

  http.post(`${GATEWAY}/v1/uploads`, async ({ request }) => {
    const { filename } = (await request.json()) as { filename: string };
    const id = newId();
    const ext = filename.slice(filename.lastIndexOf("."));
    return HttpResponse.json({
      upload_id: id,
      gcs_key: `stereo3d/test/users/dev-user/${id}/source${ext}`,
      upload_url: `${GATEWAY}/__mock__/upload/${id}`,
      headers: { "Content-Type": "video/mp4" },
      expires_in: 900,
    });
  }),
  http.put(`${GATEWAY}/__mock__/upload/:id`, () => new HttpResponse(null, { status: 200 })),

  http.post(`${GATEWAY}/v1/projects`, async ({ request }) => {
    const { gcs_key, name } = (await request.json()) as { gcs_key: string; name?: string };
    if (!gcs_key.includes("/users/dev-user/")) {
      return err(400, "invalid_request", "gcs_key is not one of your uploads");
    }
    const template = structuredClone(projectFixture) as unknown as Project;
    const id = gcs_key.split("/").at(-2) ?? newId();
    const project: Project = {
      ...template,
      project_id: id,
      name: name || "Untitled project",
      analyze: { state: "running", error: "", credit_cents: 0, credit_available: false },
      probe: undefined,
      scenes: undefined,
      strip_thumbs: undefined,
      scene_thumbs: undefined,
      archived: false,
    };
    mockDb.projects.set(id, project);
    // analyze "completes" on the next GET (deterministic for tests)
    return HttpResponse.json(project);
  }),

  // default: ACTIVE (non-archived) projects; ?archived=1: ONLY archived ones
  http.get(`${GATEWAY}/v1/projects`, ({ request }) => {
    const archived = new URL(request.url).searchParams.get("archived") === "1";
    return HttpResponse.json({
      projects: [...mockDb.projects.values()].filter(
        (p) => (p.archived ?? false) === archived,
      ),
    });
  }),

  http.get(`${GATEWAY}/v1/projects/:id`, ({ params }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    if (p.analyze.state === "running") {
      // fold in the fixture analysis, like the gateway's read-through poll
      const t = structuredClone(projectFixture) as unknown as Project;
      Object.assign(p, {
        analyze: t.analyze,
        probe: t.probe,
        scenes: t.scenes,
        crop: t.crop,
        strip_thumbs: t.strip_thumbs,
        scene_thumbs: t.scene_thumbs,
      });
    }
    const conversions = [...mockDb.conversions.values()]
      .filter((c) => c.project_id === p.project_id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return HttpResponse.json({ ...p, conversions });
  }),

  http.patch(`${GATEWAY}/v1/projects/:id`, async ({ params, request }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    const body = (await request.json()) as {
      name?: string;
      pinned?: boolean;
      archived?: boolean;
    };
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (name === "" || name.length > 120) {
        return err(400, "invalid_request", "name must be 1-120 characters");
      }
      p.name = name;
    }
    if (body.pinned !== undefined) {
      // the gateway omits pinned:false (Go omitempty) — mirror that
      if (body.pinned) p.pinned = true;
      else delete p.pinned;
    }
    if (body.archived !== undefined) {
      p.archived = body.archived;
      // archiving cancels the project's active conversions, like the gateway
      if (body.archived) {
        for (const c of mockDb.conversions.values()) {
          if (
            c.project_id === p.project_id &&
            !["succeeded", "failed", "canceled", "expired"].includes(c.state)
          ) {
            c.state = "canceled";
          }
        }
      }
    }
    p.updated_at = new Date().toISOString();
    const conversions = [...mockDb.conversions.values()]
      .filter((c) => c.project_id === p.project_id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return HttpResponse.json({ ...p, conversions });
  }),

  http.patch(`${GATEWAY}/v1/projects/:id/scenes`, async ({ params, request }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    if (!p.scenes || !p.probe) return err(409, "conflict", "analysis has not completed yet");
    const { cuts, expect_version } = (await request.json()) as {
      cuts: number[];
      expect_version?: number;
    };
    for (let i = 0; i < cuts.length; i++) {
      if (!Number.isInteger(cuts[i]) || cuts[i] <= 0 || cuts[i] >= p.probe.num_frames) {
        return err(400, "invalid_request", "cuts must be source-frame indices in (0, num_frames)");
      }
      if (i > 0 && cuts[i] <= cuts[i - 1]) {
        return err(400, "invalid_request", "cuts must be strictly increasing");
      }
    }
    if (expect_version !== undefined && expect_version !== p.scenes.version) {
      return err(409, "conflict", "scene list changed since you loaded it — reload and retry");
    }
    p.scenes = {
      version: p.scenes.version + 1,
      cuts,
      edited: true,
      updated_at: new Date().toISOString(),
    };
    return HttpResponse.json({ scenes: p.scenes });
  }),

  http.post(`${GATEWAY}/v1/projects/:id/quotes`, async ({ params, request }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    if (!p.probe) return err(409, "conflict", "analysis has not completed yet");
    const body = (await request.json()) as Record<string, unknown>;
    const invalid = validateStepRequest(p, body);
    if (invalid) return invalid;
    const req = body as unknown as StepConversionRequest;
    const { quote, reuseStages, params: resolved } = quoteFor(p, req);
    return HttpResponse.json({
      step: req.step,
      params: resolved,
      quote,
      reuse_stages: reuseStages,
    });
  }),

  http.post(`${GATEWAY}/v1/projects/:id/conversions`, async ({ params, request }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    if (!p.probe) return err(409, "conflict", "analysis has not completed yet");
    const idem = request.headers.get("Idempotency-Key");
    if (idem && mockDb.idem.has(idem)) {
      return HttpResponse.json(mockDb.conversions.get(mockDb.idem.get(idem)!));
    }
    const body = (await request.json()) as Record<string, unknown>;
    const invalid = validateStepRequest(p, body);
    if (invalid) return invalid;
    const req = body as unknown as StepConversionRequest;
    const { quote, params: resolved } = quoteFor(p, req);
    if (p.analyze.credit_available) p.analyze.credit_available = false;
    const id = newId();
    const conv: Conversion = {
      conversion_id: id,
      state: "created",
      kind: "video",
      project_id: p.project_id,
      step: req.step,
      scenes_version: p.scenes?.version,
      params: resolved,
      quote,
      progress: 0,
      stage: "",
      eta_seconds: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      payment: {
        payment_intent_client_secret: `pi_mock_secret_${id}`,
        ephemeral_key_secret: "ek_mock",
        customer_id: "cus_mock",
        publishable_key: "pk_test_mock",
      },
    };
    mockDb.conversions.set(id, conv);
    if (idem) mockDb.idem.set(idem, id);
    return HttpResponse.json(conv);
  }),

  /** Mock payment confirmation — what the MockCheckout component calls in
   * place of stripe.confirmPayment. Flips created→paid on the next poll. */
  http.post(`${GATEWAY}/__mock__/confirm-payment`, async ({ request }) => {
    const { conversion_id } = (await request.json()) as { conversion_id: string };
    if (!mockDb.conversions.has(conversion_id)) {
      return err(404, "not_found", "conversion not found");
    }
    mockDb.paid.add(conversion_id);
    return HttpResponse.json({ ok: true });
  }),

  http.get(`${GATEWAY}/v1/conversions/:id`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    tick(c);
    c.updated_at = new Date().toISOString();
    return HttpResponse.json(stripPayment(c));
  }),

  http.delete(`${GATEWAY}/v1/conversions/:id`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    if (!["succeeded", "failed", "canceled", "expired"].includes(c.state)) {
      c.state = "canceled";
    }
    return HttpResponse.json(stripPayment(c));
  }),

  http.get(`${GATEWAY}/v1/conversions/:id/downloads`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    if (c.state !== "succeeded") return err(409, "conflict", "conversion has no outputs yet");
    // REAL published outputs from the captured draft job — the preview
    // players render the actual anaglyph/depth of the sample video.
    const real = downloadsFixture.downloads as Record<string, string>;
    return HttpResponse.json({
      downloads: Object.fromEntries(
        (c.outputs ?? []).map((name) => [
          name,
          real[name] ??
            `https://storage.googleapis.com/mock/${c.conversion_id}/${name}.mp4`,
        ]),
      ),
      expires_in: 86400,
    });
  }),

  http.delete(`${GATEWAY}/v1/projects/:id`, ({ params }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    mockDb.projects.delete(params.id as string);
    return HttpResponse.json(p);
  }),
];
