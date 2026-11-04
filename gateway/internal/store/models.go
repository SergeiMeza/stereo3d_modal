// Package store: Firestore persistence for conversions, customers, and
// pricing config. The conversions collection is the support database — one
// document traces a ticket end-to-end (params ↔ Stripe ↔ Modal ↔ error).
package store

import (
	"encoding/json"
	"time"
)

// Conversion states. State only advances server-side (webhook, reconciler,
// or user cancel); the client is a pure observer.
//
// Legacy hold-mode conversions (mobile PaymentSheet) enter at "created" and
// need a payment confirmation to reach "paid". Auto-billed pro steps
// (Stripe.Mode == BillingModeAuto) enter directly at "paid" — billing was
// verified up front and the charge happens after success.
const (
	StateCreated    = "created"    // hold mode only: PaymentIntent exists; awaiting payment confirmation
	StatePaid       = "paid"       // cleared for submission (hold in place / billing verified)
	StateProcessing = "processing" // Modal job running
	StateSucceeded  = "succeeded"  // outputs published; money captured or charged
	StateFailed     = "failed"     // pipeline failed; user not charged
	StateCanceled   = "canceled"   // user canceled; user not charged
	StateExpired    = "expired"    // never paid (or hold lapsed); terminal
)

// ActiveStates are conversions the reconciler still owes work.
var ActiveStates = []string{StateCreated, StatePaid, StateProcessing}

// PaymentIntent settlement statuses (Stripe.PIStatus). The *_pending values
// are commitments written in the same transaction as the state change; the
// reconciler sweeps them until the Stripe call lands.
const (
	PICapturePending = "capture_pending"
	PICancelPending  = "cancel_pending"
	PISucceeded      = "succeeded"
	PICanceled       = "canceled"
	PICaptureFailed  = "capture_failed" // uncapturable; Slack-flagged for manual follow-up
	PICancelFailed   = "cancel_failed"  // already captured; Slack-flagged for manual refund

	// Auto-billing (pay-as-you-go) statuses. charge_pending is the committed
	// intent to charge after success (reconciler sweeps it); charge_failed is
	// a card decision that needs the user — it makes the account delinquent
	// (ListUserByPIStatus) and blocks new paid steps until settled.
	PIChargePending = "charge_pending"
	PIChargeFailed  = "charge_failed"
	// PIBatched: the conversion's price sits in the user's open billing
	// batch (Stripe.BatchID); the batch's charge settles it to succeeded
	// or, on a card decision, flips it to charge_failed.
	PIBatched = "batched"
	// Pre-charged runs (BillingModeAutoPrecharge) that end without a
	// result: cancel_pending is the committed intent to give the money
	// back; refunded is the outcome, refund_failed a refund Stripe refused
	// (Slack-flagged for a manual refund, no further retries).
	PIRefunded     = "refunded"
	PIRefundFailed = "refund_failed"
	// PICharging: a pre-charge is committed on the record BEFORE Stripe is
	// called (P8a, record before money); the reconciler replays its
	// deterministic key when the request died. PIProcessing: Stripe
	// accepted the payment but hasn't settled it (async methods; P2) — no
	// submit, credit or tier change until it succeeds ("waiting for
	// payment"). PIRequiresAction: the bank wants its check (3DS).
	PICharging       = "charging"
	PIProcessing     = "processing"
	PIRequiresAction = "requires_action"
)

// Payment flows (C1), decided per run at start.
const (
	FlowAfter     = "after"     // credit, ≤ the pre-charge threshold: charged when done, grouped
	FlowPrecharge = "precharge" // a saved method charged at start; refunded on failure/cancel
	FlowPayNow    = "paynow"    // the sheet (Checkout Session) before the run
	FlowChina     = "china"     // server-side Alipay / WeChat Pay PaymentIntent before the run
)

// Kinds of payment object a run, group or settle can hold (E0-1).
const (
	PaymentCheckoutSession = "checkout_session"
	PaymentIntentKind      = "payment_intent"
)

// Payment is the ONE live payment object of a run, group or settle (E0-1,
// current_payment): replaced only by compare-and-swap on ID.
type Payment struct {
	Kind      string     `firestore:"kind" json:"kind"`
	ID        string     `firestore:"id" json:"-"`
	ExpiresAt *time.Time `firestore:"expires_at,omitempty" json:"expires_at,omitempty"`
	Attempt   int        `firestore:"attempt" json:"-"`
	// UI: elements (our sheet), hosted_page (the hand-off), "" for a
	// PaymentIntent.
	UI string `firestore:"ui,omitempty" json:"-"`
	// ClientSecret of a session in elements mode (served to the sheet).
	ClientSecret string    `firestore:"client_secret,omitempty" json:"-"`
	URL          string    `firestore:"url,omitempty" json:"-"`
	CreatedAt    time.Time `firestore:"created_at" json:"-"`
	// ClientIP of the request that opened it: tax location evidence when
	// a method is saved (C6/D3).
	ClientIP string `firestore:"client_ip,omitempty" json:"-"`
}

// Lease gives one writer to a group's or settle's money (E0-4): whoever
// holds an unexpired lease is the only code that may call Stripe for it or
// write its failure.
type Lease struct {
	Owner string    `firestore:"owner"`
	Until time.Time `firestore:"until"`
}

// Held reports an unexpired lease at now.
func (l *Lease) Held(now time.Time) bool { return l != nil && now.Before(l.Until) }

// Billing modes (Stripe.Mode). Empty means hold mode (legacy records predate
// the field).
const (
	BillingModeHold = ""     // manual-capture hold confirmed by the client (mobile PaymentSheet)
	BillingModeAuto = "auto" // no hold; charge the saved default card on success
	// BillingModeAutoHold: pay-as-you-go for expensive runs — an off-session
	// manual-capture hold on the saved card at creation (no checkout UI),
	// captured on success. 3DS at creation surfaces as state=created +
	// billing requires_action until the client confirms.
	BillingModeAutoHold = "auto_hold"
	// BillingModeAutoPrecharge: pro steps quoted above the precharge
	// threshold (owner decision LL-D8, 2026-11-03) — the saved card is
	// CHARGED (automatic capture) before the job is submitted and refunded
	// in full if the run fails or is canceled. 3DS at creation parks the
	// run at state=created like auto_hold; the succeeded webhook submits it.
	BillingModeAutoPrecharge = "auto_precharge"
)

// Conversion methods (the project's choice; every run records the one it
// ran with). Lifelike runs on the shared lifelike3d Modal service
// (ml-sharp-modal ADR-0019); classic is this repo's depth → warp → inpaint
// pipeline. Records without a method are classic.
const (
	MethodLifelike = "lifelike"
	MethodClassic  = "classic"
)

// MethodOr returns m, or classic for records that predate the field.
func MethodOr(m string) string {
	if m == "" {
		return MethodClassic
	}
	return m
}

func IsTerminal(state string) bool {
	switch state {
	case StateSucceeded, StateFailed, StateCanceled, StateExpired:
		return true
	}
	return false
}

