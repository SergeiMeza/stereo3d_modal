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
 * Tests can also force any state via mockDb.setConversionState(). The free
 * profile job (POST .../profile) advances the same way: project GET #1
 * moves its progress, GET #2 completes it and folds a cuts-derived
 * scene_profile into the project.
 */

import { HttpResponse, http } from "msw";

import downloadsFixture from "../../fixtures/downloads_succeeded.json";
import projectFixture from "../../fixtures/project.json";
import sceneProfileFixture from "../../fixtures/scene_profile.json";
import type {
  BillingCard,
  Conversion,
  ProfileShot,
  Project,
  SceneOverride,
  SceneProfile,
  ShotType,
  Step,
  StepConversionRequest,
  UnpaidCharge,
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

/** Pay-as-you-go billing state, mirroring the gateway's GET /v1/billing.
 * Seeded WITH a card for tests (an already-onboarded user); the browser
 * worker boots without one so local dev exercises the onboarding flow. */
interface MockBilling {
  hasPaymentMethod: boolean;
  card?: BillingCard;
  /** succeeded conversions whose automatic charge failed (delinquency) */
  unpaid: UnpaidCharge[];
  /** what the next POST /v1/billing/settle attempt does (tests) */
  settleOutcome: "success" | "requires_action" | "declined";
  /** when true, the NEXT conversion success fails its automatic charge —
   * exercising the delinquency banner/settle flow end-to-end */
  nextChargeFails: boolean;
  /** quotes at/above this get an up-front hold, mirroring the gateway's
   * holdThresholdCents (api/billing.go). Tests lower it to force the hold
   * path on cheap fixtures. */
  holdThresholdCents: number;
  /** the NEXT hold demands 3DS: conversion returns state=created +
   * requires_action; __mock__/complete-3ds flips it to paid */
  nextHoldRequiresAction: boolean;
  /** the NEXT hold is declined: create 402s with card_declined */
  nextHoldFails: boolean;
}

const MOCK_CARD: BillingCard = {
  brand: "visa",
  last4: "4242",
  exp_month: 12,
  exp_year: 2034,
};

interface DB {
  projects: Map<string, Project>;
  conversions: Map<string, Conversion>;
  idem: Map<string, string>; // Idempotency-Key → conversion_id
  /** per-project analyze lifecycle position (one stage per GET poll) */
  analyzeTicks: Map<string, number>;
  /** per-project free-profile lifecycle position (advances per GET poll) */
  profileTicks: Map<string, number>;
  billing: MockBilling;
}

function seed(): DB {
  const project = structuredClone(projectFixture) as unknown as Project;
  // real captures predate project management — the gateway now always sends
  // archived (and pinned when true), so default them here, not in fixtures
  project.archived = false;
  return {
    projects: new Map([[project.project_id, project]]),
    conversions: new Map(),
    idem: new Map(),
    analyzeTicks: new Map(),
    profileTicks: new Map(),
    billing: {
      hasPaymentMethod: true,
      card: { ...MOCK_CARD },
      unpaid: [],
      settleOutcome: "success",
      nextChargeFails: false,
      holdThresholdCents: 500,
      nextHoldRequiresAction: false,
      nextHoldFails: false,
    },
  };
}

export const mockDb = {
  ...seed(),
  reset() {
    const fresh = seed();
    this.projects = fresh.projects;
    this.conversions = fresh.conversions;
    this.idem = fresh.idem;
    this.analyzeTicks = fresh.analyzeTicks;
    this.profileTicks = fresh.profileTicks;
    this.billing = fresh.billing;
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
  /** Fail a succeeded conversion's automatic charge (delinquency setup). */
  failCharge(id: string) {
    const c = this.conversions.get(id);
    if (!c) throw new Error(`no mock conversion ${id}`);
    c.billing = { status: "charge_failed" };
    this.billing.unpaid.push({
      conversion_id: c.conversion_id,
      step: c.step,
      amount_cents: c.quote.amount_cents,
      currency: c.quote.currency,
      needs_action: false,
    });
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
      // passthrough is MUTUALLY EXCLUSIVE with the depth keys: a passthrough
      // entry must be exactly {first, passthrough: true}
      if (
        o.passthrough === true &&
        (o.shot_type !== undefined ||
          o.displacement !== undefined ||
          o.placement !== undefined)
      ) {
        return err(
          400,
          "invalid_request",
          "scene_overrides[].passthrough cannot be combined with shot_type|displacement|placement",
        );
      }
      if (
        o.shot_type === undefined &&
        o.displacement === undefined &&
        o.placement === undefined &&
        o.passthrough !== true
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

/** Analyze lifecycle while running — one stage per detail GET, then the
 * fixture analysis folds in (same shape the gateway's read-through poll
 * produces: progress + stage + eta on BOTH list and detail responses). */
const ANALYZE_STAGES: readonly {
  stage: string;
  progress: number;
  eta: number;
}[] = [
  { stage: "analyze", progress: 0.15, eta: 34 },
  { stage: "proxy", progress: 0.45, eta: 22 },
  { stage: "scene_detect", progress: 0.7, eta: 12 },
  { stage: "thumbnails", progress: 0.9, eta: 4 },
];

/** Coarse wall-clock estimate for a quoted step — mirrors the gateway's
 * "billable duration × per-step throughput" shape, floored at 20 s. */
function etaForStep(step: Step, billableSeconds: number): number {
  const perSecond = { depth_preview: 0.8, stereo_preview: 1.2, production: 3 };
  return Math.max(20, Math.round(billableSeconds * perSecond[step]));
}

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

/** Success side effects, like the real pipeline's: the run's outputs gain
 * the depth artifacts (depth + the browser-playable depth_vis), the saved
 * card is charged automatically (or fails, when a test armed
 * nextChargeFails), and a pro video conversion stamps the project's
 * scene_profile (the adaptive profiler's per-shot parameters) with the
 * CURRENT scenes version. */
function succeed(c: Conversion) {
  c.outputs = [...(c.params.formats ?? []), "depth", "depth_vis"];
  if (mockDb.billing.nextChargeFails) {
    mockDb.billing.nextChargeFails = false;
    mockDb.failCharge(c.conversion_id);
  } else if (!c.billing) {
    c.billing = { status: "charged", charged_cents: c.quote.amount_cents };
  }
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

/** Plausible SHOT_PARAMS-bucket values the mock profiler cycles across the
 * project's scenes (fixture-like shot_type/displacement/placement). */
const PROFILE_BUCKETS: readonly {
  shot_type: ShotType;
  displacement: number;
  placement: [number, number];
}[] = [
  { shot_type: "standard", displacement: 0.01, placement: [-1.0, 0.3] },
  { shot_type: "close_up", displacement: 0.008, placement: [-1.0, 0.1] },
  { shot_type: "dynamic", displacement: 0.009, placement: [-1.0, 0.1] },
  { shot_type: "wide", displacement: 0.012, placement: [-0.7, 0.6] },
];

/** Shots derived from the project's CURRENT scene cuts, tiling
 * [0, num_frames) exactly — what the free profiler "measures". */
function profiledShots(p: Project): ProfileShot[] {
  const bounds = [0, ...(p.scenes?.cuts ?? []), p.probe!.num_frames];
  const shots: ProfileShot[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const b = PROFILE_BUCKETS[i % PROFILE_BUCKETS.length];
    shots.push({
      first_src: bounds[i],
      last_src: bounds[i + 1],
      shot_type: b.shot_type,
      displacement: b.displacement,
      placement: [...b.placement],
    });
  }
  return shots;
}

/** Free-profile lifecycle while running — the FIRST detail GET advances
 * progress, the SECOND completes: profile.state=succeeded and the result
 * folds into project.scene_profile (conversion_id "profile:<jobid>"), like
 * the gateway. */
function tickProfile(p: Project) {
  if (p.profile?.state !== "running") return;
  const tick = mockDb.profileTicks.get(p.project_id) ?? 0;
  const now = new Date().toISOString();
  if (tick < 1) {
    p.profile = { ...p.profile, progress: 0.6, stage: "profiling", updated_at: now };
    mockDb.profileTicks.set(p.project_id, tick + 1);
  } else {
    const version = p.profile.scenes_version;
    p.profile = { state: "succeeded", scenes_version: version, updated_at: now };
    p.scene_profile = {
      conversion_id: `profile:${newId()}`,
      scenes_version: version,
      shots: profiledShots(p),
      updated_at: now,
    };
    mockDb.profileTicks.delete(p.project_id);
  }
}

/** The detail-response shape (GET/PATCH project, POST profile): the project
 * plus its conversions, newest first. */
function projectDetail(p: Project) {
  const conversions = [...mockDb.conversions.values()]
    .filter((c) => c.project_id === p.project_id)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return { ...p, conversions };
}

/** One poll = one lifecycle tick (paid→processing→succeeded). Pro
 * conversions enter at "paid" (billing verified up front) — there is no
 * client payment confirmation step anymore. */
function tick(c: Conversion) {
  if (c.state === "paid") {
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

/** The gateway's GET /v1/billing response shape. */
function billingStatus() {
  const b = mockDb.billing;
  return {
    has_payment_method: b.hasPaymentMethod,
    ...(b.hasPaymentMethod && b.card ? { card: b.card } : {}),
    delinquent: b.unpaid.length > 0,
    unpaid: b.unpaid,
    publishable_key: "pk_test_mock",
  };
}

export const handlers = [
  http.post(`${GATEWAY}/v1/customers`, () => {
    return HttpResponse.json({ customer_id: "cus_mock" });
  }),

  // ------------------------------------------------------------- billing

  // Pay-as-you-go status — also ensures the billing profile, like the
  // gateway (so the BillingProvider's first fetch is the ensure call).
  http.get(`${GATEWAY}/v1/billing`, () => {
    return HttpResponse.json(billingStatus());
  }),

  // SetupIntent material for the onboarding Payment Element.
  http.post(`${GATEWAY}/v1/billing/setup-intent`, () => {
    return HttpResponse.json({
      client_secret: "seti_mock_secret",
      customer_id: "cus_mock",
      publishable_key: "pk_test_mock",
    });
  }),

  /** What the MockSetupPanel calls in place of stripe.confirmSetup — the
   * card is saved and becomes the default on the next status read. */
  http.post(`${GATEWAY}/__mock__/confirm-setup`, () => {
    mockDb.billing.hasPaymentMethod = true;
    mockDb.billing.card = { ...MOCK_CARD };
    return HttpResponse.json({ ok: true });
  }),

  // Retry outstanding charges on the current default card.
  http.post(`${GATEWAY}/v1/billing/settle`, () => {
    const b = mockDb.billing;
    if (b.settleOutcome === "requires_action" && b.unpaid.length > 0) {
      return HttpResponse.json({
        settled: false,
        requires_action: true,
        client_secret: `pi_mock_3ds_${b.unpaid[0].conversion_id}`,
        publishable_key: "pk_test_mock",
      });
    }
    if (b.settleOutcome === "declined" && b.unpaid.length > 0) {
      return HttpResponse.json({
        settled: false,
        publishable_key: "pk_test_mock",
        message:
          "The charge was declined again. Update your card in the billing portal, then retry.",
      });
    }
    for (const u of b.unpaid) {
      const c = mockDb.conversions.get(u.conversion_id);
      if (c) c.billing = { status: "charged", charged_cents: u.amount_cents };
    }
    b.unpaid = [];
    return HttpResponse.json({ settled: true, publishable_key: "pk_test_mock" });
  }),

  /** What completeChargeAction calls in place of confirmCardPayment: the
   * 3DS challenge succeeds. A pending HOLD (conversion parked at created)
   * clears and the run starts; outstanding post-success charges settle. */
  http.post(`${GATEWAY}/__mock__/complete-3ds`, async ({ request }) => {
    const { client_secret } = (await request.json()) as {
      client_secret?: string;
    };
    for (const c of mockDb.conversions.values()) {
      if (
        c.state === "created" &&
        c.billing?.status === "requires_action" &&
        c.billing.client_secret === client_secret
      ) {
        c.state = "paid";
        delete c.billing; // success stamps "charged" like any hold capture
      }
    }
    for (const u of mockDb.billing.unpaid) {
      const c = mockDb.conversions.get(u.conversion_id);
      if (c) c.billing = { status: "charged", charged_cents: u.amount_cents };
    }
    mockDb.billing.unpaid = [];
    mockDb.billing.settleOutcome = "success";
    return HttpResponse.json({ ok: true });
  }),

  // Stripe customer-portal session (the /account "Manage billing" button).
  http.post(`${GATEWAY}/v1/billing/portal`, () => {
    return HttpResponse.json({
      url: "https://billing.stripe.com/p/session/mock",
    });
  }),

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
      analyze: {
        state: "running",
        error: "",
        credit_cents: 0,
        credit_available: false,
        progress: 0.05,
        stage: "analyze",
        eta_seconds: 40,
      },
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
      const tick = mockDb.analyzeTicks.get(p.project_id) ?? 0;
      if (tick < ANALYZE_STAGES.length) {
        // advance one lifecycle stage per poll (deterministic for tests)
        const s = ANALYZE_STAGES[tick];
        p.analyze = {
          ...p.analyze,
          progress: s.progress,
          stage: s.stage,
          eta_seconds: s.eta,
        };
        mockDb.analyzeTicks.set(p.project_id, tick + 1);
      } else {
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
        mockDb.analyzeTicks.delete(p.project_id);
      }
    }
    tickProfile(p);
    return HttpResponse.json(projectDetail(p));
  }),

  /** Free standalone shot profiling (empty JSON body). 409 while one is
   * already running; the job advances/completes on subsequent detail GETs. */
  http.post(`${GATEWAY}/v1/projects/:id/profile`, ({ params }) => {
    const p = mockDb.projects.get(params.id as string);
    if (!p) return err(404, "not_found", "project not found");
    if (!p.probe || !p.scenes) {
      return err(409, "conflict", "analysis has not completed yet");
    }
    if (p.profile?.state === "running") {
      return err(409, "conflict", "a profiling job is already running");
    }
    p.profile = {
      state: "running",
      scenes_version: p.scenes.version,
      progress: 0.1,
      stage: "profiling",
      updated_at: new Date().toISOString(),
    };
    mockDb.profileTicks.set(p.project_id, 0);
    return HttpResponse.json(projectDetail(p));
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
    return HttpResponse.json(projectDetail(p));
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
      // null when empty, mirroring the Go gateway's nil-slice serialization
      // (older deployments still send null) — keeps the client guard honest.
      reuse_stages: reuseStages.length > 0 ? reuseStages : null,
      eta_seconds: etaForStep(
        req.step,
        quote.breakdown?.billable_seconds ?? p.probe!.duration_s,
      ),
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
    // The real gateway's pay-as-you-go billing gate (402s, api/billing.go
    // requireBillable) — enforce it here too so the onboarding/settle flows
    // can't silently regress against the mock.
    if (!mockDb.billing.hasPaymentMethod) {
      return err(402, "no_payment_method", "add a payment method before starting a conversion");
    }
    if (mockDb.billing.unpaid.length > 0) {
      return err(
        402,
        "billing_overdue",
        `the automatic payment for conversion ${mockDb.billing.unpaid[0].conversion_id} failed — settle it before starting new work`,
      );
    }
    const req = body as unknown as StepConversionRequest;
    const { quote, params: resolved } = quoteFor(p, req);
    // Threshold hybrid, mirroring the gateway: expensive runs place an
    // up-front hold (which can be declined or demand 3DS); cheap runs skip
    // it and charge on success.
    const holds = quote.amount_cents >= mockDb.billing.holdThresholdCents;
    if (holds && mockDb.billing.nextHoldFails) {
      mockDb.billing.nextHoldFails = false;
      return err(
        402,
        "card_declined",
        "your card declined the payment hold — update your payment method and retry",
      );
    }
    if (p.analyze.credit_available) p.analyze.credit_available = false;
    const id = newId();
    // Enters at "paid" (billing verified / hold in place), except a hold
    // demanding 3DS, which parks at "created" until __mock__/complete-3ds.
    const needs3ds = holds && mockDb.billing.nextHoldRequiresAction;
    if (needs3ds) mockDb.billing.nextHoldRequiresAction = false;
    const conv: Conversion = {
      conversion_id: id,
      state: needs3ds ? "created" : "paid",
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
      ...(needs3ds
        ? {
            billing: {
              status: "requires_action" as const,
              client_secret: `pi_mock_hold_${id}`,
              publishable_key: "pk_test_mock",
            },
          }
        : {}),
    };
    mockDb.conversions.set(id, conv);
    if (idem) mockDb.idem.set(idem, id);
    return HttpResponse.json(conv);
  }),

  http.get(`${GATEWAY}/v1/conversions/:id`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    tick(c);
    c.updated_at = new Date().toISOString();
    return HttpResponse.json(c);
  }),

  http.delete(`${GATEWAY}/v1/conversions/:id`, ({ params }) => {
    const c = mockDb.conversions.get(params.id as string);
    if (!c) return err(404, "not_found", "conversion not found");
    if (!["succeeded", "failed", "canceled", "expired"].includes(c.state)) {
      c.state = "canceled";
    }
    return HttpResponse.json(c);
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
