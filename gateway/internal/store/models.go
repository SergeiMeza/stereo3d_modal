// Package store: Firestore persistence for conversions, customers, and
// pricing config. The conversions collection is the support database — one
// document traces a ticket end-to-end (params ↔ Stripe ↔ Modal ↔ error).
package store

import "time"

// Conversion states. State only advances server-side (webhook, reconciler,
// or user cancel); the client is a pure observer.
const (
	StateCreated    = "created"    // record + PaymentIntent exist; awaiting payment confirmation
	StatePaid       = "paid"       // funds held; awaiting Modal submission
	StateProcessing = "processing" // Modal job running
	StateSucceeded  = "succeeded"  // outputs published; hold captured
	StateFailed     = "failed"     // pipeline failed; hold canceled
	StateCanceled   = "canceled"   // user canceled; hold canceled
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
	CustomerID      string     `firestore:"customer_id" json:"customer_id"`
	PaymentIntentID string     `firestore:"payment_intent_id" json:"payment_intent_id"`
	PIStatus        string     `firestore:"pi_status,omitempty" json:"pi_status,omitempty"`
	CapturedCents   int64      `firestore:"captured_cents,omitempty" json:"captured_cents,omitempty"`
	CapturedAt      *time.Time `firestore:"captured_at,omitempty" json:"captured_at,omitempty"`
	CanceledAt      *time.Time `firestore:"canceled_at,omitempty" json:"canceled_at,omitempty"`
	// SettleError records a capture/cancel failure for support follow-up
	// (e.g. hold expired before capture). Never blocks the job result.
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
	StripeCustomerID string    `firestore:"stripe_customer_id"`
	Email            string    `firestore:"email,omitempty"`
	CreatedAt        time.Time `firestore:"created_at"`
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
	Crop         string        `firestore:"crop,omitempty" json:"crop,omitempty"`
	PreviewURL   string        `firestore:"preview_url,omitempty" json:"preview_url,omitempty"` // frame-exact h264 proxy (browser playback)
	StripThumbs  []Thumb       `firestore:"strip_thumbs,omitempty" json:"strip_thumbs,omitempty"`
	SceneThumbs  []Thumb       `firestore:"scene_thumbs,omitempty" json:"scene_thumbs,omitempty"`
	Archived     bool          `firestore:"archived" json:"archived"`
	Pinned       bool          `firestore:"pinned,omitempty" json:"pinned,omitempty"`
	CreatedAt    time.Time     `firestore:"created_at" json:"created_at"`
	UpdatedAt    time.Time     `firestore:"updated_at" json:"updated_at"`
}