type Client struct {
	AppVersion string `firestore:"app_version,omitempty" json:"app_version,omitempty"`
	Platform   string `firestore:"platform,omitempty" json:"platform,omitempty"`
}

type Source struct {
	GCSKey    string  `firestore:"gcs_key" json:"gcs_key"`
	Bytes     int64   `firestore:"bytes" json:"bytes"`
	DurationS float64 `firestore:"duration_s" json:"duration_s"`
	Frames    int     `firestore:"frames" json:"frames"`
	FPS       float64 `firestore:"fps" json:"fps"`
	Width     int     `firestore:"width" json:"width"`
	Height    int     `firestore:"height" json:"height"`
	// PricingFPS: the rate the run was priced at without a target (the
	// counted rate when a VFR source's is higher than FPS; 0 = FPS).
	PricingFPS float64 `firestore:"pricing_fps,omitempty" json:"-"`
}

// Params is the clamped, whitelisted subset forwarded to Modal. Trim and
// scene cuts are integer SOURCE-frame indices, half-open — never seconds
// (frame doctrine, web/DESIGN.md).
type Params struct {
	Preset       string   `firestore:"preset" json:"preset"`
	Formats      []string `firestore:"formats" json:"formats"`
	Displacement float64  `firestore:"displacement,omitempty" json:"displacement,omitempty"` // legacy global knob (POST /v1/conversions only)
	// Placement: optional job-wide [far, near] planes (POST /v1/conversions
	// only; fractions of displacement, -1.5 <= far < near <= 1.5). nil =
	// pipeline default (-1.0, +0.5). Pro steps use scene_overrides instead.
	Placement []float64 `firestore:"placement,omitempty" json:"placement,omitempty"`
	TargetFPS float64   `firestore:"target_fps,omitempty" json:"target_fps,omitempty"`
	// FPSCapped: the account has no plan for rates above 30 fps, so the
	// source's rate was divided down to TargetFPS (fps_cap.go).
	FPSCapped bool   `firestore:"fps_capped,omitempty" json:"fps_capped,omitempty"`
	FromFrame int    `firestore:"from_frame,omitempty" json:"from_frame,omitempty"`
	ToFrame   int    `firestore:"to_frame,omitempty" json:"to_frame,omitempty"`
	Inpaint   string `firestore:"inpaint,omitempty" json:"inpaint,omitempty"` // "" = pipeline default; pro steps set it explicitly
	// DepthModel: video depth backend ("" = pipeline default vda).
	// Mobile exposes "da2" (per-frame relative DA2 — matches the app's
	// on-device model); the pro web steps never set it.
	DepthModel string `firestore:"depth_model,omitempty" json:"depth_model,omitempty"`
	// StereoMode (images): which eye(s) are synthesized. "" = both.
	StereoMode string `firestore:"stereo_mode,omitempty" json:"stereo_mode,omitempty"`
	// OutputDepthmap (images): include a colorized depth PNG in the
	// outputs. nil = pipeline default (true).
	OutputDepthmap *bool `firestore:"output_depthmap,omitempty" json:"output_depthmap,omitempty"`
	// Warp is the stereo synthesis method: "forward" (splat + occlusion
	// masks, the only one an inpaint model can follow) or "backward"
	// (gather warp — the mobile app's kernel; no holes, so inpaint is forced
	// to "none"). "" = pipeline default (forward).
	Warp string `firestore:"warp,omitempty" json:"warp,omitempty"`
	// DepthRes is the depth-map inference resolution (multiple of 14 in
	// [140, 2520]); 0 = the preset's default. The depth artifact is reused
	// across steps when depth_res + fps match, so the Depth page's pick is
	// the one production inherits.
	DepthRes int `firestore:"depth_res,omitempty" json:"depth_res,omitempty"`
	// DepthScale globally scales the adaptive profiler's depth script
	// ([0.3, 1.5]); 0 = 1.0.
	DepthScale     float64         `firestore:"depth_scale,omitempty" json:"depth_scale,omitempty"`
	SceneCuts      []int           `firestore:"scene_cuts,omitempty" json:"scene_cuts,omitempty"`
	SceneOverrides []SceneOverride `firestore:"scene_overrides,omitempty" json:"scene_overrides,omitempty"`
	SkipReuse      bool            `firestore:"skip_reuse,omitempty" json:"skip_reuse,omitempty"` // from-scratch: bypass content-addressed reuse
	// DepthSource is the bucket key of the project's USER-UPLOADED depth
	// video (resolved server-side from use_uploaded_depth — never taken
	// from the client). When set, Modal skips the depth stage and uses
	// this file; quotes discount the depth share unconditionally.
	DepthSource string `firestore:"depth_source,omitempty" json:"depth_source,omitempty"`
	// DepthOnly stops the pipeline after the depth stage (depth_preview
	// only): Modal publishes depth + depth_vis and completes — no stereo
	// warp, no output encodes. Set server-side, never from the client.
	DepthOnly bool `firestore:"depth_only,omitempty" json:"depth_only,omitempty"`
	// SplitMaxSeconds cuts the output into files of at most this many
	// seconds (production; 0 = one file). Lifelike only until the classic
	// pipeline implements the split contract.
	SplitMaxSeconds int `firestore:"split_max_seconds,omitempty" json:"split_max_seconds,omitempty"`
	// Lifelike quality (S3D-04): Quality is the option picked ("full" or a
	// preset); PricePreset the price-table row when it differs from Preset
	// (full resolution renders the step above and costs the step below).
	Quality     string `firestore:"quality,omitempty" json:"quality,omitempty"`
	PricePreset string `firestore:"price_preset,omitempty" json:"price_preset,omitempty"`
	// Lifelike (S3D-49/50): OriginalEye keeps the source frame as that eye
	// ("left" | "right"; "" = both rendered); Foveation "static" (or "").
	OriginalEye string `firestore:"original_eye,omitempty" json:"original_eye,omitempty"`
	// Bitrate (S3D-56): the choice ("match_source", "20", "40", "60",
	// "100"; "" = auto) and what it resolved to (0 = the pipeline's own).
	Bitrate          string `firestore:"bitrate,omitempty" json:"bitrate,omitempty"`
	OutputBitrateBps int64  `firestore:"output_bitrate_bps,omitempty" json:"output_bitrate_bps,omitempty"`
	Foveation        string `firestore:"foveation,omitempty" json:"foveation,omitempty"`
	// Express (add-on, pricing 2026-11): first in the GPU line.
	Express bool `firestore:"express,omitempty" json:"express,omitempty"`
	// RemoveBars / SourceCrop (BL-03): the run takes the project's black
	// bars off, keeping SourceCrop (displayed source pixels, sent as
	// source_crop). False / nil: the whole frame.
	RemoveBars bool  `firestore:"remove_bars,omitempty" json:"remove_bars,omitempty"`
	SourceCrop *Crop `firestore:"source_crop,omitempty" json:"source_crop,omitempty"`
	// IntroS / IntroLanguage: the Lifelike brand intro (BL-25) fixed at
	// creation: nil = none sent (the flag was off), 0 = a plan's opt-out,
	// 3 (previews) or 4 seconds. Never billed, never shown to clients.
	IntroS        *int   `firestore:"intro_s,omitempty" json:"-"`
	IntroLanguage string `firestore:"intro_language,omitempty" json:"-"`
}

