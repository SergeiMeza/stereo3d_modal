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

/** Classic steps: depth_preview, stereo_preview, production. Lifelike
 * projects run lifelike_preview and production only (the gateway 400s the
 * others for them). */
export type Step =
  | "depth_preview"
  | "stereo_preview"
  | "lifelike_preview"
  | "production";

/** How a project is made 3D, chosen per project and switchable any time
 * (PATCH /v1/projects/{id}). New projects are "lifelike"; projects created
 * before the choice existed have no stored method and read as "classic". */
export type Method = "lifelike" | "classic";

/** The method a project (or a run) uses: gateways before the method
 * existed send nothing, which means classic. */
export function methodOf(x: { method?: Method } | null | undefined): Method {
  return x?.method === "lifelike" ? "lifelike" : "classic";
}

/** The method a run ran with: runs from before the choice existed carry
 * none and were Classic; a Lifelike preview is Lifelike by its step. */
export function conversionMethod(c: {
  method?: Method;
  step?: string;
}): Method {
  return c.step === "lifelike_preview" ? "lifelike" : methodOf(c);
}

/** Who pays when: "before" = charged when the run starts and refunded in
 * full if it fails (quotes above the gateway's threshold); "after" =
 * billed once it succeeds. */
export type ChargeTiming = "before" | "after";

/** 5k/6k/8k are Lifelike only and come from the gateway's `qualities`
 * list (S3D-48) — never offered from a client-side list. */
export type Preset =
  | "draft"
  | "1080p"
  | "qhd"
  | "3k"
  | "4k"
  | "5k"
  | "6k"
  | "8k";

export type Format =
  "sbs" | "half_sbs" | "tb" | "half_tb" | "anaglyph" | "mvhevc";

export type Inpaint = "none" | "migan" | "propainter";
// "migan": per-frame fill of the warp gaps (no temporal model) on the cheap
// GPU tier. No longer offered on the web (S3D-29); old runs read "Fast fill
// (no longer offered)". propainter = "Filled", backward warp = "Stretched".

/** Stereo synthesis method. "forward" = splat with occlusion masks (the
 * only method an inpaint pass can follow); "backward" = gather warp — the
 * mobile app's kernel: no gaps open, so the gateway forces inpaint "none"
 * and rejects an explicit "propainter" with it. */
export type Warp = "forward" | "backward";

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
  /** source-frame indices, strictly increasing, each the first frame of a
   * new scene. Empty ([]) for a single-shot source. Gateways before
   * 2026-09-05 sent null there, so readers still guard with `?? []`. */
  cuts: number[];
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

/** One quality a Lifelike source can have (S3D-04), from the gateway:
 * steps at or below the source's short side, plus "Full resolution (Np)"
 * when the short side falls between steps (priced like the step below). */
export interface QualityOption {
  /** the gateway's id: a preset, or "full" (the source's own size) */
  id?: string;
  /** what the request sends */
  preset: Preset;
  /** the output's short side per eye (the gateway's label source) */
  label_short_side?: number;
  /** "1440p" / "Full resolution (1606p)"; derived from id and
   * label_short_side when the gateway doesn't send it */
  label?: string;
  /** 5K-8K: the service marks these outputs experimental */
  experimental?: boolean;
  /** output size per eye */
  eye_width?: number;
  eye_height?: number;
  /** S3D-65: this size keeps the source picture as one eye — the run must
   * send original_eye (5K, 6K, 8K) */
  original_eye_required?: boolean;
  /** the price step it is charged at, when not its own */
  price_preset?: Preset;
  /** the files this size can be delivered in (6K and 8K: no full
   * side-by-side; asking gets 400 format_unavailable) */
  formats?: Format[];
}

export interface Project {
  /** onboarding: the finished sample every new account gets (never
   * billed; archive and unarchive like any project) */
  sample?: boolean;
  project_id: string;
  name?: string;
  /** list items only (S3D-35) */
  summary?: ProjectSummary;
  /** Lifelike qualities for this source; absent on older gateways (the
   * web then derives them from the probe) */
  qualities?: QualityOption[];
  /** always sent by current gateways; absent = classic (methodOf) */
  method?: Method;
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
  /** S3D-24: when unused files will be deleted (ISO); absent = not
   * scheduled. Keep (POST /v1/projects/{id}/keep) pushes it back. */
  files_delete_at?: string;
  /** S3D-24: when the files were erased (ISO). The project and its runs
   * stay; every file route answers 410 files_deleted. */
  files_deleted_at?: string;
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
  /** the gateway lowered the rate to 30 or under (no Business or Studio
   * plan); target_fps is the rate it converts at */
  fps_capped?: boolean;
  from_frame?: number;
  to_frame?: number;
  inpaint?: Inpaint; // absent = pipeline default (propainter)
  warp?: Warp; // absent = pipeline default (forward)
  depth_res?: number; // multiple of 14 in [140, 2520]
  /** bucket key of the user-uploaded depth map the run used (set when the
   * request carried use_uploaded_depth) */
  depth_source?: string;
  depth_scale?: number; // [0.3, 1.5] — scales every scene's displacement
  scene_overrides?: SceneOverride[];
  scene_cuts?: number[];
  skip_reuse?: boolean;
  /** production: output files of at most this many seconds each */
  split_max_seconds?: number;
  /** Lifelike (S3D-49): keep the source picture as this eye; off = absent */
  original_eye?: "left" | "right";
  /** Lifelike (S3D-50): Foveated Detail, only below the video's own size
   * and when the gateway reports it enabled */
  foveation?: "static" | null;
  /** pricing 2026-11: Express run (first in line) */
  express?: boolean;
  /** depth_preview only: the pipeline stops after the depth stage (no
   * stereo warp, no encodes) — outputs are depth + depth_vis */
  depth_only?: boolean;
}

