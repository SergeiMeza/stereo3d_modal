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
	ImageCents     int64            `firestore:"image_cents"`
	MinimumCents   int64            `firestore:"minimum_cents"`
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
	// ProductionNoInpaintMultiplier scales a PRODUCTION subtotal (and its
	// ETA residual) when inpaint=none — today that means warp=backward
	// ("Stretched edges": one gather pass, no ProPainter), which the
	// gateway forces to inpaint none. Production rates bake ProPainter in,
	// so without this a backward-warp render billed the full inpainted rate
	// for seconds of GPU. Applied to the WHOLE subtotal like the preview
	// knob (simple, explainable; the depth share is slightly over-
	// discounted). 0.6 mirrors the preview's ×1.6 and stays well above the
	// measured cost (ProPainter is ~$0.0008/frame of a 1080p production's
	// ~$0.00104/frame → no-inpaint ≈ 25–45% of the inpainted cost,
	// docs/PRICING.md). 0/missing → the default, never 1× silently.
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
	EtaBaseSeconds map[string]float64 `firestore:"eta_base_seconds"`
	EtaFactor      map[string]float64 `firestore:"eta_factor"`
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
func defaults() *Rates {
	return &Rates{
		RateVersion:          "2026-07-03.v2-cost-margin",
		Currency:             "usd",
		CostMarginMultiplier: 3.0,
		CentsPerMinute: map[string]int64{
			"draft": 120, "1080p": 150, "qhd": 210, "3k": 240, "4k": 300,
		},
		ImageCents:                 50,
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
		// production with inpaint=none (backward warp): ×0.6, see field doc
		ProductionNoInpaintMultiplier: 0.6,
		MaxDurationS:                  30 * 60,
		MaxSourceBytes:                8 << 30,
		MaxActivePerUser:              3,
		MaxSourceDurationS:            10 * 60,     // beta: 10-minute videos
		MaxSourcePixels:               3840 * 2160, // beta: up to a 4K UHD frame (inclusive)
		MaxGPUWorkers:                 8,
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
	}
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
	switch {
	case step == "stereo_preview" && inpaint == "propainter" && r.InpaintMultiplier > 0:
		return r.InpaintMultiplier
	case step == "production" && inpaint == "none":
		if r.ProductionNoInpaintMultiplier > 0 {
			return r.ProductionNoInpaintMultiplier
		}
		return 0.6
	}
	return 1.0
}

// fpsBase is the frame rate the per-minute anchors are calibrated at. Cost
// scales with FRAME COUNT (docs/PRICING.md lever #1), so a step's effective
// fps scales its price linearly: a 60 fps source costs 2.5× a 24 fps one
// per minute of footage.
const fpsBase = 24.0

// baseElongation anchors the depth factor's base working MP at 16:9 — the
// aspect the DepthResBase quadratic was originally calibrated on.
const baseElongation = 16.0 / 9.0

func fpsFactor(effectiveFPS float64) float64 {
	if effectiveFPS <= 0 {
		return 1.0
	}
	return math.Min(2.5, math.Max(0.5, effectiveFPS/fpsBase))
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
	// the splat/inpaint/encode wall time), with the inpaint adjustment:
	// ×1.6 on a propainter stereo_preview, ×0.6 on a no-inpaint (backward
	// warp) production — see Rates.inpaintMultiplier. depth_preview has no
	// residual — its base covers publish/encode.
	if in.Step != "depth_preview" {
		factor := rates.EtaFactor[in.Step+"_"+in.Preset]
		if factor <= 0 {
			factor = rates.EtaFactor[in.Step]
		}
		if factor <= 0 {
			factor = 4.0
		}
		eta += factor * in.BillableS * fps * rates.inpaintMultiplier(in.Step, in.Inpaint)
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

// Rates returns the current pricing config (60s cache; falls back to code
// defaults if the Firestore doc is missing or malformed).
func (s *Service) Rates(ctx context.Context) *Rates {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cached != nil && time.Since(s.fetchedAt) < cacheTTL {
		return s.cached
	}
	rates := defaults()
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
	baseCents := int64(math.Ceil(in.BillableS / 60 * rateCents * fpsF))
	subtotal := baseCents
	depthResFactor := 1.0
	depthRes := PresetInputSize[in.Preset]
	if depthRes > 0 {
		depthResFactor = depthFactor(rates, depthRes, in.Width, in.Height)
		subtotal += int64(math.Round(float64(subtotal) * rates.StageShares["depth"] * (depthResFactor - 1)))
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
			"preset":           in.Preset,
			"billable_seconds": math.Round(in.BillableS*100) / 100,
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
	baseCents := int64(math.Ceil(in.BillableS / 60 * rateCents * fpsF))
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
	bulkDiscount := int64(0)
	if afterReuse > rates.DiscountThresholdCents {
		bulkDiscount = int64(math.Round(float64(afterReuse) * rates.DiscountPct))
	}
	total := afterReuse - bulkDiscount - in.CreditCents
	if total < rates.MinimumCents {
		total = rates.MinimumCents
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
			"discount_cents":         bulkDiscount,
			"analyze_credit_cents":   in.CreditCents,
		},
	}, nil
}

func (s *Service) QuoteImage(ctx context.Context) (*Quote, error) {
	rates := s.Rates(ctx)
	total := rates.ImageCents
	if total < rates.MinimumCents {
		total = rates.MinimumCents
	}
	return &Quote{
		AmountCents: total,
		Currency:    rates.Currency,
		RateVersion: rates.RateVersion,
		Breakdown:   map[string]any{"image_cents": rates.ImageCents},
	}, nil
}