// SceneOverride is a per-scene stereo tweak, keyed by the scene's first
// SOURCE frame (0 or one of the project's scene cuts — validated against the
// scene list version stamped on the conversion). Zero values mean "no
// override for this key"; at least one key is required per entry.
type SceneOverride struct {
	First        int       `firestore:"first" json:"first"`
	Displacement float64   `firestore:"displacement,omitempty" json:"displacement,omitempty"`
	ShotType     string    `firestore:"shot_type,omitempty" json:"shot_type,omitempty"`
	Placement    []float64 `firestore:"placement,omitempty" json:"placement,omitempty"`
	// Passthrough ships the scene as 2D (both eyes = source; no warp or
	// inpaint). Mutually exclusive with the knobs above.
	Passthrough bool `firestore:"passthrough,omitempty" json:"passthrough,omitempty"`
}

// Conversion steps (pro pipeline; "" for plain mobile conversions).
const (
	StepDepthPreview  = "depth_preview"
	StepStereoPreview = "stereo_preview"
	StepProduction    = "production"
	// StepLifelikePreview: a short (≤ 10 s) Lifelike render of the chosen
	// span; Lifelike projects have this and production only.
	StepLifelikePreview = "lifelike_preview"
)

type Quote struct {
	AmountCents int64          `firestore:"amount_cents" json:"amount_cents"`
	Currency    string         `firestore:"currency" json:"currency"`
	RateVersion string         `firestore:"rate_version" json:"rate_version"`
	Breakdown   map[string]any `firestore:"breakdown,omitempty" json:"breakdown,omitempty"`
}

type Stripe struct {
	CustomerID string `firestore:"customer_id" json:"customer_id"`
	// Mode selects the settlement path: BillingModeHold (legacy PaymentSheet
	// hold) or BillingModeAuto (charge the saved card on success).
	Mode string `firestore:"mode,omitempty" json:"mode,omitempty"`
	// PaymentIntentID: hold modes mint it at creation; auto mode at the first
	// charge attempt (one PI per conversion across every retry).
	PaymentIntentID string `firestore:"payment_intent_id,omitempty" json:"payment_intent_id"`
	// ClientSecret of the hold PI (auto_hold only) — served on the conversion
	// while state=created so the web client can complete a 3DS challenge with
	// the saved card. Never in JSON; conversionResponse decides exposure.
	ClientSecret string `firestore:"client_secret,omitempty" json:"-"`
	PIStatus     string `firestore:"pi_status,omitempty" json:"pi_status,omitempty"`
	// ChargePM / ChargeEmail: what a recorded pre-charge is made with, so a
	// replay sends the very same request under its key (P8a).
	ChargePM string `firestore:"charge_pm,omitempty" json:"-"`
	// ChargePM2: the pre-charge's second try (C1) — the last good method
	// when it differs from the default.
	ChargePM2 string `firestore:"charge_pm2,omitempty" json:"-"`
	// SettleID: the settle that collected (or is collecting) this run.
	SettleID    string `firestore:"settle_id,omitempty" json:"-"`
	ChargeEmail string `firestore:"charge_email,omitempty" json:"-"`
	// BatchID: the billing batch this auto-mode conversion was folded into
	// (pi_status batched → succeeded/charge_failed follow the batch).
	BatchID       string     `firestore:"batch_id,omitempty" json:"batch_id,omitempty"`
	CapturedCents int64      `firestore:"captured_cents,omitempty" json:"captured_cents,omitempty"`
	CapturedAt    *time.Time `firestore:"captured_at,omitempty" json:"captured_at,omitempty"`
	CanceledAt    *time.Time `firestore:"canceled_at,omitempty" json:"canceled_at,omitempty"`
	// Pre-charged runs that ended without a result (pi_status refunded).
	RefundedCents int64      `firestore:"refunded_cents,omitempty" json:"refunded_cents,omitempty"`
	RefundedAt    *time.Time `firestore:"refunded_at,omitempty" json:"refunded_at,omitempty"`
	// SettleError records a capture/cancel/charge failure for support
	// follow-up. Never blocks the job result.
	SettleError string `firestore:"settle_error,omitempty" json:"-"`
}

type Modal struct {
	JobID        string     `firestore:"job_id,omitempty" json:"job_id,omitempty"`
	SubmittedAt  *time.Time `firestore:"submitted_at,omitempty" json:"submitted_at,omitempty"`
	LastPolledAt *time.Time `firestore:"last_polled_at,omitempty" json:"-"`
	Progress     float64    `firestore:"progress" json:"progress"`
	Stage        string     `firestore:"stage,omitempty" json:"stage,omitempty"`
	ETASeconds   int64      `firestore:"eta_seconds,omitempty" json:"eta_seconds,omitempty"`
	CostUSD      float64    `firestore:"cost_usd,omitempty" json:"-"`
	// CostUSDRaw: Lifelike's model figure before its billing factor
	// (cost_summary.total_usd_raw); CostUSD is the bill estimate.
	CostUSDRaw float64 `firestore:"cost_usd_raw,omitempty" json:"-"`
	// Experimental: the job says its output is experimental (Lifelike
	// 5K-8K, metadata.experimental).
	Experimental bool `firestore:"experimental,omitempty" json:"-"`
	// WaitingForGPU / QueuedS are copied from the job record (both
	// pipelines): a GPU call is queued and none runs / total seconds spent
	// so. Queued time is not the run's fault, so overdue judging adds it.
	WaitingForGPU bool    `firestore:"waiting_for_gpu,omitempty" json:"waiting_for_gpu"`
	QueuedS       float64 `firestore:"queued_s,omitempty" json:"queued_s"`
	// StartedAt: when the run got its GPU, as polls saw it — the moment it
	// left the queue, or its submission once it ran a cancel window without
	// ever queueing. nil while it has only waited. The cancel window
	// counts from here (S3D-23).
	StartedAt *time.Time `firestore:"started_at,omitempty" json:"-"`
	// WaitingSince: when the current wait for a GPU began, as polls saw
	// it (nil while not waiting) — the GPU-line alert's clock (S3D-34).
	WaitingSince *time.Time `firestore:"waiting_since,omitempty" json:"-"`
	// Priority / GPUWorkers: what a Lifelike job echoed of its scheduling
	// (metadata.priority "standard"|"express", metadata.max_gpu_workers).
	// ExpressCostFactor: the GPU cost factor of an Express run (8 vs 4
	// GPUs, 1.12 measured), set at submit, for cost reporting.
	// Brand intro (BL-25) as the job reported it: never billed. IntroFrames
	// are the intro's (part 1 only); VideoFrames the customer's video
	// (what was quoted); BrandIntroUSD the brand_intro cost stage.
	IntroS        int     `firestore:"intro_s,omitempty" json:"-"`
	IntroFrames   int     `firestore:"intro_frames,omitempty" json:"-"`
	VideoFrames   int     `firestore:"video_frames,omitempty" json:"-"`
	BrandIntroUSD float64 `firestore:"brand_intro_usd,omitempty" json:"-"`
	// SourceVFR / SourceCountedFrames: the pipeline's read of the source
	// (variable-rate, frames it counted); nil on jobs that don't say.
	SourceVFR           *bool   `firestore:"source_vfr,omitempty" json:"-"`
	SourceCountedFrames int     `firestore:"source_counted_frames,omitempty" json:"-"`
	Priority            string  `firestore:"priority,omitempty" json:"-"`
	GPUWorkers          int     `firestore:"max_gpu_workers,omitempty" json:"-"`
	ExpressCostFactor   float64 `firestore:"express_cost_factor,omitempty" json:"-"`
}

