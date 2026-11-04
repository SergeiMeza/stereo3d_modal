// Package pricing computes server-side quotes. Rates live in Firestore
// (config/pricing_{env}) so they can be tuned without a deploy; code defaults
// apply when the doc is absent. The client never supplies price inputs —
// duration/frames come from ffprobe on the uploaded object.
package pricing

import (
	"context"
	"fmt"
	"math"
	"slices"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
)

type Rates struct {
	RateVersion string `firestore:"rate_version"`
	Currency    string `firestore:"currency"`
	// CostMarginMultiplier: every per-minute rate below is ~1× BILLED
	// Modal cost; quotes multiply by this margin. 3× by default: failed
	// and canceled jobs are never charged, so successful runs must carry
	// that risk (plus retries, cold starts, and support time). Tune in
	// Firestore without touching the cost tables.
	CostMarginMultiplier float64 `firestore:"cost_margin_multiplier"`
	// Per-preset video COST (~1× billed), production + legacy mobile flow.
	CentsPerMinute map[string]int64 `firestore:"cents_per_minute"`
	// ImageCents: price of one still past the free daily allowance. Paid
	// stills are metered like video — they join the account's batch and
	// are charged after the fact (App Review treats prepaid credits as a
	// consumable IAP, so the 2026-09-02 photo packs were withdrawn the
	// same day; 5¢ keeps the pack's effective per-photo price). A single
	// still is far below Stripe's minimum charge, which is why it is
	// never charged on its own (see MinimumCents and the batch rollover).
	ImageCents int64 `firestore:"image_cents"`
	// FreeImagesPerDay: stills within this per-user daily allowance are
	// free (mobile product decision, 2026-09-01); past it, ImageCents
	// applies. 0 disables the free tier.
	FreeImagesPerDay int   `firestore:"free_images_per_day"`
	MinimumCents     int64 `firestore:"minimum_cents"`
	// ProMinimumCents floors every paid pro-step run of both methods
	// (S3D-17: $1.00); PreviewMinimumCents can set previews apart (both
	// 100 by default). MinimumCents (50) stays the mobile one-shot's floor
	// and the smallest grouped charge, so shipped apps don't change.
	ProMinimumCents     int64 `firestore:"pro_minimum_cents"`
	PreviewMinimumCents int64 `firestore:"preview_minimum_cents"`
	// Batched billing (charge-on-success steps accumulate into one charge
	// per account — a burst of small same-merchant charges is what issuer
	// fraud rules block). BatchTiers pick the per-batch cap AND window
	// from the user's lifetime collected spend (S3D-19: a proven card
	// earns a longer, larger tab); a charge that failed within
	// BatchFailureLookbackDays drops the account to the first tier.
	// BatchWindowHours, when set, overrides every tier's window with one
	// flat window (the test env runs 0.25 h); unset, each tier has its own
	// window_hours (tiers without one keep their default). Fractional hours are fine. BatchOneShot extends
	// batching to the mobile one-shot flow (off until the mobile contract
	// catches up).
	BatchWindowHours         float64     `firestore:"batch_window_hours"`
	BatchTiers               []BatchTier `firestore:"batch_tiers"`
	BatchFailureLookbackDays int         `firestore:"batch_failure_lookback_days"`
	BatchOneShot             bool        `firestore:"batch_one_shot"`
	// MinBillableSeconds floors the one-shot (mobile) video quote: a clip
	// shorter than this is priced as this long (product decision
	// 2026-09-02 — short clips were pricing at the 50¢ floor, and a
	// conversion's real cost is dominated by the fixed per-job work). The
	// pro steps keep exact billable seconds. 0 disables.
	MinBillableSeconds float64 `firestore:"min_billable_seconds"`
	// 10% off carts over $10, mirroring the old app.
	DiscountThresholdCents int64   `firestore:"discount_threshold_cents"`
	DiscountPct            float64 `firestore:"discount_pct"`

	// Pro step pipeline (web/DESIGN.md), COST basis (~1× billed) like
	// CentsPerMinute. Depth previews are flat per-minute (the depth factor
	// carries the resolution scaling); stereo previews are PER-PRESET like
	// production — the preview does the same splat/inpaint work as
	// production at that preset, so a flat rate underpriced 4k by ~2×.
	DepthPreviewCentsPerMinute  int64            `firestore:"depth_preview_cents_per_minute"`
	StereoPreviewCentsPerMinute map[string]int64 `firestore:"stereo_preview_cents_per_minute"`
	// AnalyzeCreditCents: an optional discount on the project's first paid
	// conversion, historically "the free analyze step's cost credited
	// back". 0 since 2026-08-31: analysis is simply free — no credit line
	// in quotes, no credit chip in the UI. The consume/restore plumbing
	// stays (a >0 Firestore override re-enables it end to end).
	AnalyzeCreditCents int64 `firestore:"analyze_credit_cents"`
	// StageShares: fraction of a production run's price attributable to a
	// stage — the reuse discount when that stage's artifact is cached. The
	// depth share also scopes the depth_res multiplier for
	// stereo_preview/production (depth_preview is 100% depth work).
	StageShares map[string]float64 `firestore:"stage_shares"`
	// DepthResBase: the depth_res that prices at 1× on a 16:9 source. The
	// depth factor is LINEAR IN WORKING MEGAPIXELS (depth_res² × elongation),
	// relative to base MP = depth_res_base² × 16/9. On a 16:9 source that is
	// exactly the old (depth_res/base)² quadratic; on wide/portrait sources
	// it prices the real work (docs/PRICING.md: measured $/frame tracks
	// working MP ~linearly ACROSS GPU tiers — L40S d980@1.71MP ≈ $0.00045/f,
	// B200 d2100@7.84MP ≈ $0.00201/f: 4.6× MP ≈ 4.5× cost).
	DepthResBase float64 `firestore:"depth_res_base"`
	// DepthFactorCeiling clamps the depth factor. 8.5 working MP (the B200
	// fail-fast ceiling) / 1.71 base MP ≈ 4.98, so 5.0 spans the whole
	// physically runnable range.
	DepthFactorCeiling float64 `firestore:"depth_factor_ceiling"`
	// InpaintMultiplier scales a stereo_preview subtotal when
	// inpaint=propainter. Production rates already include inpainting.
	InpaintMultiplier float64 `firestore:"inpaint_multiplier"`
	// MiganPreviewMultiplier / MiganProductionMultiplier price the
	// inpaint="migan" middle ground (per-frame MI-GAN fill on the L4 lite
	// tier — filled edges at near raw-warp cost, no temporal model):
	// stereo_preview pays a little over the splatted baseline (×1.15 vs
	// ProPainter's ×1.6); production discounts to ×0.5 — above backward's
	// ×0.4, keeping none < migan < propainter in both steps. Cost basis:
	// the lite tier runs MI-GAN as ~30 MB/frame of extra work over a raw
	// warp (staging 2026-09-01). 0/missing → defaults, never 1× silently.
	MiganPreviewMultiplier    float64 `firestore:"migan_preview_multiplier"`
	MiganProductionMultiplier float64 `firestore:"migan_production_multiplier"`
	// ProductionNoInpaintMultiplier scales a PRODUCTION subtotal (and its
	// ETA residual) when inpaint=none — today that means warp=backward
	// ("Stretched edges": one gather pass, no ProPainter), which the
	// gateway forces to inpaint none. Production rates bake ProPainter in,
	// so without this a backward-warp render billed the full inpainted rate
	// for seconds of GPU. Applied to the WHOLE subtotal like the preview
	// knob (simple, explainable; the depth share is slightly over-
	// discounted). 0.4 (was 0.6 for a day): the backward-warp tier runs on an
	// L4 with NVENC — job 73e91a7e50f5 (3k, 2026-08-31) billed $2.10 on the
	// old H200 routing and projects to ~$0.25 on the lite tier, so even 0.4
	// is ~10× cost at 3k; revisit against billed lite-tier runs
	// (docs/PRICING.md). 0/missing → the default, never 1× silently.
	ProductionNoInpaintMultiplier float64 `firestore:"production_no_inpaint_multiplier"`

	// Abuse caps enforced at conversion create.
	MaxDurationS     float64 `firestore:"max_duration_s"`
	MaxSourceBytes   int64   `firestore:"max_source_bytes"`
	MaxActivePerUser int     `firestore:"max_active_per_user"`

	// Beta source caps, enforced when the analyze probe lands (project
	// creation can't see duration/resolution — only the probe can): videos
	// longer than MaxSourceDurationS or with a frame area exceeding
	// MaxSourcePixels are rejected before any paid work. 0 disables a
	// cap.
	MaxSourceDurationS float64 `firestore:"max_source_duration_s"`
	MaxSourcePixels    int     `firestore:"max_source_pixels"`

	// MaxGPUWorkers caps the concurrent fan-out containers one video job's
	// depth/stereo chunks may occupy (app/pipelines/video.py, default 4
	// there). More workers = same GPU-seconds, less wall-clock; the
	// workspace concurrency ceiling is 10 GPUs, so this stays below it to
	// leave room for other jobs. 0 omits the field (pipeline default).
	MaxGPUWorkers int `firestore:"max_gpu_workers"`

	// Pre-run wall-clock estimate model (shown next to quotes; the live
	// number always comes from the running Modal job). ADDITIVE:
	// eta = base + depth term + preset-keyed stereo/encode residual —
	// see EstimateStepETA. EtaFactor keys: "depth" (the inference term,
	// scaled by the same depth_res factor as pricing; zeroed when the
	// artifact is reused or user-provided) and "<step>_<preset>" residuals
	// with a bare "<step>" fallback; the stereo_preview residual is
	// multiplied by inpaint_multiplier.
	// ETA residual scales for the lite-tier inpaint modes — see
	// etaResidualScale (wall-time anchors, decoupled from price).
	EtaMiganScale   float64            `firestore:"eta_migan_scale"`
	EtaRawWarpScale float64            `firestore:"eta_raw_warp_scale"`
	EtaBaseSeconds  map[string]float64 `firestore:"eta_base_seconds"`
	EtaFactor       map[string]float64 `firestore:"eta_factor"`

	// Lifelike 3D (2026-11-03, the shared lifelike3d service). Every key
	// may be absent: the accessors below fall back to the code defaults, so
	// nothing changes before the config doc is written.
	//
	// LifelikeMaxSourceDurationS caps Lifelike sources; 0 = unlimited
	// (LL-D6). max_source_duration_s stays the Classic cap.
	LifelikeMaxSourceDurationS float64 `firestore:"lifelike_max_source_duration_s"`
	// LifelikeMaxGPUWorkers: GPU containers one Lifelike job may use at
	// once (default 4; clamped to MaxGPUWorkersPerJob like Classic's).
	LifelikeMaxGPUWorkers int `firestore:"lifelike_max_gpu_workers"`
	// Lifelike Express (2026-11-03, Lifelike team): Express runs ask for
	// LifelikeExpressGPUWorkers (default 8, clamped) and go first in the
	// slot scheduler. LifelikeExpressCostFactor (default 1.12) is the
	// measured GPU cost of 8 vs 4 GPUs, for cost reporting.
	// LifelikeExpressMaxWaitS (default 420): the longest an Express job may
	// wait for a running standard piece to finish (4K, 3-min piece).
	// LifelikeIntroEnabled sends the brand intro (BL-25: intro_s 3 on
	// previews, 4 otherwise, intro_language) on Lifelike runs. Code
	// default false until the pipeline's API is live on test.
	LifelikeIntroEnabled      bool    `firestore:"lifelike_intro_enabled"`
	LifelikeExpressGPUWorkers int     `firestore:"lifelike_express_gpu_workers"`
	LifelikeExpressCostFactor float64 `firestore:"lifelike_express_cost_factor"`
	LifelikeExpressMaxWaitS   int     `firestore:"lifelike_express_max_wait_s"`
	// PrechargeThresholdCents: pro-step quotes ABOVE this are charged
	// before the run starts and refunded in full if it fails (LL-D8, both
	// methods); at or below it they join the batch and are billed after.
	PrechargeThresholdCents int64 `firestore:"precharge_threshold_cents"`
	// LifelikePriceCentsPerMinute: Lifelike's own PRICE per output minute
	// at 24 fps, per preset (no margin applied; see QuoteLifelike).
	LifelikePriceCentsPerMinute map[string]int64 `firestore:"lifelike_price_cents_per_minute"`
	// LifelikePreview: the preview's length rules in source seconds (S3D-13:
	// 2-10 s, 5 by default). Zero values use those defaults.
	LifelikePreview PreviewSeconds `firestore:"lifelike_preview"`
	// LifelikeMaxSourceBytes caps a Lifelike source file (S3D-42);
	// max_source_bytes stays Classic's. 0/absent = 25 GiB.
	LifelikeMaxSourceBytes int64 `firestore:"lifelike_max_source_bytes"`
	// FoveationEnabled switches the Lifelike "foveation: static" option on
	// (S3D-50; off by default while its delivery format is worked out);
	// FoveationPriceMultiplier scales a foveated run's price (1.3).
	FoveationEnabled bool `firestore:"foveation_enabled"`
	// LifelikeSourceCropEnabled: Lifelike runs take black bars off
	// (source_crop on /convert, BL-03) and are sized and priced on the
	// picture inside. Code default off; on for test, where Lifelike
	// ignores the key until it ships it.
	LifelikeSourceCropEnabled bool `firestore:"lifelike_source_crop_enabled"`
	// LifelikeHDROutputEnabled: Lifelike runs from HDR sources get HDR
	// output (hdr_output on /convert), automatic and free for everyone
	// (owner 2026-11-05). Code default off on test and prod; while off
	// projects don't show the source's dynamic range.
	LifelikeHDROutputEnabled bool `firestore:"lifelike_hdr_output_enabled"`
	// GPUCapPerApp: GPUs each pipeline app may hold at once (the Modal
	// coordinators enforce it; the GPU-line alert reports usage against
	// it). 0/absent = 8.
	GPUCapPerApp int `firestore:"gpu_cap_per_app"`
	// KlarnaMarkets: countries where the sheet offers Klarna (spec v6.2
	// BL-10; empty at launch = never offered). A GB account can take
	// Klarna only from EEA/CH/UK buyers in their own currency.
	KlarnaMarkets []string `firestore:"klarna_markets"`
	// TaxMode (C7, BL-07): "off" (default, launch) | "inclusive" —
	// invoices get automatic tax, prices unchanged.
	TaxMode string `firestore:"tax_mode"`
	// Pro discount (S3D-67): Spatial Video Studio Pro customers get
	// pro_discount_pct off every paid web run (production, both methods;
	// not previews), before the bulk discount; the per-run minimum stays.
	// Off unless pro_discount_enabled (test defaults it on).
	ProDiscountEnabled bool    `firestore:"pro_discount_enabled"`
	ProDiscountPct     float64 `firestore:"pro_discount_pct"`
	// GPUCapPerWorkspace overrides it per Modal workspace id (S3D-40).
	GPUCapPerWorkspace map[string]int `firestore:"gpu_cap_per_workspace"`
	// File keeping (S3D-24), see the accessors: days without use before a
	// project's files go (90), the notice mails' days before (14, 3), days
	// a deleted project's files are kept for disputes (30).
	FileKeepDays            int   `firestore:"file_keep_days"`
	FileNoticeDays          []int `firestore:"file_notice_days"`
	DeletedProjectPurgeDays int   `firestore:"deleted_project_purge_days"`
	// LifelikeEnabledPresets: the Lifelike sizes the service renders
	// today (see EnabledLifelikePresets).
	LifelikeEnabledPresets   []string `firestore:"lifelike_enabled_presets"`
	FoveationPriceMultiplier float64  `firestore:"foveation_price_multiplier"`
	// LifelikeETA is the Lifelike wall-clock model — see
	// EstimateLifelikeETA.
	LifelikeETA LifelikeETA `firestore:"lifelike_eta"`

	// 2026-11 pricing (tiers.go; test only until the owner's go for prod).
	// TierPricing: subscriber tiers, add-ons and the never-stacked bulk.
	TierPricing        bool                        `firestore:"tier_pricing"`
	LifelikeTierPrices map[string]map[string]int64 `firestore:"lifelike_tier_prices"`
	TierPctOverride    map[string]float64          `firestore:"tier_pct"`
	AddOnPctOverride   map[string]float64          `firestore:"addon_pct"`
	PlansEnabled       bool                        `firestore:"plans_enabled"`
	Plans              map[string]PlanDef          `firestore:"plans"`
	// ProPlans: web Pro on our own Stripe (owner 2026-11-04), by plan id
	// (pro_weekly | pro_monthly | pro_yearly); behind PlansEnabled.
	ProPlans               map[string]ProPlanDef `firestore:"pro_plans"`
	FreePreviewsEnabled    bool                  `firestore:"free_previews_enabled"`
	FreePreviewsOverride   map[string]int        `firestore:"free_previews"`
	FreePreviewsPerDay     int                   `firestore:"free_previews_per_day"`
	FreePreviewUnitSeconds float64               `firestore:"free_preview_unit_s"`
}

