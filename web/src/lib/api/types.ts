/**
 * Gateway API contract. These types mirror the gateway's serialization
 * EXACTLY (gateway/internal/api/handlers.go conversionResponse +
 * projects.go projectResponse). Do not add fields the gateway doesn't send;
 * fixtures under web/fixtures/ are real captures and the source of truth.
 *
 * Frame doctrine (web/DESIGN.md): every frame value is an integer index in
 * SOURCE-frame space; ranges are half-open [from, to); fps is carried as a
 * rational string ("24000/1001") and floats are display-only.
 */

export type ConversionState =
  | "created" // legacy hold flow only; pro steps never surface it
  | "paid" // billing verified; awaiting Modal submission
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired";

export type Step = "depth_preview" | "stereo_preview" | "production";

export type Preset = "draft" | "1080p" | "qhd" | "3k" | "4k";

export type Format =
  | "sbs"
  | "half_sbs"
  | "tb"
  | "half_tb"
  | "anaglyph"
  | "mvhevc";

export type Inpaint = "none" | "propainter";

/** Adaptive profiler shot classes (SHOT_PARAMS buckets). */
export type ShotType = "close_up" | "standard" | "dynamic" | "wide";

export interface Probe {
  width: number;
  height: number;
  fps: number; // display convenience only — use fps_rational for math
  fps_rational: string; // e.g. "24000/1001", "24/1"
  duration_s: number;
  num_frames: number;
}

export interface Scenes {
  version: number; // optimistic concurrency token for PATCH .../scenes
  cuts: number[]; // source-frame indices, strictly increasing, each the first frame of a new scene
  edited: boolean; // false = auto-detected, untouched
  updated_at: string;
}

export interface Thumb {
  frame: number; // source-frame index this tile shows
  url: string;
}

/** One profiled shot: half-open [first_src, last_src) in SOURCE-frame
 * space; shots tile the timeline exactly. */
export interface ProfileShot {
  first_src: number;
  last_src: number;
  shot_type: ShotType;
  displacement: number;
  placement: [number, number]; // [near, far], -1.5 <= near < far <= 1.5
}

/** Per-scene adaptive profile computed by the first successful pro video
 * conversion — the Stereo page seeds its per-scene rows from this. */
export interface SceneProfile {
  conversion_id: string;
  /** scenes.version the profile was computed against; a mismatch means the
   * cuts were edited afterwards and the shots may be misaligned. */
  scenes_version: number;
  shots: ProfileShot[];
  updated_at: string;
}

/** Per-scene override sent on stereo_preview/production requests. `first`
 * must be 0 or a CURRENT scenes.cuts value; entries strictly increasing;
 * at least one of the optional keys per entry.
 *
 * `passthrough: true` ships the scene as 2D — both eyes are the untouched
 * source, no warp or inpainting (end credits, logos, title cards). It is
 * MUTUALLY EXCLUSIVE with shot_type/displacement/placement on the same
 * entry (the gateway 400s the combination): a passthrough entry must be
 * exactly `{first, passthrough: true}`. */
export interface SceneOverride {
  first: number;
  shot_type?: ShotType;
  displacement?: number; // (0, 0.03]
  placement?: [number, number];
  passthrough?: boolean;
}

export interface AnalyzeInfo {
  state: "running" | "succeeded" | "failed";
  error?: string;
  credit_cents: number;
  credit_available: boolean; // true until the first paid conversion consumes it
  /** 0..1 — only while state === "running" (list AND detail responses) */
  progress?: number;
  /** current pipeline stage while running:
   * "analyze" | "proxy" | "scene_detect" | "thumbnails" */
  stage?: string;
  /** coarse remaining-time estimate; present only when > 0 */
  eta_seconds?: number;
}

/** Free standalone shot-profiling job (POST /v1/projects/{id}/profile) —
 * the adaptive profiler measures each scene from the preview proxy. On
 * success the gateway folds the result into project.scene_profile (its
 * conversion_id looks like "profile:<jobid>"). */
export interface ProfileJobInfo {
  state: "running" | "succeeded" | "failed";
  /** scenes.version the job profiles/profiled */
  scenes_version: number;
  error?: string;
  /** 0..1 — only while state === "running" */
  progress?: number;
  /** current profiler stage — only while running */
  stage?: string;
  updated_at: string;
}

/** A user-provided depth video registered on the project (POST
 * /v1/projects/{id}/depth-map) — frame-exact against the source (the
 * gateway validated frames == probe.num_frames). Conversions opt in with
 * use_uploaded_depth. */
