// Package store: Firestore persistence for conversions, customers, and
// pricing config. The conversions collection is the support database — one
// document traces a ticket end-to-end (params ↔ Stripe ↔ Modal ↔ error).
package store

import "time"

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
)

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
)

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
}

// Params is the clamped, whitelisted subset forwarded to Modal. Trim and
// scene cuts are integer SOURCE-frame indices, half-open — never seconds
// (frame doctrine, web/DESIGN.md).
type Params struct {
	Preset       string   `firestore:"preset" json:"preset"`
	Formats      []string `firestore:"formats" json:"formats"`
	Displacement float64  `firestore:"displacement,omitempty" json:"displacement,omitempty"` // legacy global knob (POST /v1/conversions only)
	TargetFPS    float64  `firestore:"target_fps,omitempty" json:"target_fps,omitempty"`
	FromFrame    int      `firestore:"from_frame,omitempty" json:"from_frame,omitempty"`
	ToFrame      int      `firestore:"to_frame,omitempty" json:"to_frame,omitempty"`
	Inpaint      string   `firestore:"inpaint,omitempty" json:"inpaint,omitempty"` // "" = pipeline default; pro steps set it explicitly
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
	ClientSecret  string     `firestore:"client_secret,omitempty" json:"-"`
	PIStatus      string     `firestore:"pi_status,omitempty" json:"pi_status,omitempty"`
	CapturedCents int64      `firestore:"captured_cents,omitempty" json:"captured_cents,omitempty"`
	CapturedAt    *time.Time `firestore:"captured_at,omitempty" json:"captured_at,omitempty"`
	CanceledAt    *time.Time `firestore:"canceled_at,omitempty" json:"canceled_at,omitempty"`
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
}

type Error struct {
	Code        string `firestore:"code" json:"code"`
	UserMessage string `firestore:"user_message" json:"user_message"`
	// Internal detail (full Modal error) — logged and stored, never serialized
	// to clients.
	InternalMessage string `firestore:"internal_message" json:"-"`
}

type Conversion struct {
	ID        string            `firestore:"-" json:"conversion_id"`
	UID       string            `firestore:"uid" json:"-"`
	Env       string            `firestore:"env" json:"-"`
	State     string            `firestore:"state" json:"state"`
	Kind      string            `firestore:"kind" json:"kind"`                                 // "video" | "image"
	ProjectID string            `firestore:"project_id,omitempty" json:"project_id,omitempty"` // pro pipeline
	Step      string            `firestore:"step,omitempty" json:"step,omitempty"`
	ScenesVer int               `firestore:"scenes_version,omitempty" json:"scenes_version,omitempty"`
	Client    Client            `firestore:"client" json:"client,omitempty"`
	Source    Source            `firestore:"source" json:"source"`
	Params    Params            `firestore:"params" json:"params"`
	Quote     Quote             `firestore:"quote" json:"quote"`
	Stripe    Stripe            `firestore:"stripe" json:"-"`
	Modal     Modal             `firestore:"modal" json:"modal"`
	Outputs   map[string]string `firestore:"outputs,omitempty" json:"-"` // name → gcs key; clients fetch signed URLs
	Error     *Error            `firestore:"error,omitempty" json:"error,omitempty"`
	IdemKey   string            `firestore:"idem_key,omitempty" json:"-"`
	CreatedAt time.Time         `firestore:"created_at" json:"created_at"`
	UpdatedAt time.Time         `firestore:"updated_at" json:"updated_at"`
}

type Customer struct {
	StripeCustomerID string `firestore:"stripe_customer_id"`
	Email            string `firestore:"email,omitempty"`
	// Cached default payment method (refreshed from Stripe by GET
	// /v1/billing). The conversion-create gate reads this cache — a stale
	// "has card" is caught by the post-success charge, whose failure blocks
	// further paid steps.
	DefaultPaymentMethod string    `firestore:"default_payment_method,omitempty"`
	CardBrand            string    `firestore:"card_brand,omitempty"`
	CardLast4            string    `firestore:"card_last4,omitempty"`
	CardExpMonth         int64     `firestore:"card_exp_month,omitempty"`
	CardExpYear          int64     `firestore:"card_exp_year,omitempty"`
	CardUpdatedAt        time.Time `firestore:"card_updated_at,omitempty"`
	CreatedAt            time.Time `firestore:"created_at"`
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
	ID           string        `firestore:"-" json:"project_id"`
	UID          string        `firestore:"uid" json:"-"`
	Env          string        `firestore:"env" json:"-"`
	Name         string        `firestore:"name,omitempty" json:"name,omitempty"`
	Source       Source        `firestore:"source" json:"source"`
	Probe        *Probe        `firestore:"probe,omitempty" json:"probe,omitempty"`
	Analyze      Analyze       `firestore:"analyze" json:"analyze"`
	Scenes       *Scenes       `firestore:"scenes,omitempty" json:"scenes,omitempty"`
	SceneProfile *SceneProfile `firestore:"scene_profile,omitempty" json:"scene_profile,omitempty"`
	Profile      *ProfileJob   `firestore:"profile,omitempty" json:"profile,omitempty"`
	DepthUpload  *DepthUpload  `firestore:"depth_upload,omitempty" json:"depth_upload,omitempty"`
	Crop         string        `firestore:"crop,omitempty" json:"crop,omitempty"`
	PreviewURL   string        `firestore:"preview_url,omitempty" json:"preview_url,omitempty"` // frame-exact h264 proxy (browser playback)
	StripThumbs  []Thumb       `firestore:"strip_thumbs,omitempty" json:"strip_thumbs,omitempty"`
	SceneThumbs  []Thumb       `firestore:"scene_thumbs,omitempty" json:"scene_thumbs,omitempty"`
	Archived     bool          `firestore:"archived" json:"archived"`
	Pinned       bool          `firestore:"pinned,omitempty" json:"pinned,omitempty"`
	CreatedAt    time.Time     `firestore:"created_at" json:"created_at"`
	UpdatedAt    time.Time     `firestore:"updated_at" json:"updated_at"`
}