// MaxGPUWorkersPerJob clamps every job's max_gpu_workers: each app is held
// to 8 GPUs at once (the Modal coordinators enforce the app-wide cap), so a
// fat-fingered config value can't ask for more than the whole app has.
const MaxGPUWorkersPerJob = 8

// LifelikeETA: eta = overhead + render_gpu_s_per_minute × output minutes
// (at 24 fps; frames scale it) / GPUs + a flat encode tail. The Spatial 3D
// Studio team's numbers on test (ml-sharp-modal ADR-0019 § Estimates): the
// encode now runs in parallel chunks, so production's tail after rendering
// is ~150 s whatever the length (encode_tail_s); a preview encodes inline
// in its one container (~27 s measured; preview_tail_s). Zero or missing
// values use the defaults. The model has no per-preset term (conversion,
// not output size, dominates a unit — ADR-0019), so 5k/6k/8k (S3D-48) use
// it as measured at 4K until Spatial 3D Studio measures them.
type LifelikeETA struct {
	RenderGPUSecondsPerMinute float64 `firestore:"render_gpu_s_per_minute"`
	OverheadSeconds           float64 `firestore:"overhead_s"`
	EncodeTailSeconds         float64 `firestore:"encode_tail_s"`
	PreviewTailSeconds        float64 `firestore:"preview_tail_s"`
}