export interface QuoteBreakdown {
  /** Lifelike Foveated Detail (S3D-50): its factor (1.3) and what it adds */
  foveation_factor?: number;
  foveation_cents?: number;
  step?: Step;
  preset?: string;
  billable_seconds?: number;
  /** owner 2026-11-04: the run's video rounded UP to whole minutes, what
   * the per-minute price multiplies (ceil on the run's total) */
  billable_minutes?: number;
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
  /** S3D-67: the Pro share applied (0.15) and what it took off */
  pro_discount_pct?: number;
  pro_discount_cents?: number;
  /** pricing 2026-11: the list price before add-ons and discounts */
  list_base_cents?: number;
  /** pricing 2026-11: what each add-on adds (cents) */
  addons?: Partial<Record<AddOn, number>>;
  /** pricing 2026-11: a free preview (amount 0) */
  free_preview?: boolean;
}

/** Pricing 2026-11 add-ons: Foveated Detail, Master bitrate, Express. */
export type AddOn = "foveated" | "master" | "express";

/** Pricing 2026-11 tiers; "" = list price. */
export type Tier = "" | "pro" | "business" | "studio";

/** The quote's one discount line: the tier's price or bulk, never both. */
export interface QuoteDiscount {
  kind: "tier" | "bulk";
  tier?: Tier;
  cents: number;
  pct: number;
}