export interface DepthUpload {
  name?: string;
  frames: number;
  width: number;
  height: number;
  bytes: number;
  created_at: string;
}

export interface Project {
  project_id: string;
  name?: string;
  source_bytes: number;
  analyze: AnalyzeInfo;
  probe?: Probe; // present once analyze succeeded
  scenes?: Scenes;
  /** user-uploaded depth map registered on the project */
  depth_upload?: DepthUpload;
  crop?: string; // "W:H:X:Y" black-bar geometry, if detected
  /** frame-exact 1:1 h264/mp4 proxy of the source (480p short side) —
   * browser-playable regardless of the source codec; frame n of this file
   * IS source frame n, so seek/scrub against it is frame-accurate. */
  preview_url?: string;
  strip_thumbs?: Thumb[]; // ~100 timeline tiles (h=90)
  scene_thumbs?: Thumb[]; // mid-frame keyframe per scene (h=480)
  /** present after the first successful pro video conversion */
  scene_profile?: SceneProfile;
  /** free standalone profiling job state (POST .../profile) */
  profile?: ProfileJobInfo;
  conversions?: Conversion[]; // only on GET /v1/projects/{id}
  /** omitted when false (Go omitempty) */
  pinned?: boolean;
  /** always sent by current gateways; optional here because fixtures are
   * real captures that may predate the field */
  archived?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Params {
  preset: Preset;
  formats: Format[];
  /** legacy mobile-flow knob; pro steps use scene_overrides/depth_scale */
  displacement?: number;
  target_fps?: number;
  from_frame?: number;
  to_frame?: number;
  inpaint?: Inpaint; // absent = pipeline default (propainter)
  depth_res?: number; // multiple of 14 in [140, 2520]
  /** bucket key of the user-uploaded depth map the run used (set when the
   * request carried use_uploaded_depth) */
  depth_source?: string;
  depth_scale?: number; // [0.3, 1.5] — scales every scene's displacement
  scene_overrides?: SceneOverride[];
  scene_cuts?: number[];
  skip_reuse?: boolean;
}

export interface QuoteBreakdown {
  step?: Step;
  preset?: string;
  billable_seconds?: number;
  cents_per_minute?: number;
  /** clamp(effective_fps/24, 0.5, 2.5) — frames are what cost, so the
   * render rate scales the base (previews run at half the source rate) */
  fps_factor?: number;
  /** minutes × rate × fps factor, before the depth-resolution factor */
  base_cents?: number;
  depth_res?: number;
  /** working-megapixel depth factor: clamp(depth_res² × elongation /
   * (980² × 16⁄9), 0.5, 5.0) — equals (depth_res/980)² on a 16:9 source,
   * aspect-aware (post-crop dims) elsewhere; applied to the depth share of
   * the base (the whole subtotal on depth_preview, 0.35 of it elsewhere) */
  depth_res_factor?: number;
  /** 1.6 on stereo_preview + propainter only */
  inpaint_multiplier?: number;
  subtotal_cents?: number;
  reuse_stages?: string[];
  reuse_discount_cents?: number;
  discount_cents?: number;
  analyze_credit_cents?: number;
}

export interface Quote {
  amount_cents: number;
  currency: string;
  breakdown?: QuoteBreakdown & Record<string, unknown>;
  rate_version?: string; // only on POST .../quotes responses
}

export interface ConversionError {
  code: string;
  message: string; // user-safe; always contains the conversion_id for support
}

/** Automatic-billing state of a pro-step conversion.
 * requires_action (state=created, expensive runs only): the up-front hold
 * needs 3DS — complete it with confirmCardPayment(client_secret) and the
 * webhook starts the job. charge_failed (state=succeeded) means the account
 * is delinquent — new paid steps 402 with billing_overdue until
 * POST /v1/billing/settle clears the debt. */
export interface ConversionBilling {
  status: "requires_action" | "charge_pending" | "charged" | "charge_failed";
  charged_cents?: number; // status === "charged"
  client_secret?: string; // status === "requires_action"
  publishable_key?: string; // status === "requires_action"
}

export interface Conversion {
  conversion_id: string;
  state: ConversionState;
  kind: "video" | "image";
  params: Params;
  project_id?: string; // pro pipeline only
  step?: Step;
  scenes_version?: number;
  quote: Quote;
  progress: number; // 0..1
  stage?: string; // current pipeline stage while processing
  eta_seconds?: number;
  /** RFC3339 deadline after which the running job can no longer be
   * canceled (1 minute after GPU submission). Absent while the job hasn't
   * started (always cancelable) and on terminal states. */
  cancelable_until?: string;
  outputs?: string[]; // names only (state=succeeded); URLs via /downloads
  error?: ConversionError;
  /** how the automatic charge went — succeeded pro-step conversions only */
  billing?: ConversionBilling;
  created_at: string;
  updated_at: string;
}

export interface StepQuoteResponse {
  step: Step;
  params: Params;
  quote: Quote;
  /** Stages whose cached artifacts discounted the quote. The gateway sends
   * null (Go nil slice) when nothing is reusable — treat as empty. */
  reuse_stages?: string[] | null;
  /** coarse pre-run wall-clock estimate for the quoted step, in seconds */
  eta_seconds?: number;
}

export interface UploadTicket {
  upload_id: string;
  gcs_key: string;
  upload_url: string; // signed PUT
  headers: Record<string, string>;
  expires_in: number;
}

export interface Downloads {
  downloads: Record<string, string>; // output name → signed GET URL
  expires_in: number;
}

export interface APIErrorBody {
  success: false;
  /** machine code: invalid_request | invalid_token | conflict | not_found |
   * payment_error | upstream_error | server_error, plus the 402 billing
   * gates: no_payment_method (onboarding needed) | billing_overdue (an
   * automatic charge failed — settle before new paid work) | card_declined
   * (the up-front hold on an expensive run was declined), plus
   * cancel_window_closed (409: the job ran past the 1-minute cancel window) */
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------- billing

/** The saved default card, as cached by the gateway. */
export interface BillingCard {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

/** One succeeded conversion whose automatic charge failed. needs_action
 * means the bank wants 3DS — confirmCardPayment(client_secret) completes it
 * with the saved card. */
export interface UnpaidCharge {
  conversion_id: string;
  step?: Step;
  amount_cents: number;
  currency: string;
  needs_action: boolean;
  client_secret?: string;
}

/** GET /v1/billing — the pay-as-you-go gate the app routes on: no
 * has_payment_method → onboarding; delinquent → settle before new paid
 * steps. */
export interface BillingStatus {
  has_payment_method: boolean;
  card?: BillingCard;
  delinquent: boolean;
  unpaid: UnpaidCharge[];
  publishable_key: string;
}

/** POST /v1/billing/setup-intent — material for the onboarding Payment
 * Element (SetupIntent, card saved for off-session charges). */
export interface BillingSetupTicket {
  client_secret: string;
  customer_id: string;
  publishable_key: string;
}

/** POST /v1/billing/settle — retries outstanding charges on the current
 * default card. requires_action carries the 3DS client_secret. */
export interface BillingSettleResult {
  settled: boolean;
  publishable_key: string;
  requires_action?: boolean;
  client_secret?: string;
  message?: string;
}

// ---------------------------------------------------------------- requests

export interface CreateProjectRequest {
  gcs_key: string;
  name?: string;
}

/** PATCH /v1/projects/{id} — any subset; returns the full updated project.
 * archived:true cancels active conversions server-side; archived:false
 * restores an archived project. */
export interface UpdateProjectRequest {
  name?: string; // ≤120 chars after trim
  pinned?: boolean;
  archived?: boolean;
}

export interface UpdateScenesRequest {
  cuts: number[];
  expect_version?: number; // 409 conflict if the server version moved
}

/** Pro-step quote/conversion body. NOTE: top-level `displacement` is NOT a
 * pro-step parameter — the gateway rejects it with a 400; per-scene strength
 * lives in scene_overrides[].displacement and the global multiplier in
 * depth_scale. */
export interface StepConversionRequest {
  step: Step;
  preset?: Preset; // ignored for depth_preview (always draft)
  formats?: Format[]; // stereo_preview + production (depth_preview ignores)
  depth_res?: number; // ALL steps; multiple of 14 in [140, 2520]; absent = preset default
  /** run against the project's uploaded depth map instead of computing
   * depth (stereo_preview + production; mutually exclusive with depth_res;
   * forces the full source rate — the upload is frame-exact) */
  use_uploaded_depth?: boolean;
  depth_scale?: number; // stereo_preview + production only; [0.3, 1.5]
  inpaint?: Inpaint; // stereo_preview (default none) + production (default propainter)
  scene_overrides?: SceneOverride[]; // stereo_preview + production only
  target_fps?: number; // capped at the source frame rate
  from_frame?: number; // half-open [from_frame, to_frame)
  to_frame?: number;
  from_scratch?: boolean; // bypass reuse (and its discount)
  app_version?: string;
  platform?: string;
}