func defaultLifelikeETA() LifelikeETA {
	return LifelikeETA{
		RenderGPUSecondsPerMinute: 530,
		OverheadSeconds:           45,
		EncodeTailSeconds:         150,
		PreviewTailSeconds:        30,
	}
}

// MaxSourceDurationFor is the source-length cap of a method (0 = none).
func (r *Rates) MaxSourceDurationFor(method string) float64 {
	if method == "lifelike" {
		return max(r.LifelikeMaxSourceDurationS, 0)
	}
	return r.MaxSourceDurationS
}

// GPUWorkersFor is the max_gpu_workers a job of the method is submitted
// with, clamped to MaxGPUWorkersPerJob. 0 for classic means "omit the
// field" (the pipeline's own default), as before.
func (r *Rates) GPUWorkersFor(method string) int {
	n := r.MaxGPUWorkers
	if method == "lifelike" {
		n = r.LifelikeMaxGPUWorkers
		if n <= 0 {
			n = 4
		}
	}
	return min(n, MaxGPUWorkersPerJob)
}

// ExpressGPUWorkers is max_gpu_workers for an Express Lifelike run.
func (r *Rates) ExpressGPUWorkers() int {
	n := r.LifelikeExpressGPUWorkers
	if n <= 0 {
		n = 8
	}
	return min(n, MaxGPUWorkersPerJob)
}

// ExpressCostFactor is Express's GPU cost relative to a standard run.
func (r *Rates) ExpressCostFactor() float64 {
	if r.LifelikeExpressCostFactor > 0 {
		return r.LifelikeExpressCostFactor
	}
	return 1.12
}

// ExpressMaxWaitS is the longest an Express job may wait for a GPU slot.
func (r *Rates) ExpressMaxWaitS() int {
	if r.LifelikeExpressMaxWaitS > 0 {
		return r.LifelikeExpressMaxWaitS
	}
	return 420
}

// PreviewSeconds bounds a Lifelike preview's span.
type PreviewSeconds struct {
	MinS     float64 `firestore:"min_s" json:"min_s"`
	MaxS     float64 `firestore:"max_s" json:"max_s"`
	DefaultS float64 `firestore:"default_s" json:"default_s"`
}

// LifelikePreviewSeconds is the preview length rule with defaults filled in.
func (r *Rates) LifelikePreviewSeconds() PreviewSeconds {
	p := r.LifelikePreview
	if p.MinS <= 0 {
		p.MinS = 2
	}
	if p.MaxS <= 0 {
		p.MaxS = 10
	}
	if p.DefaultS <= 0 {
		p.DefaultS = 5
	}
	return p
}

// MaxSourceBytesFor is the source-file cap of a method.
func (r *Rates) MaxSourceBytesFor(method string) int64 {
	if method == "lifelike" {
		if r.LifelikeMaxSourceBytes > 0 {
			return r.LifelikeMaxSourceBytes
		}
		return 25 << 30
	}
	return r.MaxSourceBytes
}

// PrechargeThreshold is the quote above which a pro step is charged up
// front.
func (r *Rates) PrechargeThreshold() int64 {
	if r.PrechargeThresholdCents > 0 {
		return r.PrechargeThresholdCents
	}
	return 2500
}

// Defaults: the per-minute tables are ≈1× BILLED Modal cost (billed runs
// ~1.2× the in-source per-stage estimates — cold-start + idle, PRICING.md
// "Estimate vs billed"), and CostMarginMultiplier is the ONE margin knob
// applied to every quote. Cost anchors, both measured 2026-07-03:
//   - depth: job 4cd27aa0aaee — 149.5s 4K 2.39:1 @24fps, depth_res 1596
//     (factor 3.57) → $5.59 estimated ≈ $6.7 billed → 75¢/min × 3.57.
//   - 4k stereo: job c51480d2c0aa — billed $14.31 to 78% incl. OOM
//     retries; a clean run projects $11–13 billed for 2.5 min of footage
//     → 250¢/min × 1.6 inpaint ≈ $10 cost per 2.5 min.
//
// Tune the tables in Firestore as clean billed/estimate pairs accumulate.
// BatchTier: users whose lifetime collected spend is at least MinPaidCents
// accumulate up to CapCents per batch before an automatic charge. The
// highest qualifying tier wins.
type BatchTier struct {
	MinPaidCents int64   `firestore:"min_paid_cents" json:"min_paid_cents"`
	CapCents     int64   `firestore:"cap_cents" json:"cap_cents"`
	WindowHours  float64 `firestore:"window_hours" json:"window_hours"`
}

// BatchTierFor is the tier a user batches under: the highest one their
// collected spend reaches, or the first when a charge of theirs failed
// recently (S3D-19: the longer, larger tab is for a good paid record; a
// failure drops both window and cap back to a new account's). WindowHours
// is always filled in (see Rates.BatchWindowHours).
func (r *Rates) BatchTierFor(lifetimePaid int64, failedRecently bool) BatchTier {
	tiers := r.BatchTiers
	if len(tiers) == 0 {
		tiers = defaults().BatchTiers[:1] // no tiers configured: the base one
	}
	best, base := BatchTier{}, BatchTier{MinPaidCents: -1}
	for _, t := range tiers {
		if base.MinPaidCents < 0 || t.MinPaidCents < base.MinPaidCents {
			base = t
		}
		if lifetimePaid >= t.MinPaidCents && t.CapCents > best.CapCents {
			best = t
		}
	}
	if failedRecently || best.CapCents <= 0 {
		best = base
	}
	if best.CapCents <= 0 {
		best = defaults().BatchTiers[0]
	}
	if r.BatchWindowHours > 0 {
		best.WindowHours = r.BatchWindowHours // flat override (test env)
	}
	if best.WindowHours <= 0 {
		best.WindowHours = defaultTierWindow(best.MinPaidCents)
	}
	return best
}

// defaultTierWindow is the default window of the default tier a spend
// threshold falls in (config tiers written before window_hours existed).
func defaultTierWindow(minPaid int64) float64 {
	h := 1.0
	for _, t := range defaults().BatchTiers {
		if minPaid >= t.MinPaidCents {
			h = t.WindowHours
		}
	}
	return h
}

// Window is the tier's batch window.
func (t BatchTier) Window() time.Duration {
	return time.Duration(t.WindowHours * float64(time.Hour))
}

// FailureLookback is how far back a failed charge drops an account to
// the first tier (default 90 days).
func (r *Rates) FailureLookback() time.Duration {
	d := r.BatchFailureLookbackDays
	if d <= 0 {
		d = 90
	}
	return time.Duration(d) * 24 * time.Hour
}

// BatchCap returns the batch cap for a user with lifetimePaid cents
// collected so far: the highest tier whose threshold is met. Never below
// the base tier. (The mobile hold threshold; batching itself goes through
// BatchTierFor.)
func (r *Rates) BatchCap(lifetimePaid int64) int64 {
	return r.BatchTierFor(lifetimePaid, false).CapCents
}