// Part is one file of a split output (metadata.parts of the job record):
// SOURCE frames, half open, the same boundaries for every format.
type Part struct {
	Index     int     `firestore:"index" json:"index"`
	FromFrame int     `firestore:"from_frame" json:"from_frame"`
	ToFrame   int     `firestore:"to_frame" json:"to_frame"`
	StartS    float64 `firestore:"start_s" json:"start_s"`
	DurationS float64 `firestore:"duration_s" json:"duration_s"`
}

type Error struct {
	Code        string `firestore:"code" json:"code"`
	UserMessage string `firestore:"user_message" json:"user_message"`
	// Internal detail (full Modal error) — logged and stored, never serialized
	// to clients.
	InternalMessage string `firestore:"internal_message" json:"-"`
}

type Conversion struct {
	ID  string `firestore:"-" json:"conversion_id"`
	UID string `firestore:"uid" json:"-"`
	Env string `firestore:"env" json:"-"`
	// Sample: the sample project's finished run; Outputs hold public URLs
	// of shared files, not keys (sample.go).
	Sample    bool   `firestore:"sample,omitempty" json:"sample,omitempty"`
	State     string `firestore:"state" json:"state"`
	Kind      string `firestore:"kind" json:"kind"`                                 // "video" | "image"
	ProjectID string `firestore:"project_id,omitempty" json:"project_id,omitempty"` // pro pipeline
	Step      string `firestore:"step,omitempty" json:"step,omitempty"`
	Method    string `firestore:"method,omitempty" json:"method,omitempty"` // "" = classic
	// Workspace: the Modal workspace the run goes to, its project's
	// (S3D-40); "" = the default.
	Workspace string            `firestore:"workspace,omitempty" json:"-"`
	ScenesVer int               `firestore:"scenes_version,omitempty" json:"scenes_version,omitempty"`
	Client    Client            `firestore:"client" json:"client,omitempty"`
	Source    Source            `firestore:"source" json:"source"`
	Params    Params            `firestore:"params" json:"params"`
	Quote     Quote             `firestore:"quote" json:"quote"`
	Stripe    Stripe            `firestore:"stripe" json:"-"`
	Modal     Modal             `firestore:"modal" json:"modal"`
	Outputs   map[string]string `firestore:"outputs,omitempty" json:"-"`             // name → gcs key; clients fetch signed URLs
	Parts     []Part            `firestore:"parts,omitempty" json:"parts,omitempty"` // split outputs only
	Error     *Error            `firestore:"error,omitempty" json:"error,omitempty"`
	IdemKey   string            `firestore:"idem_key,omitempty" json:"-"`
	Support   Support           `firestore:"support" json:"-"`
	// Payment layer (spec v6 E0). PaymentFlow is the C1 rule decided at
	// start; CurrentPayment the one live payment object (E0-1); ExpiresAt
	// the run's clock while "created", which follows the payment (E0-3);
	// Lease the one writer while money moves (E0-4).
	PaymentFlow string `firestore:"payment_flow,omitempty" json:"payment_flow,omitempty"`
	PayReason   string `firestore:"pay_reason,omitempty" json:"-"`
	// DeclinedMethodLabel: "Visa •••• 4242" when a pre-charge was declined
	// (P3 names the method).
	DeclinedMethodLabel string `firestore:"declined_method_label,omitempty" json:"-"`
	// HandoffCode: the run's "pay on another device" code (B17), one per run.
	HandoffCode    string   `firestore:"handoff_code,omitempty" json:"-"`
	CurrentPayment *Payment `firestore:"current_payment,omitempty" json:"-"`
	// RunBalance: a run paid from the prepaid balance holds it here (v7 N5).
	RunBalance *RunBalance `firestore:"balance,omitempty" json:"-"`
	// FreePreview: a preview paid with free previews (pricing 2026-11);
	// given back if it delivers nothing.
	FreePreview *FreePreview `firestore:"free_preview,omitempty" json:"-"`
	// CanceledBy: who cancelled it — "" / user, us (support, an early
	// fraud warning), deletion — for the refund reason (C12).
	CanceledBy string `firestore:"canceled_by,omitempty" json:"-"`
	// DisputeID: a dispute is open on the charge that paid it (its files
	// are locked, 403 disputed).
	DisputeID string `firestore:"dispute_id,omitempty" json:"-"`
	// Payments are every payment object the run ever had (for E0-2's
	// late-money check and support).
	// Repacks (ADR 0137): formats made later from the run's stored output,
	// by format (mvhevc | sbs | half_sbs); RepackPending while one runs
	// (the reconciler polls those).
	Repacks       map[string]*Repack `firestore:"repacks,omitempty" json:"-"`
	RepackPending bool               `firestore:"repack_pending,omitempty" json:"-"`
	Payments      []Payment          `firestore:"payments,omitempty" json:"-"`
	ExpiresAt     *time.Time         `firestore:"expires_at,omitempty" json:"-"`
	Lease         *Lease             `firestore:"lease,omitempty" json:"-"`
	CreatedAt     time.Time          `firestore:"created_at" json:"created_at"`
	UpdatedAt     time.Time          `firestore:"updated_at" json:"updated_at"`
}

// Support tracks runs that outlive their estimate. On 2026-10-27 runs sat
// at "Profiling scenes" for hours and neither we nor the users heard about
// it until one of them emailed.
type Support struct {
	// ExpectedSeconds is the pre-run wall-clock estimate (0 = none).
	ExpectedSeconds  int64      `firestore:"expected_seconds,omitempty"`
	OverdueAlertedAt *time.Time `firestore:"overdue_alerted_at,omitempty"`
	Reports          []Report   `firestore:"reports,omitempty"`
}

// Report is a user's "this run is stuck" from the web app.
type Report struct {
	At    time.Time `firestore:"at"`
	Note  string    `firestore:"note,omitempty"`
	Email string    `firestore:"email,omitempty"`
}