/** Free previews on a quote (Lifelike previews only). */
export interface FreePreviews {
  allowance: number;
  used: number;
  remaining: number;
  daily_left: number;
  /** what this preview counts as (5K+ or 60 fps count double) */
  units: number;
  /** this preview would be free */
  free: boolean;
  /** a non-subscriber's one free preview on their first project */
  intro: boolean;
  /** 00083: what the allowance is for */
  period?: "week" | "month" | "year" | "pass" | "first_project";
  resets_at?: string;
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
 * POST /v1/billing/settle clears the debt.
 *
 * Pre-charged runs (charge_timing "before") stay state=created until the
 * card payment is confirmed (3DS included) and then read charged; a failed
 * one moves to refund_pending → refunded, or not_charged when the payment
 * never went through. */
export interface ConversionBilling {
  status:
    | "requires_action"
    | "charge_pending"
    | "batched"
    | "charged"
    | "charge_failed"
    | "refund_pending"
    | "refunded"
    | "not_charged"
    | "requires_payment"
    /** spec v6 F: paid elsewhere, waiting for the processor to confirm */
    | "waiting_for_payment"
    /** spec v7 N5: funds held on the prepaid balance; settled at the end */
    | "balance_hold"
    /** spec v7 N5: settled from the balance (charged_cents = what it took) */
    | "balance_settled"
    /** spec v7 N5: the hold went back, nothing taken */
    | "balance_released"
    /** pricing 2026-11: a free preview, nothing charged */
    | "free_preview"
    /** 00081: waiting for a payment */
    | "waiting_for_payment";
  /** spec v6 F: why a web run waits for a payment (requires_payment) */
  reason?: "no_method" | "authentication" | "declined";
  /** spec v6 F: the run's open payment, for our pay sheet */
  checkout?: CheckoutHandle;
  /** spec v6 F: China mode's server payment */
  next_action?: { type: "redirect" | "qr"; redirect_url?: string; qr_image_url?: string };
  /** the declined method, for P3's line ("Visa •••• 4242") */
  declined_method_label?: string;
  charged_cents?: number; // status === "charged"
  batch_id?: string; // status === "batched": on the account's pending balance
  client_secret?: string; // status === "requires_action" | "requires_payment"
  publishable_key?: string; // status === "requires_action" | "requires_payment"
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
  /** the run is well past its estimate (gateway-judged); the tracker
   * offers "Report it" */
  overdue?: boolean;
  /** RFC3339 time of the user's latest report on this run */
  reported_at?: string;
  outputs?: string[]; // names only (state=succeeded); URLs via /downloads
  error?: ConversionError;
  /** the method the run ran with; absent on runs before the choice existed */
  method?: Method;
  /** the job is queued for a free GPU — the wait is not progress */
  waiting_for_gpu?: boolean;
  /** seconds the job has spent waiting for a GPU so far */
  queued_s?: number;
  /** 00081: "express" or "standard" (Lifelike) */
  priority?: "express" | "standard";
  max_gpu_workers?: number;
  /** 00081: an Express run waiting for a GPU starts within this */
  queue_wait_max_seconds?: number;
  /** split runs: one entry per output part, in order */
  parts?: ConversionPart[];
  charge_timing?: ChargeTiming;
  /** how the automatic charge went — succeeded pro-step conversions only */
  billing?: ConversionBilling;
  created_at: string;
  updated_at: string;
}

/** One part of a split output (Modal metadata.parts). */
export interface ConversionPart {
  index: number; // 1-based
  start_s: number;
  duration_s: number;
}

export interface StepQuoteResponse {
  /** S3D-56: the files' estimated total size, when the gateway knows */
  estimated_size_bytes?: number;
  step: Step;
  params: Params;
  quote: Quote;
  /** Stages whose cached artifacts discounted the quote. The gateway sends
   * null (Go nil slice) when nothing is reusable — treat as empty. */
  reuse_stages?: string[] | null;
  /** coarse pre-run wall-clock estimate for the quoted step, in seconds */
  eta_seconds?: number;
  method?: Method;
  /** "before": paid when the run starts, refunded in full if it fails */
  charge_timing?: ChargeTiming;
  /** length of the output the quoted run would produce */
  output_seconds?: number;
  /** the output runs past 15 minutes: offer to split it into parts */
  split_suggested?: boolean;
  /** spec v6 F: how this run would be paid */
  payment_flow?: PaymentFlow;
  pay_now_reason?: "no_method" | "all_methods_failed" | "china" | "account_flag";
  limits?: AccountLimits;
  /** spec v7 N5: the balance against this quote */
  balance?: { available_cents: number; enough: boolean; reload_cents?: number };
  /** spec v7 N6: this run would pass the monthly spend limit */
  spend_limit_reached?: boolean;
  /** S3D-67: the caller holds Pro; false = not Pro, absent = the gateway
   * doesn't say */
  pro?: boolean;
  /** S3D-67: the Pro line, when this step gets it (full runs only): pct is
   * a share (0.2), cents what it takes off */
  pro_discount?: { pct: number; cents: number };
  /** pricing 2026-11: the account's tier ("" = list) and its name */
  tier?: Tier;
  tier_label?: string;
  discount?: QuoteDiscount | null;
  free_previews?: FreePreviews;
  /** gateway 00094: this Lifelike run's price on each plan, in cents, with
   * the tier's rounding and without free previews applied (Classic quotes
   * have none) */
  alt_prices?: Partial<Record<"pro" | "business" | "studio", number>>;
  /** Lifelike full runs: Express's estimate beside the standard one; an
   * Express run may still wait up to max_wait_seconds to start */
  express_eta?: { eta_seconds: number; standard_eta_seconds: number; max_wait_seconds: number };
  /** owner 2026-11-04 (gateway fps_cap.go fpsInfo): this account's
   * highest output rate, the rates it may send for this video, and the
   * rate the run converts at; fps_capped (with reason) when no target was
   * sent and the source is above max_fps */
  fps?: QuoteFps;
}

export interface QuoteFps {
  max_fps: number;
  source_fps: number;
  target_fps_choices: number[];
  fps_capped: boolean;
  reason?: "plan_required_above_30fps";
  target_fps: number;
}

export interface UploadTicket {
  upload_id: string;
  gcs_key: string;
  /** signed PUT, or the resumable session URL when resumable is true */
  upload_url: string;
  /** chunked upload with Content-Range (asked for in China mode) */
  resumable?: boolean;
  headers: Record<string, string>;
  expires_in: number;
}

export interface Downloads {
  /** output name → signed GET URL; split runs add one key per part
   * ("mvhevc_part02") */
  downloads: Record<string, string>;
  expires_in: number;
  /** every output with its part (split runs: one entry per part) */
  files?: DownloadFile[];
}

export interface DownloadFile {
  name: string; // the downloads key, e.g. "mvhevc_part02"
  format: string; // "mvhevc"
  part?: number; // 1-based, split runs only
  /** S3D-31: the saved name, "<original>_<resolution>_<layout>.<ext>",
   * split runs "<original>_<resolution>_partN_<layout>.<ext>" —
   * also the signed URL's Content-Disposition, so links never rename it */
  filename?: string;
  url: string;
  /** stored object size; absent when storage didn't answer */
  size_bytes?: number;
}

/** A project card's outcome line (S3D-35), on GET /v1/projects items. */
export interface ProjectSummary {
  latest_state?: ConversionState;
  latest_step?: Step;
  /** money taken or owed for delivered work */
  spent_cents: number;
  /** optional extras the cards use when the gateway sends them */
  latest_progress?: number;
  latest_eta_seconds?: number;
  latest_waiting_for_gpu?: boolean;
  latest_billing_status?: ConversionBilling["status"];
}

/** GET /v1/billing balance (S3D-21): always present on current gateways. */
export interface BillingBalance {
  amount_cents: number;
  currency: string;
  /** RFC3339 latest charge time; null with nothing open */
  due_at: string | null;
  cap_cents: number;
}

/** GET /v1/pricing (public, S3D-18). Prices per minute of output at 24
 * fps; the frame rate scales them by fps/24 within [min, max] factor. */
export interface PublicPricing {
  rate_version?: string;
  currency: string;
  methods: {
    lifelike?: {
      presets: Preset[];
      production_cents_per_minute: Partial<Record<Preset, number>>;
      /** flat preview price on gateways before per-frame previews */
      preview_cents?: number;
      max_source_duration_s: number;
      max_source_bytes?: number;
    };
    classic?: {
      presets: Preset[];
      production_cents_per_minute: Partial<Record<Preset, number>>;
      stereo_preview_cents_per_minute?: Partial<Record<Preset, number>>;
      depth_preview_cents_per_minute?: number;
      max_source_duration_s: number;
      max_source_bytes?: number;
    };
  };
  fps: {
    base: number;
    min_factor: number;
    max_factor: number;
    /** owner 2026-11-04: 30 without a plan, 120 with Business or Studio */
    max_fps_without_plan?: number;
    max_fps_with_plan?: number;
  };
  discount: { threshold_cents: number; pct: number; stacks_with_tier?: boolean; rule?: string };
  minimum_cents: number;
  /** every preview's floor (S3D-13/17); minimum_cents when absent */
  preview_minimum_cents?: number;
  precharge_threshold_cents: number;
  /** older gateways only (absent on 00091) */
  balance?: { window_hours: number; new_account_cap_cents: number };
  /** S3D-67: Pro's share off (0.15; 0 = off) and the step it applies to */
  pro_discount?: ProDiscount;
  /** owner 2026-11-04: false = Classic 3D takes no new projects (a create
   * with method classic gets 422 classic_retired); existing Classic
   * projects keep their results and can convert with Lifelike 3D */
  classic_new_projects?: boolean;
  /** pricing 2026-11 */
  pricing_model?: "tiers";
  tiers?: {
    order: string[];
    lifelike_cents_per_minute: Partial<Record<"list" | "pro" | "business" | "studio", Partial<Record<Preset, number>>>>;
    classic_pct: Partial<Record<"pro" | "business" | "studio", number>>;
  };
  addons?: Partial<
    Record<AddOn, { pct: number; enabled?: boolean; methods?: string[]; request?: Record<string, unknown>; included_in?: string[] }>
  >;
  plans?: Partial<Record<"business" | "studio", PlanDef>>;
  free_previews?: {
    enabled?: boolean;
    allowances: Record<string, number>;
    periods: Record<string, string>;
    unit_seconds: number;
    counts_double?: string[];
    daily_cap: number;
    rollover: boolean;
  };
}

/** GET /v1/pricing plans.business / plans.studio */
export interface PlanDef {
  name: string;
  monthly_cents: number;
  credit_cents: number;
  max_active_runs: number;
  /** sent by the gateway; never shown until team accounts exist (owner
   * 2026-11-04) */
  seats?: number;
  free_previews_per_period: number;
  express_included: boolean;
  /** owner 2026-11-04: the plan's highest output frame rate (120) */
  max_fps?: number;
  /** how the plan bills ("year" for Studio; absent/"month" otherwise) and
   * what each bill is; the credit and free previews still come every
   * credit_interval ("month") */
  interval?: "month" | "year" | "";
  price_cents?: number;
  credit_interval?: string;
}

/** POST /v1/account/delete: done, or (00081) pending while a cash
 * balance is refunded */
export interface AccountDeleteResult {
  deleted: boolean;
  deletion_pending?: boolean;
  case_id?: string;
  refund_cents?: number;
  message?: string;
}

/** GET/PATCH /v1/account/settings (BL-25, gateway 00087) */
export interface AccountSettings {
  /** the Spatial Video Studio intro before the account's videos */
  lifelike_intro: boolean;
  /** true only with an active Business or Studio plan */
  lifelike_intro_editable: boolean;
  locale: string | null;
  /** onboarding (owner 2026-11-04): where they watch, from the welcome's
   * first question; preselects "Where will you watch it?" on Make 3D.
   * Make 3D's device ids (avp, quest, galaxyxr, pico, steamframe, glasses,
   * tv, unsure); gateway 00092 stores any slug, at most 12 */
  headsets?: string[] | null;
  /** first-time hints already dismissed (one id per page or tab) */
  hints_seen?: string[];
  onboarding?: OnboardingState;
  /** plans surfaces dismissed: placement → RFC 3339 time (gateway 00093) */
  dismissed?: Record<string, string>;
  /** test environments only: the gateway treats the account as an app Pro
   * subscriber (onboarding variant app_pro, GET /v1/pro true) */
  simulate_app_pro?: boolean;
}

/** Account onboarding state, kept on the account (not in the browser). */
export interface OnboardingState {
  welcome_done?: boolean;
  /** owner 2026-11-04: "app_pro" for people whose Pro comes from the iPhone,
   * iPad, Mac or Vision Pro app; they get their own welcome once */
  variant?: "app_pro" | "default";
  app_pro_welcome_done?: boolean;
  /** where they watch, as the app knows it (00096: only ["avp"], or empty) */
  headsets_from_app?: string[] | null;
  headsets_from_app_source?: "app_answer" | "app_device" | null;
  app_viewing_device?: "apple_vision_pro" | "other_headset" | "screen_only" | null;
  checklist_hidden?: boolean;
  tips_done?: boolean;
  /** the gateway's view of the getting-started steps (read-only) */
  steps?: {
    first_video?: boolean;
    first_preview?: boolean;
    first_3d?: boolean;
    watched?: boolean;
  };
}

/** PATCH /v1/account/settings */
export interface AccountSettingsPatch {
  lifelike_intro?: boolean;
  locale?: string | null;
  headsets?: string[];
  /** ids to add to hints_seen */
  hints_seen_add?: string[];
  onboarding?: Pick<OnboardingState, "welcome_done" | "checklist_hidden" | "tips_done" | "app_pro_welcome_done">;
  /** test environments only */
  simulate_app_pro?: boolean;
  /** placement → true (now) | RFC 3339 time | null (clear) */
  dismissed?: Record<string, true | string | null>;
}

/** GET /v1/billing plan (Business / Studio) */
export interface AccountPlan {
  plan: "business" | "studio";
  name?: string;
  status: string;
  active: boolean;
  monthly_cents?: number;
  credit_cents?: number;
  credit_left_cents?: number;
  current_period_end?: string;
  cancel_at_period_end: boolean;
  /** Studio yearly (gateway 00089): billing interval and price, the
   * credit's interval, which month of the year this is (1–12) and when
   * this month's usage resets */
  interval?: "month" | "year" | "";
  price_cents?: number;
  credit_interval?: string;
  month_index?: number;
  credit_resets_at?: string;
}

export interface ProDiscount {
  pct: number;
  applies_to: string;
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

/** GET /v1/limits — only the parts the web reads. */
export interface MethodLimits {
  /** 0 = unlimited */
  max_source_duration_s: number;
  /** false: the method can't be chosen right now (method_unavailable) */
  available?: boolean;
  /** Lifelike: Foveated Detail (static foveation) can be ordered */
  foveation?: boolean;
}

export interface GatewayLimits {
  limits?: {
    /** the global (Classic) source cap, from before per-method caps */
    max_duration_s?: number;
    max_source_bytes?: number;
  };
  /** per-method source caps; absent on gateways before Lifelike */
  methods?: Partial<Record<Method, MethodLimits>>;
  /** the method new projects get */
  default_method?: Method;
  rates?: {
    /** quotes above this are paid when the run starts */
    precharge_threshold_cents?: number;
  };
}

/** Whether the chooser and header switch show for a project: hidden only
 * when the gateway says Lifelike can't be chosen and the project is
 * Classic (nothing to switch to). Unknown limits show them. */
export function canChooseMethod(
  limits: GatewayLimits | null,
  project: { method?: Method },
): boolean {
  if (limits === null) return true;
  return methodAvailable(limits, "lifelike") || methodOf(project) === "lifelike";
}

/** Whether a method can be chosen now (gateways before Lifelike know only
 * Classic). */
export function methodAvailable(
  limits: GatewayLimits | null,
  method: Method,
): boolean {
  if (method === "classic") return limits?.methods?.classic?.available !== false;
  return (
    limits?.methods?.lifelike !== undefined &&
    limits.methods.lifelike.available !== false
  );
}

/** The method a new project gets: always Lifelike 3D, sent explicitly
 * (S3D-01; Classic 3D is retired for new projects since 2026-11-04,
 * GET /v1/pricing classic_new_projects false). */
export function newProjectMethod(_limits?: GatewayLimits | null): Method {
  void _limits;
  return "lifelike";
}

// ---------------------------------------------------------------- billing

/** GET /v1/billing/methods (S3D-59/60/61): saved payment methods, up to
 * `max`. Cards and wallets are charged after the fact; pay-now methods
 * (Alipay, WeChat Pay) pay each run when it starts. */
export type PaymentMethodType =
  | "card"
  | "apple_pay"
  | "google_pay"
  | "link"
  | "paypal"
  | "cashapp"
  | "klarna"
  | "alipay"
  | "wechat_pay";

export interface SavedMethod {
  id: string;
  type: PaymentMethodType;
  /** card-backed methods */
  brand?: string;
  last4?: string;
  exp_month?: number;
  exp_year?: number;
  /** PayPal, Link, Cash App */
  email?: string;
  /** spec v6 F: a card saved through a wallet */
  wallet?: "apple_pay" | "google_pay" | "link";
  added_at?: string;
  /** spec v6.2: false while it's the last method and something is owed
   * or pending (C5) */
  removable?: boolean;
  remove_blocked_reason?: string;
  is_default: boolean;
  /** paid when each run starts (Alipay, WeChat Pay) */
  pay_now?: boolean;
}

export interface BillingMethods {
  /** in backup order, the default first (spec v6.2) */
  methods: SavedMethod[];
  /** most an account may keep (5) */
  max?: number;
}

/** spec v6.2 P16: GET/PUT /v1/billing/company */
export interface CompanyDetails {
  name?: string;
  address?: CompanyAddress;
  tax_ids: TaxId[];
}

export interface CompanyAddress {
  country: string;
  line1?: string;
  line2?: string;
  city?: string;
  postal_code?: string;
  state?: string;
}

export interface TaxId {
  id: string;
  /** Stripe's type, e.g. "gb_vat", "eu_vat", "us_ein" */
  type: string;
  value: string;
  verification?: "verified" | "pending" | "unverified" | "unavailable";
}

/** spec v6.2 P10 Invoices tab: GET /v1/billing/invoices */
export interface InvoiceList {
  invoices: InvoiceRow[];
  has_more?: boolean;
}

export interface InvoiceRow {
  invoice_id: string;
  number: string;
  created_at: string;
  amount_cents: number;
  currency: string;
  pdf_url?: string;
  hosted_url?: string;
  credit_notes?: { id: string; number: string; created_at: string; amount_cents: number; pdf_url?: string }[];
}

/** A pay-now run's payment (S3D-60/61). */
/** spec v6 F: an open payment our sheet completes (Checkout Elements). */
export interface CheckoutHandle {
  client_secret: string;
  expires_at: string;
}

/** POST /v1/conversions/{id}/pay-now {ui: "elements"} and POST
 * /v1/billing/settle {ui: "elements"}: the current payment (opened or
 * reused) and what it is for. */
export interface CheckoutStart {
  checkout: CheckoutHandle;
  amount_cents: number;
  publishable_key?: string;
  /** settle: "open" | "processing" | "paid" */
  payment_state?: string;
  /** settle: how many runs it covers */
  runs?: number;
}

/** spec v6 C1: how a run is paid, from the account's state. */
export type PaymentFlow = "after" | "precharge" | "paynow" | "balance" | "free_preview";

/** spec v7 N13: the prepaid balance on GET /v1/billing */
export interface BalanceSummary {
  balance_cents: number;
  held_cents: number;
  frozen_cents: number;
  available_cents: number;
  /** runs holding funds right now */
  held_runs?: number;
  expires_at?: string | null;
  expired?: boolean;
  /** never topped up */
  never_topped_up?: boolean;
  auto_reload: {
    enabled: boolean;
    below_cents: number;
    add_cents: number;
    paused_reason?: "declined" | "stop_code" | "efw" | "dispute" | "review" | "sheet_only" | "limit";
  };
  spend_limit_cents?: number | null;
  month_spent_cents: number;
  low_balance_cents: number;
}

/** spec v7 N13: PUT /v1/billing/balance/settings */
export interface BalanceSettings {
  auto_reload?: { enabled: boolean; below_cents: number; add_cents: number };
  spend_limit_cents?: number | null;
  low_balance_cents?: number;
}

/** spec v7 N13: GET /v1/billing/usage */
export interface UsageRow {
  at: string;
  project: string;
  project_id?: string;
  conversion_id: string;
  method: "lifelike" | "classic";
  preset: Preset;
  minutes: number;
  cost_cents: number | null;
  paid_with: string;
  key_name?: string;
  status: "done" | "running" | "released" | "partly_delivered" | "returned";
  reserved_cents?: number;
  returned_cents?: number;
}

export interface UsagePage {
  rows: UsageRow[];
  has_more?: boolean;
}

/** spec v7 N1: the ledger, for "Balance history" */
export interface BalanceEntry {
  id: string;
  kind: "topup" | "auto_reload" | "refund_to_balance" | "debt_payment" | "cash_refund" | "expiry" | "adjustment" | "dispute_freeze" | "dispute_unfreeze" | "dispute_loss";
  cents: number;
  at: string;
  /** "Visa •••• 4242", "CASE-0062" */
  detail?: string;
}
export type FlowState = "credit" | "saved" | "sheet" | "under_review";

/** spec v6 B14: what an account that hasn't saved or paid may still add */
export interface AccountLimits {
  projects_left: number;
  bytes_left: number;
  reached?: boolean;
}

/** spec v6 F: POST /v1/conversions/{id}/handoff (P7) */
export interface HandoffStart {
  code: string;
  url: string;
  qr_image_url?: string;
  expires_at: string;
  /** after {email: true} */
  email_masked?: string;
}

/** spec v6 F: GET /v1/handoff/{code} (public, read-only, P8) */
export interface HandoffInfo {
  /** "3D video · 4K" */
  label: string;
  amount_cents: number;
  currency: string;
  email_masked?: string;
  china: boolean;
  expires_at: string;
  state: "open" | "paying" | "paid" | "expired";
}

export interface PayNowStart {
  method: "alipay" | "wechat_pay";
  /** Alipay: where to send the browser */
  redirect_url?: string;
  /** WeChat Pay: the QR code to scan */
  qr_image_url?: string;
  expires_at?: string;
}

/** GET /v1/billing/history (S3D-57): card charges as on the statement,
 * newest first. One charge may cover several small runs. */
export interface BillingHistory {
  /** older gateways: card charges */
  charges?: BillingCharge[];
  /** spec v6 F: one row per statement charge (group, run or settle), plus
   * one "Payment needed" row while outstanding; refunds are their own rows */
  rows?: BillingRow[];
  has_more?: boolean;
  /** C7: "inclusive" adds "Prices include VAT where it applies." */
  tax?: "off" | "inclusive";
}

export type BillingRowStatus =
  | "paid"
  | "processing"
  | "payment_needed"
  | "refund_requested"
  | "refunded"
  | "partially_refunded"
  | "disputed"
  | "refund_failed";

/** spec v6 F/P10: a purchase-history row. A refund row has a negative
 * meaning (kind "refund") and may carry a credit note. */
export interface BillingRow {
  row_id: string;
  kind?: "charge" | "refund" | "outstanding";
  created_at: string;
  amount_cents: number;
  currency: string;
  status: BillingRowStatus;
  /** "Visa •••• 4242", "PayPal · j•••@gmail.com" */
  payment_method?: { label: string };
  invoice?: { hosted_invoice_url?: string; invoice_pdf?: string };
  receipt_url?: string;
  credit_note_url?: string;
  /** quoted in "Get help with this payment" */
  help_ref?: string;
  case_id?: string;
  items: BillingChargeItem[];
}

export interface BillingCharge {
  charge_id: string;
  created_at: string;
  amount_cents: number;
  currency: string;
  card?: { brand: string; last4: string };
  status: "paid" | "refunded" | "failed";
  /** the hosted receipt */
  receipt_url?: string;
  /** the hosted invoice (its PDF is in the customer portal) */
  hosted_invoice_url?: string;
  items: BillingChargeItem[];
}

export interface BillingChargeItem {
  conversion_id: string;
  project_id: string;
  project_name?: string;
  step: Step;
  preset?: Preset;
  from_frame?: number;
  to_frame?: number;
  amount_cents: number;
}

/** The saved default card, as cached by the gateway. */
export interface BillingCard {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

/** One line of a billing batch (a succeeded step waiting to be charged
 * with the account's other steps). */
export interface BatchItem {
  conversion_id: string;
  project_id?: string;
  step?: Step;
  kind: "video" | "image";
  description: string;
  amount_cents: number;
  added_at: string;
}

/** One outstanding automatic charge that failed: either a whole batch
 * (batch_id + items) or, for charges that predate batching, a single
 * conversion (conversion_id). needs_action means the bank wants 3DS —
 * confirmCardPayment(client_secret) completes it with the saved card. */
export interface UnpaidCharge {
  conversion_id?: string;
  batch_id?: string;
  items?: BatchItem[];
  step?: Step;
  amount_cents: number;
  currency: string;
  needs_action: boolean;
  client_secret?: string;
}

/** The account's open billing batch: succeeded steps accumulate here and
 * are charged as ONE payment when the window closes (due_at), the total
 * reaches cap_cents, or the user pays now. */
export interface PendingBatch {
  batch_id: string;
  amount_cents: number;
  currency: string;
  cap_cents: number;
  opened_at: string;
  due_at: string;
  items: BatchItem[];
}

/** The account's batch tier: how much accumulates before an automatic
 * charge, grown by lifetime collected spend. hold_threshold_cents is the
 * quote at/above which a run is held up front instead of batched. */
export interface BillingTier {
  cap_cents: number;
  window_hours: number;
  lifetime_paid_cents: number;
  hold_threshold_cents: number;
  next_tier?: { min_paid_cents: number; cap_cents: number };
}

/** GET /v1/billing — the pay-as-you-go gate the app routes on: no
 * has_payment_method → onboarding; delinquent → settle before new paid
 * steps. */
export interface BillingStatus {
  has_payment_method: boolean;
  card?: BillingCard;
  delinquent: boolean;
  unpaid: UnpaidCharge[];
  /** the open batch, when any step is waiting to be charged */
  pending?: PendingBatch;
  tier?: BillingTier;
  publishable_key: string;
  /** spec v6 F/C10: what the account owes (sum, no cap); settling = a
   * payment for it is in progress */
  outstanding?: { amount_cents: number; runs: number; settling?: boolean };
  default_method?: { type: string; label: string };
  /** spec v6 C1: credit | saved | sheet | under_review */
  flow_state?: FlowState;
  limits?: AccountLimits;
  /** spec v7: the prepaid balance (web only). Older gateways sent the
   * open batch here ({amount_cents, due_at, cap_cents}); prepaidOf()
   * tells them apart. */
  balance?: BalanceSummary;
  /** pricing 2026-11: Business or Studio (absent without one) */
  plan?: AccountPlan | null;
}

/** The prepaid balance, or null (none, or an older gateway's batch). */
export function prepaidOf(status: { balance?: unknown } | null | undefined): BalanceSummary | null {
  const b = status?.balance as Partial<BalanceSummary> | undefined;
  return b && typeof b.available_cents === "number" ? (b as BalanceSummary) : null;
}

/** POST /v1/billing/setup-intent — material for the onboarding Payment
 * Element (SetupIntent, card saved for off-session charges). */
export interface BillingSetupTicket {
  client_secret: string;
  customer_id: string;
  publishable_key: string;
  /** the payment-method configuration the Payment Element shows (S3D-60) */
  payment_method_configuration?: string;
}

/** POST /v1/billing/settle — retries outstanding charges on the current
 * default card. requires_action carries the 3DS client_secret. The same
 * shape comes back from POST /v1/billing/pay-now (charge the open batch
 * now). */
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
  /** default "lifelike" */
  method?: Method;
}

/** PATCH /v1/projects/{id} — any subset; returns the full updated project.
 * archived:true cancels active conversions server-side; archived:false
 * restores an archived project. */
export interface UpdateProjectRequest {
  name?: string; // ≤120 chars after trim
  pinned?: boolean;
  archived?: boolean;
  /** switching to classic on a source past Classic's length cap → 400
   * source_too_long_for_method */
  method?: Method;
}

export interface UpdateScenesRequest {
  cuts: number[];
  expect_version?: number; // 409 conflict if the server version moved
}

/** Pro-step quote/conversion body. NOTE: top-level `displacement` is NOT a
 * pro-step parameter — the gateway rejects it with a 400; per-scene strength
 * lives in scene_overrides[].displacement and the global multiplier in
 * depth_scale. */
/** Output bitrate (S3D-56), the iPhone/Mac app's choices. */
export type Bitrate = "auto" | "match_source" | 20 | 40 | 60 | 100 | "master";

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
  warp?: Warp; // stereo_preview + production; "backward" forces inpaint none
  scene_overrides?: SceneOverride[]; // stereo_preview + production only
  target_fps?: number; // capped at the source frame rate
  from_frame?: number; // half-open [from_frame, to_frame)
  to_frame?: number;
  from_scratch?: boolean; // bypass reuse (and its discount)
  /** production: split the output into files of at most this many
   * seconds (60–3600); the web sends 900 when the user keeps "Split into
   * parts" */
  split_max_seconds?: number;
  /** S3D-56: output bitrate; absent = Automatic; "master" is the Master
   * bitrate add-on (+20%) */
  bitrate?: Bitrate;
  /** pricing 2026-11: Express (+50%, included in Business and Studio) */
  express?: boolean;
  /** Lifelike (S3D-49): keep the source picture as this eye */
  original_eye?: "left" | "right";
  /** Lifelike (S3D-50): Foveated Detail — "static" on, null off (sent
   * whenever the option is shown), absent when not offered */
  foveation?: "static" | null;
  /** quotes only: price the step under this method without changing the
   * project (S3D-14); conversions refuse a mismatch */
  method?: Method;
  app_version?: string;
  platform?: string;
}