// NextBatchTier returns the next tier above the user's current cap, or
// nil at the top tier — for the "spend $X more to unlock" hint.
func (r *Rates) NextBatchTier(lifetimePaid int64) *BatchTier {
	current := r.BatchCap(lifetimePaid)
	var next *BatchTier
	for i := range r.BatchTiers {
		t := &r.BatchTiers[i]
		if t.CapCents > current && lifetimePaid < t.MinPaidCents && (next == nil || t.MinPaidCents < next.MinPaidCents) {
			next = t
		}
	}
	return next
}

// BatchWindow is a new account's batch window (the first tier's).
func (r *Rates) BatchWindow() time.Duration {
	return r.BatchTierFor(0, false).Window()
}

func defaults() *Rates {
	return &Rates{
		RateVersion:          "2026-07-03.v2-cost-margin",
		Currency:             "usd",
		CostMarginMultiplier: 3.0,
		CentsPerMinute: map[string]int64{
			"draft": 120, "1080p": 150, "qhd": 210, "3k": 240, "4k": 300,
		},
		ImageCents:         5,
		FreeImagesPerDay:   100,
		MinBillableSeconds: 60,
		// Exposure per batch ≈ cap + one step (the closing step lands in
		// the same charge); the tiers grow it with collected revenue.
		BatchTiers: []BatchTier{
			{MinPaidCents: 0, CapCents: 5000, WindowHours: 1},         // new accounts: $50, 1 h
			{MinPaidCents: 20000, CapCents: 15000, WindowHours: 4},    // $200 collected: $150, 4 h
			{MinPaidCents: 100000, CapCents: 40000, WindowHours: 12},  // $1,000 collected: $400, 12 h
			{MinPaidCents: 500000, CapCents: 100000, WindowHours: 24}, // $5,000 collected: $1,000, 24 h
		},
		MinimumCents:               50, // Stripe practical minimum
		DiscountThresholdCents:     1000,
		DiscountPct:                0.10,
		DepthPreviewCentsPerMinute: 75,
		// Splatted-baseline COST per preset; the ×1.6 inpaint multiplier
		// applies on top for propainter.
		StereoPreviewCentsPerMinute: map[string]int64{
			"draft": 90, "1080p": 120, "qhd": 160, "3k": 200, "4k": 250,
		},
		AnalyzeCreditCents: 0, // analysis is free outright; no credit-back
		StageShares:        map[string]float64{"depth": 0.35, "preprocess": 0.05},
		DepthResBase:       980,
		DepthFactorCeiling: 5.0,
		InpaintMultiplier:  1.6,
		// production with inpaint=none (backward warp): ×0.4, see field doc
		ProductionNoInpaintMultiplier: 0.4,
		MiganPreviewMultiplier:        1.15,
		MiganProductionMultiplier:     0.5,
		MaxDurationS:                  30 * 60,
		MaxSourceBytes:                8 << 30,
		MaxActivePerUser:              3,
		MaxSourceDurationS:            10 * 60,     // beta: 10-minute videos
		MaxSourcePixels:               3840 * 2160, // beta: up to a 4K UHD frame (inclusive)
		MaxGPUWorkers:                 8,
		EtaMiganScale:                 0.5,
		EtaRawWarpScale:               0.35,
		EtaBaseSeconds: map[string]float64{
			"depth_preview": 60, "stereo_preview": 90, "production": 120,
		},
		// Additive ETA components (see EstimateStepETA), per billable
		// second. "depth" is the inference term at depth factor 1.0
		// (980 px on 16:9) — anchored on job 4cd27aa0aaee (2026-07-03):
		// 60 + 2.8 × 149.5 × 3.57 ≈ 1552s vs 1584s measured. The
		// stereo/encode residuals are preset-keyed; stereo_preview_4k is
		// anchored on job c51480d2c0aa (2026-07-03): the 4k propainter
		// stereo stage ran ≈45 min for 149.5s billable → 11 × 1.6 ≈ 17.6
		// s/s. The rest interpolate by output pixel area — tune in
		// Firestore as more runs accumulate.
		EtaFactor: map[string]float64{
			"depth": 2.8,
			// stereo_preview residuals (×1.6 inpaint applies on top)
			"stereo_preview":     3.5, // 1080p / fallback
			"stereo_preview_qhd": 5.0, "stereo_preview_3k": 6.0,
			"stereo_preview_4k": 11.0,
			// production residuals (inpainting included)
			"production_draft": 2.0, "production_1080p": 6.0,
			"production_qhd": 8.0, "production_3k": 9.5, "production_4k": 12.0,
			"production": 6.0,
		},
		LifelikeMaxSourceDurationS:  0, // unlimited
		LifelikeMaxGPUWorkers:       4,
		PrechargeThresholdCents:     2500,
		LifelikePriceCentsPerMinute: defaultLifelikePrices(),
		LifelikeMaxSourceBytes:      25 << 30,
		LifelikeETA:                 defaultLifelikeETA(),
	}
}

// etaResidualScale converts an inpaint mode into a WALL-TIME scale on the
// stereo/encode ETA residual. Anchors (docs/RUNLOG.md, 3k 185 s billable,
// depth reused): migan wall 12.1 min vs the residual's 18.5 → ~0.5; a
// post-host-copy-fix raw warp (stretched, and forward inpaint=none)
// projects ~7 min → ~0.35. Firestore-tunable via eta_migan_scale /
// eta_raw_warp_scale; 0/missing falls back to the measured defaults.
func (r *Rates) etaResidualScale(step, inpaint string) float64 {
	pick := func(v, fallback float64) float64 {
		if v > 0 {
			return v
		}
		return fallback
	}
	switch inpaint {
	case "migan":
		return pick(r.EtaMiganScale, 0.5)
	case "none":
		return pick(r.EtaRawWarpScale, 0.35)
	}
	if step == "stereo_preview" && r.InpaintMultiplier > 0 { // propainter preview
		return r.InpaintMultiplier
	}
	return 1.0
}

// margin returns the cost→price multiplier (CostMarginMultiplier), with a
// hard fallback so a zeroed/missing Firestore field can never sell at cost.
func (r *Rates) margin() float64 {
	if r.CostMarginMultiplier > 0 {
		return r.CostMarginMultiplier
	}
	return 3.0
}

// inpaintMultiplier is the ONE inpaint price/ETA adjustment for a step:
// stereo_preview pays ×InpaintMultiplier for propainter (its rates are a
// splatted baseline); production gets ×ProductionNoInpaintMultiplier for
// inpaint=none (its rates bake ProPainter in). Everything else is 1.
func (r *Rates) inpaintMultiplier(step, inpaint string) float64 {
	pick := func(v, fallback float64) float64 {
		if v > 0 {
			return v
		}
		return fallback
	}
	switch {
	case step == "stereo_preview" && inpaint == "propainter" && r.InpaintMultiplier > 0:
		return r.InpaintMultiplier
	case step == "stereo_preview" && inpaint == "migan":
		return pick(r.MiganPreviewMultiplier, 1.15)
	case step == "production" && inpaint == "migan":
		return pick(r.MiganProductionMultiplier, 0.5)
	case step == "production" && inpaint == "none":
		return pick(r.ProductionNoInpaintMultiplier, 0.4)
	}
	return 1.0
}

// fpsBase is the frame rate the per-minute anchors are calibrated at. Cost
// scales with FRAME COUNT (docs/PRICING.md lever #1), so a step's effective
// fps scales its price linearly: a 60 fps source costs 2.5× a 24 fps one
// per minute of footage.
const fpsBase = 24.0

// The fps factor's clamp.
const (
	fpsMinFactor = 0.5
	fpsMaxFactor = 2.5
)

// baseElongation anchors the depth factor's base working MP at 16:9 — the
// aspect the DepthResBase quadratic was originally calibrated on.
const baseElongation = 16.0 / 9.0

func fpsFactor(effectiveFPS float64) float64 {
	if effectiveFPS <= 0 {
		return 1.0
	}
	return math.Min(fpsMaxFactor, math.Max(fpsMinFactor, effectiveFPS/fpsBase))
}

// depthFactor prices the depth work: LINEAR in working megapixels
// (depth_res² × elongation — the same quantity that routes the depth GPU),
// relative to DepthResBase² × 16/9. Equals the legacy (res/base)² quadratic
// on a 16:9 source; wide/portrait sources price their true extra work.
// Measured $/frame tracks working MP ~linearly across GPU tiers (see the
// Rates.DepthResBase comment). Unknown dims fall back to 16:9.
func depthFactor(rates *Rates, depthRes, width, height int) float64 {
	if depthRes <= 0 {
		return 1.0
	}
	base := rates.DepthResBase
	if base <= 0 {
		base = 980 // sane fallback if the config doc zeroes it
	}
	ceiling := rates.DepthFactorCeiling
	if ceiling <= 0 {
		ceiling = 5.0
	}
	elongation := baseElongation
	if width > 0 && height > 0 {
		long := math.Max(float64(width), float64(height))
		short := math.Min(float64(width), float64(height))
		elongation = long / short
	}
	workMP := float64(depthRes) * float64(depthRes) * elongation / 1e6
	baseMP := base * base * baseElongation / 1e6
	return math.Min(ceiling, math.Max(0.5, workMP/baseMP))
}