type Customer struct {
	StripeCustomerID string `firestore:"stripe_customer_id"`
	Email            string `firestore:"email,omitempty"`
	// Cached default payment method (refreshed from Stripe by GET
	// /v1/billing). The conversion-create gate reads this cache — a stale
	// "has card" is caught by the post-success charge, whose failure blocks
	// further paid steps.
	DefaultPaymentMethod string `firestore:"default_payment_method,omitempty"`
	CardBrand            string `firestore:"card_brand,omitempty"`
	CardLast4            string `firestore:"card_last4,omitempty"`
	CardExpMonth         int64  `firestore:"card_exp_month,omitempty"`
	CardExpYear          int64  `firestore:"card_exp_year,omitempty"`
	// DefaultMethodType/Wallet/Email: the cached default's type (card,
	// link, paypal; "" = a card cached before P7), wallet and account
	// email for Link/PayPal.
	DefaultMethodType   string    `firestore:"default_method_type,omitempty"`
	DefaultMethodWallet string    `firestore:"default_method_wallet,omitempty"`
	DefaultMethodEmail  string    `firestore:"default_method_email,omitempty"`
	CardUpdatedAt       time.Time `firestore:"card_updated_at,omitempty"`
	CreatedAt           time.Time `firestore:"created_at"`
	// OpenBatchID points at the user's currently accumulating billing
	// batch ("" = none). Owned by the batch transactions in batches.go.
	OpenBatchID string `firestore:"open_batch_id,omitempty"`
	// LifetimePaidCents is the money actually collected from this user
	// (batch charges, hold captures, legacy per-step charges). It picks the
	// batch tier: users with a proven payment history accumulate more
	// before a charge. Seeded once from historical succeeded charges
	// (LifetimePaidSeeded) for accounts that predate batching.
	LifetimePaidCents int64 `firestore:"lifetime_paid_cents"`
	// Blocked: the owner blocked the account (A3); no new paid runs.
	Blocked bool `firestore:"blocked,omitempty"`
	// Plan: the web plan (Business, Studio), from Stripe Billing.
	Plan *Plan `firestore:"plan,omitempty"`
	// PaidOnce: a payment has gone through (lifts the B14 limits even
	// before a pre-charged run delivers and earns the money).
	PaidOnce           bool `firestore:"paid_once,omitempty"`
	LifetimePaidSeeded bool `firestore:"lifetime_paid_seeded"`
	// Payment-layer account facts (C1), updated on every off-session or
	// saved payment. LastGoodMethod: the saved method that most recently
	// paid us. PaidMethods: every saved method that has ever paid (credit
	// needs one). AllMethodsFailed: a group's whole backup loop declined
	// on every method; cleared by any payment with a saved method.
	// SheetOnly: pays every run in the sheet (a dispute or a stop code).
	// UnderReview: an early fraud warning; paid runs blocked.
	LastGoodMethod   string   `firestore:"last_good_method,omitempty"`
	PaidMethods      []string `firestore:"paid_methods,omitempty"`
	AllMethodsFailed bool     `firestore:"all_methods_failed,omitempty"`
	SheetOnly        bool     `firestore:"sheet_only,omitempty"`
	SheetOnlyReason  string   `firestore:"sheet_only_reason,omitempty"`
	UnderReview      bool     `firestore:"under_review,omitempty"`
	// BackupOrder: the customer's order of saved methods for backups
	// (C5, set in Billing; methods not listed follow in the order added).
	BackupOrder []string `firestore:"backup_order,omitempty"`
	// MethodAdds: setup sessions opened per day (H: at most 3 a day).
	MethodAddsDay string `firestore:"method_adds_day,omitempty"`
	MethodAdds    int    `firestore:"method_adds,omitempty"`
	// LiveSettleID: the account's live settle (C11), "" when none;
	// SettleSeq numbers its settles.
	LiveSettleID string `firestore:"live_settle_id,omitempty"`
	SettleSeq    int    `firestore:"settle_seq,omitempty"`
	// LastChargeFailedAt: the last automatic charge (a conversion's or a
	// batch's) the card declined. Within the failure lookback it drops the
	// account to the first batch tier (S3D-19).
	LastChargeFailedAt *time.Time `firestore:"last_charge_failed_at,omitempty"`
	// PhotoCredits: leftover balance from the withdrawn photo packs
	// (sold 2026-09-02 only). Consumed after the free daily allowance and
	// before a still is charged; refunded when a credited run fails or is
	// canceled. Never expires; nothing grants new credits.
	PhotoCredits int64 `firestore:"photo_credits"`
	// AccountDeleted marks an account deleted through POST
	// /v1/account/delete. The record stays whole (soft delete); new paid
	// work is refused.
	AccountDeleted bool       `firestore:"account_deleted,omitempty"`
	DeletedAt      *time.Time `firestore:"deleted_at,omitempty"`
	// DeletionPending: the customer confirmed "Delete and refund"; the
	// account is deleted once its closure case (DeletionCaseID) is decided
	// (N8 step 3). New runs and top-ups are refused meanwhile.
	DeletionPending     bool       `firestore:"deletion_pending,omitempty"`
	DeletionCaseID      string     `firestore:"deletion_case_id,omitempty"`
	DeletionRequestedAt *time.Time `firestore:"deletion_requested_at,omitempty"`
	// DefaultFingerprint: the cached default card's fingerprint (block
	// list gate, H).
	DefaultFingerprint string `firestore:"default_fingerprint,omitempty"`
	// Locale: the account's language for the Lifelike intro (BCP-47; ""
	// = the browser's). LifelikeIntroOff: a Business/Studio plan's
	// opt-out (honoured only while such a plan is active).
	Locale           string `firestore:"locale,omitempty"`
	LifelikeIntroOff bool   `firestore:"lifelike_intro_off,omitempty"`
	// Onboarding (owner 2026-11-04): where they watch (the welcome's first
	// answer; HeadsetsSet tells an empty answer from none), the first-time
	// hints dismissed, the welcome/checklist/tips flags, and when they
	// first played or downloaded a run of their own.
	Headsets       []string    `firestore:"headsets,omitempty"`
	HeadsetsSet    bool        `firestore:"headsets_set,omitempty"`
	HintsSeen      []string    `firestore:"hints_seen,omitempty"`
	Onboarding     *Onboarding `firestore:"onboarding,omitempty"`
	FirstWatchedAt *time.Time  `firestore:"first_watched_at,omitempty"`
	// Dismissed: when each plans surface was last dismissed (placement →
	// time), for the ones that come back (projects_banner after 7 days).
	Dismissed map[string]time.Time `firestore:"dismissed,omitempty"`
	// SimulateAppPro (test only, never honoured on prod): the account
	// reads as holding the app's Pro, for the onboarding variant and the
	// Pro price tier.
	SimulateAppPro bool `firestore:"simulate_app_pro,omitempty"`
	// BusinessSetup: the Business/Studio setup's answers (owner
	// 2026-11-04).
	BusinessSetup *BusinessSetup `firestore:"business_setup,omitempty"`
	// Company: the account's company details for invoices (from a plan
	// Checkout or PUT /v1/billing/company); the Stripe Customer carries
	// name, address, tax IDs and the PO custom field, kept in sync.
	Company *CompanyDetails `firestore:"company,omitempty"`
	// ProIntroUsed: the account has had web Pro's intro price (once).
	ProIntroUsed bool `firestore:"pro_intro_used,omitempty"`
}

