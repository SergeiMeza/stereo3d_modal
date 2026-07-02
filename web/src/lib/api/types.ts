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
  | "created" // record + PaymentIntent exist; awaiting payment confirmation
  | "paid" // funds held; awaiting Modal submission
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
 * at least one of the optional keys per entry. */
export interface SceneOverride {
  first: number;
  shot_type?: ShotType;
  displacement?: number; // (0, 0.03]
  placement?: [number, number];
}

export interface AnalyzeInfo {
  state: "running" | "succeeded" | "failed";
  error?: string;
  credit_cents: number;
  credit_available: boolean; // true until the first paid conversion consumes it
}

export interface Project {
  project_id: string;
  name?: string;
  source_bytes: number;
  analyze: AnalyzeInfo;
  probe?: Probe; // present once analyze succeeded
  scenes?: Scenes;
  crop?: string; // "W:H:X:Y" black-bar geometry, if detected
  /** frame-exact 1:1 h264/mp4 proxy of the source (360p short side) —
   * browser-playable regardless of the source codec; frame n of this file
   * IS source frame n, so seek/scrub against it is frame-accurate. */
  preview_url?: string;
  strip_thumbs?: Thumb[]; // ~100 timeline tiles (h=90)
  scene_thumbs?: Thumb[]; // mid-frame keyframe per scene (h=360)
  /** present after the first successful pro video conversion */
  scene_profile?: SceneProfile;
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
  /** minutes × rate, before the depth-resolution factor */
  base_cents?: number;
  depth_res?: number;
  /** clamp((depth_res/980)^2, 0.5, 4.0), applied to the depth share of the
   * base (the whole subtotal on depth_preview, 0.35 of it elsewhere) */
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

export interface PaymentSheet {
  payment_intent_client_secret: string;
  ephemeral_key_secret: string;
  customer_id: string;
  publishable_key: string;
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
  outputs?: string[]; // names only (state=succeeded); URLs via /downloads
  error?: ConversionError;
  payment?: PaymentSheet; // only on create (and idempotent replays while payable)
  created_at: string;
  updated_at: string;
}

export interface StepQuoteResponse {
  step: Step;
  params: Params;
  quote: Quote;
  reuse_stages: string[]; // stages whose cached artifacts discounted the quote
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
  error: string; // machine code: invalid_request | invalid_token | conflict | not_found | payment_error | upstream_error | server_error
  message: string;
  details?: Record<string, unknown>;
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