func round4(f float64) float64 { return math.Round(f*10000) / 10000 }

// StepInputs carries everything that shapes a pro-step quote/ETA. Content
// dims are the POST-CROP frame the depth stage actually works on (a 2.39:1
// film in a 16:9 container prices at 2.39:1); EffectiveFPS is the rate the
// job runs at (target_fps, else the source rate).
type StepInputs struct {
	Step      string
	Preset    string
	BillableS float64
	DepthRes  int
	// Post-crop content dimensions; 0 = unknown → 16:9 assumed.
	ContentWidth, ContentHeight int
	// Frames per second the job renders; 0 = unknown → no fps scaling.
	EffectiveFPS float64
	Inpaint      string
	ReuseStages  []string
	CreditCents  int64
	// Foveated (Lifelike only): priced × FoveationMultiplier.
	Foveated bool
	// Pro: the customer holds SVS Pro (S3D-67): production runs get
	// ProDiscount off before the bulk discount.
	Pro bool
	// Tier pricing (tiers.go): the account's tier, the add-ons, and a
	// free preview (quoted $0, Units free previews used).
	Tier        string
	Master      bool
	Express     bool
	FreePreview bool
	Units       int
}

// EstimateStepETA predicts a step's wall-clock seconds for the quote screen.
// ADDITIVE per-stage model: base + a depth-inference term + a preset-keyed
// stereo/encode residual. The earlier multiplicative model scaled the WHOLE
// estimate by the depth factor and then unwound reuse multiplicatively —
// reuse-heavy quotes only landed near the truth when the two errors
// cancelled — and its stereo_preview factor was preset-blind (a 4k preview
// does ~2× the wall of the 1080p runs it was calibrated on). Here, a reused
// or user-provided depth simply ZEROES the depth term, and the residual
// scales with the output preset. Deliberately coarse — the running job
// reports the live ETA (measured frames/s).
func (s *Service) EstimateStepETA(ctx context.Context, in StepInputs) int64 {
	rates := s.Rates(ctx)
	eta := rates.EtaBaseSeconds[in.Step]
	// wall time scales with frames: fps rides the work terms, not the base
	fps := fpsFactor(in.EffectiveFPS)

	// Depth inference: scales with the working-MP factor. Skipped entirely
	// when the artifact is reused or user-provided (DepthRes 0) — the
	// stage does not run at all.
	if in.DepthRes > 0 && !slices.Contains(in.ReuseStages, "depth") {
		eta += rates.EtaFactor["depth"] * in.BillableS * fps *
			depthFactor(rates, in.DepthRes, in.ContentWidth, in.ContentHeight)
	}

	// Stereo + encode residual: keyed by preset (output resolution drives
	// the splat/inpaint/encode wall time). The inpaint mode then scales the
	// residual by its MEASURED speed, NOT by its price multiplier (which
	// mispredicted migan by 1.9×, job 4a1bca4762d1 2026-09-01): propainter
	// keeps the anchored behavior (×1.6 on previews — the anchors were
	// splat-baseline runs — ×1 on production, whose anchors included it),
	// while migan/none run on the lite tier at a fraction of the anchored
	// wall — see Rates.etaResidualScale. depth_preview has no residual —
	// its base covers publish/encode.
	if in.Step != "depth_preview" {
		factor := rates.EtaFactor[in.Step+"_"+in.Preset]
		if factor <= 0 {
			factor = rates.EtaFactor[in.Step]
		}
		if factor <= 0 {
			factor = 4.0
		}
		eta += factor * in.BillableS * fps * rates.etaResidualScale(in.Step, in.Inpaint)
	}
	// A reused preprocess saves seconds, not minutes — deliberately ignored.
	return int64(math.Round(eta))
}

type Quote struct {
	AmountCents int64
	Currency    string
	RateVersion string
	Breakdown   map[string]any
}

type Service struct {
	fs  *firestore.Client
	env string

	mu        sync.Mutex
	cached    *Rates
	fetchedAt time.Time
}

const cacheTTL = 60 * time.Second

func New(fs *firestore.Client, env string) *Service {
	return &Service{fs: fs, env: env}
}

// NewStatic serves fixed rates without Firestore (tests); nil = the code
// defaults.
func NewStatic(r *Rates) *Service {
	if r == nil {
		r = defaults()
	}
	return &Service{cached: r, fetchedAt: time.Now().Add(100 * 365 * 24 * time.Hour)}
}

// Defaults returns a fresh copy of the code defaults.
func Defaults() *Rates { return defaults() }

// DefaultsFor is the code defaults of an environment: test switches on
// what is being tried there before prod — every Lifelike size including
// 5K-8K, foveation (S3D-50) and the Pro discount (S3D-67). A key in
// config/pricing_{env} still overrides each.
func DefaultsFor(env string) *Rates {
	r := defaults()
	if env == "test" {
		r.LifelikeEnabledPresets = slices.Clone(LifelikePresets)
		r.FoveationEnabled = true
		r.ProDiscountEnabled = true
		r.LifelikeSourceCropEnabled = true // BL-03
		applyTestTierDefaults(r)           // 2026-11 pricing, test only
	}
	return r
}

// ProDiscount is the Pro share off a production run; 0 when switched off.
// pro_discount_pct absent/0 = 0.20, held to [0, 0.9].
func (r *Rates) ProDiscount() float64 {
	if !r.ProDiscountEnabled {
		return 0
	}
	if r.ProDiscountPct > 0 {
		return min(r.ProDiscountPct, 0.9)
	}
	return 0.20
}

// proDiscountCents is the Pro line of a run: production only.
func (r *Rates) proDiscountCents(in StepInputs, subtotal int64) int64 {
	if !in.Pro || in.Step != "production" {
		return 0
	}
	return int64(math.Round(float64(subtotal) * r.ProDiscount()))
}

// Rates returns the current pricing config (60s cache; falls back to code
// defaults if the Firestore doc is missing or malformed).
func (s *Service) Rates(ctx context.Context) *Rates {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cached != nil && time.Since(s.fetchedAt) < cacheTTL {
		return s.cached
	}
	rates := DefaultsFor(s.env)
	snap, err := s.fs.Collection("config").Doc("pricing_" + s.env).Get(ctx)
	if err == nil {
		loaded := *rates // start from defaults so partial docs stay sane
		if err := snap.DataTo(&loaded); err == nil {
			rates = &loaded
		}
	}
	s.cached = rates
	s.fetchedAt = time.Now()
	return rates
}

// PresetInputSize mirrors PRESETS in app/pipelines/video.py: the depth
// input_size a preset runs at when the request carries no explicit
// depth_res — the depth work happens (and must be priced) either way.
var PresetInputSize = map[string]int{
	"draft": 518, "1080p": 980, "qhd": 1148, "3k": 1148, "4k": 1442,
}

// VideoInputs shapes a legacy (mobile-flow) conversion quote. Width/Height
// and FPS come from the gateway's own ffprobe of the upload; zero values
// fall back to 16:9 / no fps scaling.
type VideoInputs struct {
	Preset        string
	BillableS     float64
	Width, Height int
	FPS           float64
	// Inpaint mode ( = propainter-class, the rates' baseline). The
	// one-shot mobile flow passes it so cheap modes (none/migan) price
	// like production does.
	Inpaint string
}