// CompanyDetails are the account's invoice details.
type CompanyDetails struct {
	CompanyName  string            `firestore:"company_name,omitempty"`
	Address      map[string]string `firestore:"address,omitempty"` // line1, line2, city, postal_code, state, country
	TaxIDs       []CompanyTaxID    `firestore:"tax_ids,omitempty"`
	BillingEmail string            `firestore:"billing_email,omitempty"`
	POReference  string            `firestore:"po_reference,omitempty"`
	Source       string            `firestore:"source,omitempty"` // checkout | user
	UpdatedAt    time.Time         `firestore:"updated_at"`
	Changes      []CompanyChange   `firestore:"changes,omitempty"` // the last 20
}

// CompanyTaxID is one tax ID as entered.
type CompanyTaxID struct {
	Type  string `firestore:"type"`
	Value string `firestore:"value"`
}

// CompanyChange is one change to the company details: when, by what
// (checkout | user) and which fields.
type CompanyChange struct {
	At     time.Time `firestore:"at" json:"at"`
	By     string    `firestore:"by" json:"by"`
	Fields []string  `firestore:"fields" json:"fields"`
}

// BusinessSetup is what the setup flow asked.
type BusinessSetup struct {
	TeamSize  string    `firestore:"team_size,omitempty"`
	MainUse   string    `firestore:"main_use,omitempty"` // client_work | own_channel | stock | other
	Headsets  []string  `firestore:"headsets,omitempty"`
	UpdatedAt time.Time `firestore:"updated_at"`
}

// Onboarding is the account's onboarding flags; nil = never written (an
// account from before onboarding reads welcome_done).
type Onboarding struct {
	WelcomeDone     *bool `firestore:"welcome_done,omitempty"`
	ChecklistHidden bool  `firestore:"checklist_hidden,omitempty"`
	TipsDone        bool  `firestore:"tips_done,omitempty"`
	// AppProWelcomeDone: the app Pro welcome was shown (once, also for web
	// accounts that gain the app's Pro later).
	AppProWelcomeDone bool `firestore:"app_pro_welcome_done,omitempty"`
}

// ----------------------------------------------------------------- batches

// Billing batch states. A batch is the user's running tab: succeeded
// auto-mode conversions append to the open batch instead of charging one
// by one (a burst of small same-merchant charges is what issuers flag as
// fraud). It closes — and becomes ONE off-session charge — when its window
// elapses, its total reaches the user's tier cap, or the user pays now.
const (
	BatchOpen     = "open"     // accumulating
	BatchCharging = "charging" // closed; the charge is committed (reconciler sweeps until Stripe answers)
	BatchPaid     = "paid"     // charged; terminal
	BatchFailed   = "failed"   // card decision; account delinquent until settled (re-armed to charging)
	BatchWaived   = "waived"   // every run waived (C13): nothing to charge; terminal
)

// Batch close reasons (Batch.CloseReason).
const (
	BatchCloseWindow        = "window"
	BatchCloseCap           = "cap"
	BatchClosePayNow        = "pay_now"
	BatchCloseAccountDelete = "account_delete" // collected before the account was deleted
)

type BatchItem struct {
	ConversionID string    `firestore:"conversion_id" json:"conversion_id"`
	ProjectID    string    `firestore:"project_id,omitempty" json:"project_id,omitempty"`
	Step         string    `firestore:"step,omitempty" json:"step,omitempty"`
	Kind         string    `firestore:"kind" json:"kind"`
	Description  string    `firestore:"description" json:"description"`
	AmountCents  int64     `firestore:"amount_cents" json:"amount_cents"`
	AddedAt      time.Time `firestore:"added_at" json:"added_at"`
}

type Batch struct {
	ID          string      `firestore:"-" json:"batch_id"`
	UID         string      `firestore:"uid" json:"-"`
	Env         string      `firestore:"env" json:"-"`
	State       string      `firestore:"state" json:"state"`
	Currency    string      `firestore:"currency" json:"currency"`
	Items       []BatchItem `firestore:"items" json:"items"`
	TotalCents  int64       `firestore:"total_cents" json:"total_cents"`
	CapCents    int64       `firestore:"cap_cents" json:"cap_cents"` // tier cap when opened
	OpenedAt    time.Time   `firestore:"opened_at" json:"opened_at"`
	DueAt       time.Time   `firestore:"due_at" json:"due_at"` // window close
	ClosedAt    *time.Time  `firestore:"closed_at,omitempty" json:"closed_at,omitempty"`
	CloseReason string      `firestore:"close_reason,omitempty" json:"close_reason,omitempty"`
	// Stripe settlement: one PaymentIntent per batch across every retry.
	PaymentIntentID string `firestore:"payment_intent_id,omitempty" json:"-"`
	// PIStatus: "processing" while Stripe settles an async payment
	// (CHARGING_ASYNC, P2): still charging, never paid until succeeded.
	PIStatus string `firestore:"pi_status,omitempty" json:"-"`
	// Lease: the one writer of this group's charge (E0-4). PaidWith: the
	// method that paid (a C5 backup may differ from the default).
	Lease    *Lease `firestore:"lease,omitempty" json:"-"`
	PaidWith string `firestore:"paid_with,omitempty" json:"-"`
	// SettleID: the settle collecting this failed group (C11).
	SettleID string `firestore:"settle_id,omitempty" json:"-"`
	// FailedAt / SoftDecline / SoftRetried: the 24 h automatic retry of a
	// soft decline (C5), once.
	FailedAt     *time.Time `firestore:"failed_at,omitempty" json:"-"`
	SoftDecline  bool       `firestore:"soft_decline,omitempty" json:"-"`
	SoftRetried  bool       `firestore:"soft_retried,omitempty" json:"-"`
	ChargedCents int64      `firestore:"charged_cents,omitempty" json:"charged_cents,omitempty"`
	ChargedAt    *time.Time `firestore:"charged_at,omitempty" json:"charged_at,omitempty"`
	SettleError  string     `firestore:"settle_error,omitempty" json:"-"`
	CreatedAt    time.Time  `firestore:"created_at" json:"created_at"`
	UpdatedAt    time.Time  `firestore:"updated_at" json:"updated_at"`
}

// ---------------------------------------------------------------- projects

// Analyze states (free Modal job tracked on the project, not a conversion).
const (
	AnalyzeRunning   = "running"
	AnalyzeSucceeded = "succeeded"
	AnalyzeFailed    = "failed"
)

