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
  /** what the request sends */
  preset: Preset;
  /** "1440p" / "Full resolution (1606p)" */
  label: string;
  /** output size per eye */
  eye_width?: number;
  eye_height?: number;
  /** S3D-65: this size keeps the source picture as one eye — the run must
   * send original_eye (5K, 6K, 8K) */
  original_eye_required?: boolean;
  /** the price step it is charged at, when not its own */
  price_preset?: Preset;
}

export interface Project {
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
    | "requires_payment";
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
  filename?: string; // "<name> 3D Part 2.mov"
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
  fps: { base: number; min_factor: number; max_factor: number };
  discount: { threshold_cents: number; pct: number };
  minimum_cents: number;
  /** every preview's floor (S3D-13/17); minimum_cents when absent */
  preview_minimum_cents?: number;
  precharge_threshold_cents: number;
  balance: { window_hours: number; new_account_cap_cents: number };
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

/** The method a new project gets: the gateway's default when it is
 * available, Lifelike otherwise when available, else Classic. Unknown
 * limits (not loaded, or failed) mean Lifelike — the gateway decides. */
export function newProjectMethod(_limits?: GatewayLimits | null): Method {
  // S3D-01: every new project is Lifelike (sent explicitly)
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
  is_default: boolean;
  /** paid when each run starts (Alipay, WeChat Pay) */
  pay_now?: boolean;
}

export interface BillingMethods {
  methods: SavedMethod[];
  /** most an account may keep (5) */
  max?: number;
}

/** A pay-now run's payment (S3D-60/61). */
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
  charges: BillingCharge[];
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
  /** the header pill's data (S3D-21) */
  balance?: BillingBalance;
  tier?: BillingTier;
  publishable_key: string;
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
export type Bitrate = "auto" | "match_source" | 20 | 40 | 60 | 100;

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
  /** S3D-56: output bitrate; absent = Automatic */
  bitrate?: Bitrate;
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