// QuoteVideo prices a legacy video conversion with the SAME physics as the
// pro production step (it runs the same pipeline at the full source rate):
// billable minutes × the preset rate × the fps factor, plus the aspect-aware
// depth factor for the preset's input_size on the 0.35 depth share. Legacy
// uploads have no analyze crop, so dims are the container's.
func (s *Service) QuoteVideo(ctx context.Context, in VideoInputs) (*Quote, error) {
	rates := s.Rates(ctx)
	perMin, ok := rates.CentsPerMinute[in.Preset]
	if !ok {
		return nil, fmt.Errorf("no rate for preset %q", in.Preset)
	}
	// price = cost rate × margin (see CostMarginMultiplier)
	rateCents := float64(perMin) * rates.margin()
	fpsF := fpsFactor(in.FPS)
	billedS := math.Max(in.BillableS, rates.MinBillableSeconds)
	baseCents := int64(math.Ceil(billedS / 60 * rateCents * fpsF))
	subtotal := baseCents
	depthResFactor := 1.0
	depthRes := PresetInputSize[in.Preset]
	if depthRes > 0 {
		depthResFactor = depthFactor(rates, depthRes, in.Width, in.Height)
		subtotal += int64(math.Round(float64(subtotal) * rates.StageShares["depth"] * (depthResFactor - 1)))
	}
	// mode multiplier: the legacy per-minute rates are production-class
	// (ProPainter included), so cheap modes discount exactly like the pro
	// production step (inpaintMultiplier)
	modeMult := rates.inpaintMultiplier("production", in.Inpaint)
	if modeMult != 1.0 {
		subtotal = int64(math.Round(float64(subtotal) * modeMult))
	}
	discount := int64(0)
	if subtotal > rates.DiscountThresholdCents {
		discount = int64(math.Round(float64(subtotal) * rates.DiscountPct))
	}
	total := subtotal - discount
	if total < rates.MinimumCents {
		total = rates.MinimumCents
	}
	return &Quote{
		AmountCents: total,
		Currency:    rates.Currency,
		RateVersion: rates.RateVersion,
		Breakdown: map[string]any{
			"inpaint_multiplier":   modeMult,
			"preset":               in.Preset,
			"billable_seconds":     math.Round(in.BillableS*100) / 100,
			"billed_seconds":       math.Round(billedS*100) / 100, // after the 1-minute floor
			"min_billable_seconds": rates.MinBillableSeconds,
			// the PRICE rate (cost × margin) — what the rate hint shows
			"cents_per_minute":       int64(math.Round(rateCents)),
			"cost_margin_multiplier": rates.margin(),
			"fps_factor":             round4(fpsF),
			"base_cents":             baseCents,
			"depth_res":              depthRes,
			"depth_res_factor":       round4(depthResFactor),
			"subtotal_cents":         subtotal,
			"discount_cents":         discount,
		},
	}, nil
}

// QuoteStep prices a pro-pipeline step conversion. The base is billable
// minutes × the step rate × an fps factor (frames are what cost, so a 60 fps
// source prices 2.5× a 24 fps one); DepthRes > 0 then scales the depth share
// by the aspect-aware working-MP factor (see depthFactor);
// inpaint=propainter multiplies a stereo_preview subtotal by
// inpaint_multiplier (production rates already include inpainting), and
// inpaint=none (backward warp) multiplies a production subtotal by
// production_no_inpaint_multiplier.
// ReuseStages lists the stage shares to discount (artifacts confirmed cached
// — production and stereo_preview); CreditCents is the project's analyze
// credit if this is its first paid conversion. Every adjustment is an
// explicit breakdown line so support can reconstruct any charge.
func (s *Service) QuoteStep(ctx context.Context, in StepInputs) (*Quote, error) {
	return withBillableMinutes(s.quoteStep(ctx, in))(in)
}

func (s *Service) quoteStep(ctx context.Context, in StepInputs) (*Quote, error) {
	rates := s.Rates(ctx)
	var perMin int64
	switch in.Step {
	case "depth_preview":
		perMin = rates.DepthPreviewCentsPerMinute
	case "stereo_preview":
		var ok bool
		if perMin, ok = rates.StereoPreviewCentsPerMinute[in.Preset]; !ok {
			return nil, fmt.Errorf("no stereo_preview rate for preset %q", in.Preset)
		}
	case "production":
		var ok bool
		if perMin, ok = rates.CentsPerMinute[in.Preset]; !ok {
			return nil, fmt.Errorf("no rate for preset %q", in.Preset)
		}
	default:
		return nil, fmt.Errorf("unknown step %q", in.Step)
	}
	// price = cost rate × margin (see CostMarginMultiplier)
	rateCents := float64(perMin) * rates.margin()
	fpsF := fpsFactor(in.EffectiveFPS)
	baseCents := int64(math.Ceil(billedMinutes(in.Step, in.BillableS) * rateCents * fpsF))
	subtotal := baseCents

	// depth factor on the DEPTH share of the step. depth_preview is 100%
	// depth inference; the other steps use the stage_shares depth share.
	depthResFactor := depthFactor(rates, in.DepthRes, in.ContentWidth, in.ContentHeight)
	if in.DepthRes > 0 {
		depthShare := 1.0
		if in.Step != "depth_preview" {
			depthShare = rates.StageShares["depth"]
		}
		subtotal += int64(math.Round(float64(subtotal) * depthShare * (depthResFactor - 1)))
	}

	// stereo_preview pays extra for optional inpainting; production pays
	// LESS without it (backward warp) — its rates bake ProPainter in.
	inpaintMultiplier := rates.inpaintMultiplier(in.Step, in.Inpaint)
	if inpaintMultiplier != 1.0 {
		subtotal = int64(math.Round(float64(subtotal) * inpaintMultiplier))
	}

	reuseDiscount := int64(0)
	if in.Step == "production" || in.Step == "stereo_preview" {
		share := 0.0
		for _, stage := range in.ReuseStages {
			share += rates.StageShares[stage]
		}
		if share > 0.9 {
			share = 0.9 // never discount to free
		}
		reuseDiscount = int64(math.Round(float64(subtotal) * share))
	}

	afterReuse := subtotal - reuseDiscount
	if rates.TierPricing {
		return rates.quoteClassicTiers(in, afterReuse, map[string]any{
			"step": in.Step, "preset": in.Preset, "billable_seconds": math.Round(in.BillableS*100) / 100,
			"cents_per_minute": int64(math.Round(rateCents)), "cost_margin_multiplier": rates.margin(),
			"fps_factor": round4(fpsF), "base_cents": baseCents, "depth_res": in.DepthRes,
			"depth_res_factor": round4(depthResFactor), "inpaint_multiplier": inpaintMultiplier,
			"reuse_stages": in.ReuseStages, "reuse_discount_cents": reuseDiscount,
		}), nil
	}
	proDiscount := rates.proDiscountCents(in, afterReuse)
	afterPro := afterReuse - proDiscount
	bulkDiscount := int64(0)
	if afterPro > rates.DiscountThresholdCents {
		bulkDiscount = int64(math.Round(float64(afterPro) * rates.DiscountPct))
	}
	total := afterPro - bulkDiscount - in.CreditCents
	if floor := rates.MinimumFor(in.Step); total < floor {
		total = floor
	}
	return &Quote{
		AmountCents: total,
		Currency:    rates.Currency,
		RateVersion: rates.RateVersion,
		Breakdown: map[string]any{
			"step":             in.Step,
			"preset":           in.Preset,
			"billable_seconds": math.Round(in.BillableS*100) / 100,
			// the PRICE rate (cost × margin) — what the rate hint shows
			"cents_per_minute":       int64(math.Round(rateCents)),
			"cost_margin_multiplier": rates.margin(),
			"fps_factor":             round4(fpsF),
			"base_cents":             baseCents, // after fps, before depth/inpaint multipliers
			"depth_res":              in.DepthRes,
			"depth_res_factor":       round4(depthResFactor),
			"inpaint_multiplier":     inpaintMultiplier,
			"subtotal_cents":         subtotal, // after multipliers; discounts apply to this
			"reuse_stages":           in.ReuseStages,
			"reuse_discount_cents":   reuseDiscount,
			"pro":                    in.Pro,
			"pro_discount_pct":       proPct(rates, in, proDiscount),
			"pro_discount_cents":     proDiscount,
			"discount_cents":         bulkDiscount,
			"analyze_credit_cents":   in.CreditCents,
		},
	}, nil
}

// Lifelike is its own product with its own PRICE table (owner change
// 2026-11-03): lifelike_price_cents_per_minute[preset] per output minute at
// 24 fps — a price, not a cost the margin multiplies — times the fps
// factor, for production. None of Classic's mechanics apply (no depth-res
// factor, no inpaint multiplier, no reuse discount); the bulk discount, the
// analyze credit and the per-run minimum do. A lifelike_preview costs its
// frames at the same price per frame, floored at the minimum (S3D-13/17).
const (
	StepLifelikePreview = "lifelike_preview"
	MethodLifelike      = "lifelike"
)

// LifelikePresets are the presets Lifelike renders (no draft).
// 5k (2880 short side per eye), 6k (3240) and 8k (4320) since S3D-48.
var LifelikePresets = []string{"1080p", "qhd", "3k", "4k", "5k", "6k", "8k"}