type Probe struct {
	Width       int     `firestore:"width" json:"width"`
	Height      int     `firestore:"height" json:"height"`
	FPS         float64 `firestore:"fps" json:"fps"`
	FPSRational string  `firestore:"fps_rational" json:"fps_rational"`
	DurationS   float64 `firestore:"duration_s" json:"duration_s"`
	NumFrames   int     `firestore:"num_frames" json:"num_frames"`
	// BitRate: the video stream's bits per second when analysis reports it
	// (0 = unknown; match_source then estimates from the file size).
	BitRate int64 `firestore:"bit_rate,omitempty" json:"bit_rate,omitempty"`
	// CountedFrames: the video packets ffprobe counted in the file
	// (-count_packets), not the header's claim (0 = not counted). A
	// variable-frame-rate file can state 30 fps and carry bursts well
	// above it; pricing uses the higher of the stated and counted rates.
	CountedFrames int `firestore:"counted_frames,omitempty" json:"counted_frames,omitempty"`
	// VFR: the counted rate is above the stated one (more than 1%).
	VFR bool `firestore:"vfr,omitempty" json:"vfr,omitempty"`
	// SourceVFR / SourceCountedFrames: the render pipeline's own read of
	// the source, from the first run that reports it (for support cases).
	SourceVFR           *bool `firestore:"source_vfr,omitempty" json:"source_vfr,omitempty"`
	SourceCountedFrames int   `firestore:"source_counted_frames,omitempty" json:"source_counted_frames,omitempty"`
}

// CountedFPS is the counted frames over the duration (0 = not counted).
func (p *Probe) CountedFPS() float64 {
	if p == nil || p.CountedFrames <= 0 || p.DurationS <= 0 {
		return 0
	}
	return float64(p.CountedFrames) / p.DurationS
}

// PricingFPS is the rate a source is priced and capped at: the counted
// rate when it's more than 1% above the stated one (a VFR source), else
// the stated rate (durations differ slightly between stream and
// container, and a 30 fps clip must not read as 30.02 and be capped).
func (p *Probe) PricingFPS() float64 {
	if p == nil {
		return 0
	}
	if c := p.CountedFPS(); c > p.FPS*1.01 {
		return c
	}
	return p.FPS
}

// PricingFrames is the frame count a source is priced at: the higher of
// the header's and the counted one.
func (p *Probe) PricingFrames() int {
	if p == nil {
		return 0
	}
	return max(p.NumFrames, p.CountedFrames)
}

type Analyze struct {
	JobID   string  `firestore:"job_id" json:"-"`
	State   string  `firestore:"state" json:"state"`
	Error   string  `firestore:"error,omitempty" json:"error,omitempty"`
	CostUSD float64 `firestore:"cost_usd,omitempty" json:"-"`
	// Transient live-progress fields (state=running only): filled from the
	// Modal job on each read-through poll, never persisted — Firestore would
	// otherwise take a write per client poll.
	Progress   float64 `firestore:"-" json:"progress,omitempty"`
	Stage      string  `firestore:"-" json:"stage,omitempty"`
	ETASeconds int64   `firestore:"-" json:"eta_seconds,omitempty"`
	// CreditCents is granted on analyze success and consumed (as a discount)
	// by the project's first paid conversion; restored if that conversion
	// ends without capture.
	CreditCents      int64  `firestore:"credit_cents" json:"credit_cents"`
	CreditConsumedBy string `firestore:"credit_consumed_by,omitempty" json:"-"`
}

// ProfileJob tracks the FREE standalone shot-profiling job (the Stereo
// page's "Profile shots" action): the adaptive profiler runs over the
// analyze proxy + current cuts and folds its depth script into SceneProfile
// — measured per-scene defaults without paying for a conversion.
type ProfileJob struct {
	JobID string `firestore:"job_id" json:"-"`
	State string `firestore:"state" json:"state"` // running | succeeded | failed
	// ScenesVersion the job was submitted against (staleness detection,
	// same doctrine as SceneProfile.ScenesVersion).
	ScenesVersion int    `firestore:"scenes_version" json:"scenes_version"`
	Error         string `firestore:"error,omitempty" json:"error,omitempty"`
	// Transient live-progress fields (state=running only) — see Analyze.
	Progress  float64   `firestore:"-" json:"progress,omitempty"`
	Stage     string    `firestore:"-" json:"stage,omitempty"`
	UpdatedAt time.Time `firestore:"updated_at" json:"updated_at"`
}

// Scenes is the user-editable cut list. Cuts are SOURCE-frame indices (each
// the first frame of a new scene), strictly increasing. Version increments
// on every edit; conversions snapshot the version they ran with.
type Scenes struct {
	Version   int       `firestore:"version" json:"version"`
	Cuts      []int     `firestore:"cuts" json:"cuts"`
	Edited    bool      `firestore:"edited" json:"edited"` // false = auto-detected, untouched
	UpdatedAt time.Time `firestore:"updated_at" json:"updated_at"`
}

// MarshalJSON always emits cuts as an array. A single-shot source has no
// cuts, and older docs stored that as null; the client contract types cuts
// as number[] and reads .length on it, so null must never reach the wire.
func (sc Scenes) MarshalJSON() ([]byte, error) {
	type alias Scenes
	a := alias(sc)
	if a.Cuts == nil {
		a.Cuts = []int{}
	}
	return json.Marshal(a)
}

type Thumb struct {
	Frame int    `firestore:"frame" json:"frame"`
	URL   string `firestore:"url" json:"url"`
}

// SceneProfile is the adaptive per-shot profiler's output (job metadata
// depth_script), folded onto the project when a pro video conversion
// succeeds. The Stereo page seeds its per-scene displacement / shot-type
// editors from it. Latest succeeded run wins; ScenesVersion records which
// scene-list version that run was validated against, so a stale profile is
// detectable after a cut edit.
type SceneProfile struct {
	ConversionID  string        `firestore:"conversion_id" json:"conversion_id"`
	ScenesVersion int           `firestore:"scenes_version" json:"scenes_version"`
	Shots         []ProfileShot `firestore:"shots" json:"shots"`
	UpdatedAt     time.Time     `firestore:"updated_at" json:"updated_at"`
}

// ProfileShot is one profiled shot in SOURCE-frame space, half-open
// [first_src, last_src) — frame doctrine, never seconds.
type ProfileShot struct {
	FirstSrc     int       `firestore:"first_src" json:"first_src"`
	LastSrc      int       `firestore:"last_src" json:"last_src"`
	ShotType     string    `firestore:"shot_type" json:"shot_type"`
	Displacement float64   `firestore:"displacement" json:"displacement"`
	Placement    []float64 `firestore:"placement,omitempty" json:"placement,omitempty"`
}

// DepthUpload is a user-provided depth video registered on the project
// (POST /v1/projects/{id}/depth-map): a bucket key from the standard
// signed-PUT upload flow, ffprobe-validated to be frame-exact against the
// source (frames == probe.num_frames — the pipeline re-verifies against
// the actual preprocess). Conversions created with use_uploaded_depth run
// against this file instead of computing depth.
type DepthUpload struct {
	// GCSKey stays server-side (json:"-"): clients reference the upload via
	// use_uploaded_depth, never by key.
	GCSKey    string    `firestore:"gcs_key" json:"-"`
	Name      string    `firestore:"name,omitempty" json:"name,omitempty"`
	Frames    int       `firestore:"frames" json:"frames"`
	Width     int       `firestore:"width" json:"width"`
	Height    int       `firestore:"height" json:"height"`
	Bytes     int64     `firestore:"bytes" json:"bytes"`
	CreatedAt time.Time `firestore:"created_at" json:"created_at"`
}

type Project struct {
	ID  string `firestore:"-" json:"project_id"`
	UID string `firestore:"uid" json:"-"`
	Env string `firestore:"env" json:"-"`
	// Sample: the finished "Sunset session" every new account gets
	// (onboarding, 2026-11-04): read-only, never billed, its files shared
	// (never deleted), left out of usage, KPIs and billing reports.
	Sample bool   `firestore:"sample,omitempty" json:"sample,omitempty"`
	Name   string `firestore:"name,omitempty" json:"name,omitempty"`
	Method string `firestore:"method,omitempty" json:"method,omitempty"` // "" = classic (projects before Lifelike)
	// ClassicRan: the project has run Classic, so it may go on with it
	// after Classic's retirement for new projects (2026-11-04).
	ClassicRan bool `firestore:"classic_ran,omitempty" json:"-"`
	// Workspace: the Modal workspace the project lives in, set at
	// creation (S3D-40); "" = the default (projects made before).
	Workspace    string        `firestore:"workspace,omitempty" json:"-"`
	Source       Source        `firestore:"source" json:"source"`
	Probe        *Probe        `firestore:"probe,omitempty" json:"probe,omitempty"`
	Analyze      Analyze       `firestore:"analyze" json:"analyze"`
	Scenes       *Scenes       `firestore:"scenes,omitempty" json:"scenes,omitempty"`
	SceneProfile *SceneProfile `firestore:"scene_profile,omitempty" json:"scene_profile,omitempty"`
	Profile      *ProfileJob   `firestore:"profile,omitempty" json:"profile,omitempty"`
	DepthUpload  *DepthUpload  `firestore:"depth_upload,omitempty" json:"depth_upload,omitempty"`
	Crop         string        `firestore:"crop,omitempty" json:"crop,omitempty"`
	// RemoveBars: the user's choice for black bars on Lifelike runs
	// (BL-03, owner 2026-11-03: bars come off by default); nil = the
	// default (remove when analysis found bars), see removeBars.
	RemoveBars *bool `firestore:"remove_bars,omitempty" json:"-"`
	// BarsRemovalOff: set on read when the gateway doesn't send
	// source_crop yet (lifelike_source_crop_enabled off); never stored.
	BarsRemovalOff bool    `firestore:"-" json:"-"`
	PreviewURL     string  `firestore:"preview_url,omitempty" json:"preview_url,omitempty"` // frame-exact h264 proxy (browser playback)
	StripThumbs    []Thumb `firestore:"strip_thumbs,omitempty" json:"strip_thumbs,omitempty"`
	SceneThumbs    []Thumb `firestore:"scene_thumbs,omitempty" json:"scene_thumbs,omitempty"`
	Archived       bool    `firestore:"archived" json:"archived"`
	// Deleted: removed by the user (POST /v1/projects/{id}/delete, S3D-24).
	// Soft delete: the API answers 404 for the project and its runs at
	// once; the record stays, its stored files are purged
	// deleted_project_purge_days later (kept for disputes).
	Deleted   bool       `firestore:"deleted,omitempty" json:"-"`
	DeletedAt *time.Time `firestore:"deleted_at,omitempty" json:"-"`
	// File keeping (S3D-24, file_keeping.go). LastActivityAt: the last
	// use (opened, run started, download, keep). FilesDeleteAt: when the
	// files go — last use + file_keep_days, a deleted project's deletion
	// + deleted_project_purge_days; never sooner than the last notice's
	// lead time after that notice went out. FilesNoticeDays: the shortest
	// notice (days before) sent for the current date, 0 = none yet.
	// FilesDeletedAt: when the files were erased (the record and billing
	// stay). The API shows files_delete_at only once a deletion is
	// scheduled (inside the notice window), see projectResponse.
	LastActivityAt  *time.Time `firestore:"last_activity_at,omitempty" json:"-"`
	FilesDeleteAt   *time.Time `firestore:"files_delete_at,omitempty" json:"-"`
	FilesNoticeDays int        `firestore:"files_notice_days,omitempty" json:"-"`
	FilesNoticeAt   *time.Time `firestore:"files_notice_at,omitempty" json:"-"`
	FilesDeletedAt  *time.Time `firestore:"files_deleted_at,omitempty" json:"files_deleted_at,omitempty"`
	// FilesDryRunAt: a dry-run purge (test env) logged what it would
	// erase, so later sweeps stay quiet.
	FilesDryRunAt *time.Time `firestore:"files_dry_run_at,omitempty" json:"-"`
	Pinned        bool       `firestore:"pinned,omitempty" json:"pinned,omitempty"`
	CreatedAt     time.Time  `firestore:"created_at" json:"created_at"`
	UpdatedAt     time.Time  `firestore:"updated_at" json:"updated_at"`
}

// Crop is a picture area in displayed (post-rotation) source pixels.
type Crop struct {
	X int `firestore:"x" json:"x"`
	Y int `firestore:"y" json:"y"`
	W int `firestore:"w" json:"w"`
	H int `firestore:"h" json:"h"`
}

// Repack is one format made from a finished run's stored output (ADR 0137).
type Repack struct {
	Format      string     `firestore:"format"`
	Source      string     `firestore:"source"` // the output it was made from
	RepackID    string     `firestore:"repack_id,omitempty"`
	Status      string     `firestore:"status"` // pending | processing | succeeded | failed
	Key         string     `firestore:"key"`    // where the new file goes
	Error       string     `firestore:"error,omitempty"`
	PriceCents  int64      `firestore:"price_cents"`
	Bytes       int64      `firestore:"bytes,omitempty"`
	Width       int        `firestore:"width,omitempty"`
	Height      int        `firestore:"height,omitempty"`
	Frames      int        `firestore:"frames,omitempty"`
	Level       string     `firestore:"level,omitempty"`
	Attempts    int        `firestore:"attempts"`
	RequestedAt time.Time  `firestore:"requested_at"`
	FinishedAt  *time.Time `firestore:"finished_at,omitempty"`
	// Parts: one repack per output file (a split run has one per part;
	// otherwise one, index 0). The format is done when every part is.
	// Records from before parts keep RepackID/Key above.
	Parts []RepackPart `firestore:"parts,omitempty"`
}

// RepackPart is one output file's repack.
type RepackPart struct {
	Index      int        `firestore:"index"`  // 0 = the run's single file, else the part number
	Name       string     `firestore:"name"`   // the output it becomes (sbs, sbs_part2)
	Source     string     `firestore:"source"` // the output it reads (mvhevc, mvhevc_part2)
	RepackID   string     `firestore:"repack_id,omitempty"`
	Status     string     `firestore:"status"` // pending | processing | succeeded | failed
	Key        string     `firestore:"key"`
	Error      string     `firestore:"error,omitempty"`
	Bytes      int64      `firestore:"bytes,omitempty"`
	Width      int        `firestore:"width,omitempty"`
	Height     int        `firestore:"height,omitempty"`
	Frames     int        `firestore:"frames,omitempty"`
	Level      string     `firestore:"level,omitempty"`
	FinishedAt *time.Time `firestore:"finished_at,omitempty"`
}