func defaultLifelikePrices() map[string]int64 {
	return map[string]int64{
		// S3D-11 (final owner prices v2, 2026-11-03)
		"1080p": 300, "qhd": 450, "3k": 700, "4k": 850,
		"5k": 1300, "6k": 1600, "8k": 2200,
	}
}

// DefaultLifelikeEnabled: the presets the Lifelike service renders today
// (5k/6k/8k wait for Spatial 3D Studio — S3D-48).
var DefaultLifelikeEnabled = []string{"1080p", "qhd", "3k", "4k"}

// EnabledLifelikePresets is lifelike_enabled_presets in LifelikePresets
// order (unknown names dropped); absent or empty = DefaultLifelikeEnabled.
// Only these are offered, quoted or run: a run for another is refused
// before any charge, so nothing is charged for a size the service would
// refuse.
func (r *Rates) EnabledLifelikePresets() []string {
	var out []string
	for _, p := range LifelikePresets {
		if slices.Contains(r.LifelikeEnabledPresets, p) {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return DefaultLifelikeEnabled
	}
	return out
}

// GPUCap is the per-app GPU cap the alerts report against.
// FileKeep is how long a project's files stay without use (S3D-24,
// file_keep_days; 0/absent = 90 days).
func (r *Rates) FileKeep() time.Duration {
	if r.FileKeepDays > 0 {
		return time.Duration(r.FileKeepDays) * 24 * time.Hour
	}
	return 90 * 24 * time.Hour
}

// FileNotices are the notice mails' lead times before the files go,
// longest first (file_notice_days; absent/none positive = 14 and 3 days).
func (r *Rates) FileNotices() []time.Duration {
	var out []time.Duration
	for _, d := range r.FileNoticeDays {
		if d > 0 {
			out = append(out, time.Duration(d)*24*time.Hour)
		}
	}
	if len(out) == 0 {
		return []time.Duration{14 * 24 * time.Hour, 3 * 24 * time.Hour}
	}
	slices.Sort(out)
	slices.Reverse(out)
	return slices.Compact(out)
}

// DeletedProjectPurge is how long a deleted project's files are kept
// before the purge (deleted_project_purge_days; 0/absent = 30 days).
func (r *Rates) DeletedProjectPurge() time.Duration {
	if r.DeletedProjectPurgeDays > 0 {
		return time.Duration(r.DeletedProjectPurgeDays) * 24 * time.Hour
	}
	return 30 * 24 * time.Hour
}

// GPUCapFor is a workspace's per-app GPU cap (gpu_cap_per_workspace,
// else GPUCap).
func (r *Rates) GPUCapFor(workspace string) int {
	if n := r.GPUCapPerWorkspace[workspace]; n > 0 {
		return n
	}
	return r.GPUCap()
}

func (r *Rates) GPUCap() int {
	if r.GPUCapPerApp > 0 {
		return r.GPUCapPerApp
	}
	return MaxGPUWorkersPerJob
}

// PreviewMinimum is the per-run floor of a preview (S3D-13/17,
// preview_minimum_cents; 0/absent = 100).
func (r *Rates) PreviewMinimum() int64 {
	if r.PreviewMinimumCents > 0 {
		return r.PreviewMinimumCents
	}
	return 100
}

// ProMinimum is the per-run floor of a paid pro step (pro_minimum_cents;
// 0/absent = 100).
func (r *Rates) ProMinimum() int64 {
	if r.ProMinimumCents > 0 {
		return r.ProMinimumCents
	}
	return 100
}

// MinimumFor is a pro step's per-run floor: previews (lifelike_preview,
// depth_preview, stereo_preview) PreviewMinimum, production ProMinimum.
func (r *Rates) MinimumFor(step string) int64 {
	switch step {
	case StepLifelikePreview, "depth_preview", "stereo_preview":
		return r.PreviewMinimum()
	}
	return r.ProMinimum()
}

// FoveationMultiplier scales a foveated Lifelike run's price (S3D-50,
// foveation_price_multiplier; 0/absent = 1.3).
func (r *Rates) FoveationMultiplier() float64 {
	if r.FoveationPriceMultiplier > 0 {
		return r.FoveationPriceMultiplier
	}
	return 1.3
}

// lifelikePrice is the per-minute price of a preset; a preset missing from
// the config doc keeps its default.
func (r *Rates) lifelikePrice(preset string) (int64, bool) {
	if v := r.LifelikePriceCentsPerMinute[preset]; v > 0 {
		return v, true
	}
	v, ok := defaultLifelikePrices()[preset]
	return v, ok
}

// QuoteLifelike prices a Lifelike step. in.Step is lifelike_preview or
// production; DepthRes, Inpaint and ReuseStages are ignored.
func (s *Service) QuoteLifelike(ctx context.Context, in StepInputs) (*Quote, error) {
	return withBillableMinutes(s.quoteLifelike(ctx, in))(in)
}

func (s *Service) quoteLifelike(ctx context.Context, in StepInputs) (*Quote, error) {
	if in.Step != StepLifelikePreview && in.Step != "production" {
		return nil, fmt.Errorf("unknown lifelike step %q", in.Step)
	}
	rates := s.Rates(ctx)
	perMin, ok := rates.lifelikePrice(in.Preset)
	if !ok {
		return nil, fmt.Errorf("no lifelike price for preset %q", in.Preset)
	}
	if rates.TierPricing {
		return rates.quoteLifelikeTiers(in, perMin)
	}
	mult := 1.0
	if in.Foveated {
		mult = rates.FoveationMultiplier()
	}
	if in.Step == StepLifelikePreview {
		// S3D-13: what the same frames cost in the final at this quality —
		// the per-minute price / 1,440 per frame, times the frames the
		// preview renders (its seconds × its frame rate, so the half-rate
		// quick look costs half) — floored at the per-run minimum (S3D-17).
		// No bulk discount.
		fps := in.EffectiveFPS
		if fps <= 0 {
			fps = fpsBase
		}
		frames := math.Round(in.BillableS * fps)
		perFrame := float64(perMin) / (60 * fpsBase)
		base := int64(math.Round(frames * perFrame))
		fov := int64(math.Round(float64(base) * (mult - 1))) // its own line (S3D-50)
		cents := max(base+fov, rates.MinimumFor(in.Step))
		return &Quote{
			AmountCents: cents,
			Currency:    rates.Currency,
			RateVersion: rates.RateVersion,
			Breakdown: map[string]any{
				"step":                 in.Step,
				"method":               MethodLifelike,
				"preset":               in.Preset,
				"billable_seconds":     math.Round(in.BillableS*100) / 100,
				"cents_per_minute":     perMin,
				"frames":               int64(frames),
				"cents_per_frame":      round4(perFrame),
				"foveation_multiplier": mult,
				"foveation_cents":      fov,
				"pro":                  in.Pro, // previews get no Pro discount
			},
		}, nil
	}
	fpsF := fpsFactor(in.EffectiveFPS)
	base := int64(math.Ceil(billedMinutes(in.Step, in.BillableS) * float64(perMin) * fpsF))
	fov := int64(math.Round(float64(base) * (mult - 1))) // its own line (S3D-50)
	subtotal := base + fov
	proDiscount := rates.proDiscountCents(in, subtotal)
	afterPro := subtotal - proDiscount
	bulkDiscount := int64(0)
	if afterPro > rates.DiscountThresholdCents {
		bulkDiscount = int64(math.Round(float64(afterPro) * rates.DiscountPct))
	}
	total := afterPro - bulkDiscount - in.CreditCents
	if floor := rates.MinimumFor(in.Step); total < floor {
		total = floor
	}
	return &Quote{
		AmountCents: total,
		Currency:    rates.Currency,
		RateVersion: rates.RateVersion,
		Breakdown: map[string]any{
			"step":                 in.Step,
			"method":               MethodLifelike,
			"foveation_multiplier": mult,
			"foveation_cents":      fov,
			"preset":               in.Preset,
			"billable_seconds":     math.Round(in.BillableS*100) / 100,
			"cents_per_minute":     perMin, // the PRICE rate
			"fps_factor":           round4(fpsF),
			"subtotal_cents":       subtotal,
			"pro":                  in.Pro,
			"pro_discount_pct":     proPct(rates, in, proDiscount),
			"pro_discount_cents":   proDiscount,
			"discount_cents":       bulkDiscount,
			"analyze_credit_cents": in.CreditCents,
		},
	}, nil
}

// LifelikeInputs shapes a Lifelike wall-clock estimate.
type LifelikeInputs struct {
	Step          string
	Preset        string
	OutputSeconds float64
	// EffectiveFPS: the rate the job renders at; 0 = 24.
	EffectiveFPS float64
	// GPUs working at once: max_gpu_workers for production, 1 for a
	// preview (it runs in one container).
	GPUs int
}

// EstimateLifelikeETA predicts a Lifelike run's wall-clock seconds (see
// LifelikeETA). 1 minute on 4 GPUs: 45 + 530/4 + 150 ≈ 328 s; a 5 s
// preview on its one GPU: 45 + 44 + 30 ≈ 119 s (measured 89-138).
func (s *Service) EstimateLifelikeETA(ctx context.Context, in LifelikeInputs) int64 {
	e := s.Rates(ctx).LifelikeETA
	d := defaultLifelikeETA()
	pick := func(v, fallback float64) float64 {
		if v > 0 {
			return v
		}
		return fallback
	}
	fps := in.EffectiveFPS
	if fps <= 0 {
		fps = fpsBase
	}
	frames := in.OutputSeconds * fps
	gpus := float64(max(in.GPUs, 1))
	render := pick(e.RenderGPUSecondsPerMinute, d.RenderGPUSecondsPerMinute) * frames / (60 * fpsBase) / gpus
	tail := pick(e.EncodeTailSeconds, d.EncodeTailSeconds)
	if in.Step == StepLifelikePreview {
		tail = pick(e.PreviewTailSeconds, d.PreviewTailSeconds)
	}
	return int64(math.Round(pick(e.OverheadSeconds, d.OverheadSeconds) + render + tail))
}

// QuoteImage prices one paid still at exactly ImageCents. No MinimumCents
// floor: a still is never charged on its own — it joins the account's
// batch, and a batch under the Stripe minimum rolls over (see
// Rates.MinimumCents / the reconciler) rather than rounding the user up.
func (s *Service) QuoteImage(ctx context.Context) (*Quote, error) {
	rates := s.Rates(ctx)
	return &Quote{
		AmountCents: rates.ImageCents,
		Currency:    rates.Currency,
		RateVersion: rates.RateVersion,
		Breakdown:   map[string]any{"image_cents": rates.ImageCents, "free_image": false},
	}, nil
}

// ClassicPresets are the presets Classic pro steps offer: 4k left them
// with S3D-12 (the mobile one-shot keeps it for shipped apps).
var ClassicPresets = []string{"draft", "1080p", "qhd", "3k"}

// Public is the customer-facing price list behind the public GET
// /v1/pricing (S3D-18): every number derived from the live config, already
// in customer prices (margin applied), so the Pricing page never restates a
// price by hand. Classic production prices are a default quote's per-minute
// subtotal (16:9 source, 24 fps, the preset's own depth size, the default
// "Stretched" edges — S3D-29); Classic previews are base rates before the
// Depth page's resolution factor and the inpaint choice.
func (s *Service) Public(ctx context.Context) map[string]any {
	rates := s.Rates(ctx)
	perMinute := func(in StepInputs) int64 {
		in.BillableS, in.ContentWidth, in.ContentHeight, in.EffectiveFPS = 60, 1920, 1080, fpsBase
		q, err := s.QuoteStep(ctx, in)
		if err != nil {
			return 0
		}
		v, _ := q.Breakdown["subtotal_cents"].(int64)
		return v
	}
	classicProduction := map[string]int64{}
	classicStereoPreview := map[string]int64{}
	for _, p := range ClassicPresets {
		// the default edge style since S3D-29: backward warp, inpaint none
		if v := perMinute(StepInputs{Step: "production", Preset: p, DepthRes: PresetInputSize[p], Inpaint: "none"}); v > 0 {
			classicProduction[p] = v
		}
		if v, ok := rates.StereoPreviewCentsPerMinute[p]; ok {
			classicStereoPreview[p] = int64(math.Round(float64(v) * rates.margin()))
		}
	}
	lifelike := map[string]int64{}
	lifelikePerFrame := map[string]float64{}
	from := int64(0) // the cheapest enabled size: the "from $X a minute" line
	enabled := rates.EnabledLifelikePresets()
	for _, p := range enabled {
		if v, ok := rates.lifelikePrice(p); ok {
			lifelike[p] = v
			lifelikePerFrame[p] = round4(float64(v) / (60 * fpsBase))
			if from == 0 || v < from {
				from = v
			}
		}
	}
	out := map[string]any{
		"rate_version": rates.RateVersion,
		"currency":     rates.Currency,
		// Classic 3D is retired for new projects (2026-11-04): the web
		// hides it; its prices stay for projects that already ran it.
		"classic_new_projects": false,
		"methods": map[string]any{
			"lifelike": map[string]any{
				"presets":                     enabled,
				"production_cents_per_minute": lifelike,
				"from_cents_per_minute":       from,
				// a preview costs its frames at the production price per
				// frame (cents_per_minute / 1,440), at least minimum_cents,
				// no bulk discount
				"preview_cents_per_frame": lifelikePerFrame,
				"preview_seconds":         rates.LifelikePreviewSeconds(),
				// "foveation: static" option (S3D-50), when switched on
				"foveation": map[string]any{
					"enabled":          rates.FoveationEnabled,
					"price_multiplier": rates.FoveationMultiplier(),
				},
				"max_source_duration_s": rates.MaxSourceDurationFor("lifelike"),
				"max_source_bytes":      rates.MaxSourceBytesFor("lifelike"),
			},
			"classic": map[string]any{
				"presets":                         ClassicPresets,
				"production_cents_per_minute":     classicProduction,
				"stereo_preview_cents_per_minute": classicStereoPreview,
				"depth_preview_cents_per_minute":  int64(math.Round(float64(rates.DepthPreviewCentsPerMinute) * rates.margin())),
				"max_source_duration_s":           rates.MaxSourceDurationFor("classic"),
				"max_source_bytes":                rates.MaxSourceBytesFor("classic"),
			},
		},
		// Prices are per minute of output at 24 fps; the frame rate scales
		// them by fps/24, clamped. Output rates above 30 fps need a
		// Business or Studio plan (2026-11-04); without one a faster
		// source is divided down.
		"fps": map[string]any{"base": fpsBase, "min_factor": fpsMinFactor, "max_factor": fpsMaxFactor,
			"max_fps_without_plan": 30, "max_fps_with_plan": PlanMaxFPS},
		"discount": map[string]any{
			"threshold_cents": rates.DiscountThresholdCents,
			"pct":             rates.DiscountPct,
		},
		// every paid run of either method, previews included (S3D-17)
		"minimum_cents":             rates.ProMinimum(),
		"preview_minimum_cents":     rates.PreviewMinimum(),
		"precharge_threshold_cents": rates.PrechargeThreshold(),
		// S3D-67: SVS Pro customers' share off full runs (not previews),
		// before the bulk discount; pct 0 = off.
		"pro_discount": map[string]any{"pct": rates.ProDiscount(), "applies_to": "production"},
	}
	if rates.TierPricing {
		rates.publicTiers(out, enabled)
	}
	return out
}

// proPct is the Pro share a quote applied (0 when none applied).
func proPct(r *Rates, in StepInputs, cents int64) float64 {
	if cents == 0 && (!in.Pro || in.Step != "production") {
		return 0
	}
	return r.ProDiscount()
}

// TaxInclusive: invoices compute VAT inside the sticker price (C7).
func (r *Rates) TaxInclusive() bool { return r != nil && r.TaxMode == "inclusive" }

// BillableMinutes rounds a run's length up to whole minutes (owner
// 2026-11-04): ceil(the customer's video in the converted range ÷ 60), on
// the run's total, so a split run sums its parts first (one range); the
// brand intro never counts. 2:10 → 3, 3:00 → 3, 0:20 → 1.
func BillableMinutes(seconds float64) int64 {
	if seconds <= 0 {
		return 0
	}
	return int64(math.Ceil(seconds/60 - 1e-6)) // a frame-rounded 3:00 stays 3
}

// billedMinutes is what a step is priced on: production rounds up to
// whole minutes; previews keep their exact length (not changed yet).
func billedMinutes(step string, seconds float64) float64 {
	if step == "production" {
		return float64(BillableMinutes(seconds))
	}
	return seconds / 60
}

// withBillableMinutes adds billable_minutes to a production quote's
// breakdown (receipts show just the minutes: "3 min").
func withBillableMinutes(q *Quote, err error) func(StepInputs) (*Quote, error) {
	return func(in StepInputs) (*Quote, error) {
		if err == nil && q != nil && in.Step == "production" {
			if q.Breakdown == nil {
				q.Breakdown = map[string]any{}
			}
			q.Breakdown["billable_minutes"] = BillableMinutes(in.BillableS)
		}
		return q, err
	}
}
