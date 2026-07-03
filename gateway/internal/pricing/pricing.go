// Package pricing computes server-side quotes. Rates live in Firestore
// (config/pricing_{env}) so they can be tuned without a deploy; code defaults
// apply when the doc is absent. The client never supplies price inputs —
// duration/frames come from ffprobe on the uploaded object.
package pricing

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
)

type Rates struct {
	RateVersion string `firestore:"rate_version"`
	Currency    string `firestore:"currency"`
	// Per-preset video price. Old app charged ~$1/min ($0.0556/frame @30fps);
	// defaults keep that anchor for 1080p and scale by GPU cost of the preset.
	CentsPerMinute map[string]int64 `firestore:"cents_per_minute"`
	ImageCents     int64            `firestore:"image_cents"`
	MinimumCents   int64            `firestore:"minimum_cents"`
	// 10% off carts over $10, mirroring the old app.
	DiscountThresholdCents int64   `firestore:"discount_threshold_cents"`
	DiscountPct            float64 `firestore:"discount_pct"`

	// Pro step pipeline (web/DESIGN.md): preview passes are flat per-minute
	// (they run at draft tiers / reduced fps upstream, so GPU cost is low).
	DepthPreviewCentsPerMinute  int64 `firestore:"depth_preview_cents_per_minute"`
	StereoPreviewCentsPerMinute int64 `firestore:"stereo_preview_cents_per_minute"`
	// AnalyzeCreditCents: the free analyze step's cost, credited back as a
	// discount on the project's first paid conversion.
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

	// Abuse caps enforced at conversion create.
	MaxDurationS     float64 `firestore:"max_duration_s"`
	MaxSourceBytes   int64   `firestore:"max_source_bytes"`
	MaxActivePerUser int     `firestore:"max_active_per_user"`

	// Pre-run wall-clock estimate model (shown next to quotes; the live
	// number always comes from the running Modal job). eta = base +
	// factor × billable seconds, with the depth share scaled by the same
	// depth_res factor as pricing, the inpaint multiplier applied on
	// stereo_preview, and reused stage shares subtracted. Production
	// factors are keyed "production_<preset>" with a "production"
	// fallback.
	EtaBaseSeconds map[string]float64 `firestore:"eta_base_seconds"`
	EtaFactor      map[string]float64 `firestore:"eta_factor"`
}

// Defaults are calibrated to ≈2× the raw Modal cost estimate (our margin),
// anchored on a MEASURED run (job 4cd27aa0aaee, 2026-07-03): 149.5s 4K
// 2.39:1 source @24fps, depth_res 1596 → $5.59 raw. Under this model that
// run quotes 2.49 min × 125¢ × depth factor 3.57 ≈ $11.11 ≈ 2.0×. The
// production/stereo anchors extrapolate the same 2× rule from
// docs/PRICING.md's per-frame tables (e.g. 4K propainter ≈ $2.7/min raw
// at 24fps → 500¢/min). Tune in Firestore as more real runs accumulate.
func defaults() *Rates {
	return &Rates{
		RateVersion: "2026-07-03.defaults",
		Currency:    "usd",
		CentsPerMinute: map[string]int64{
			"draft": 200, "1080p": 250, "qhd": 350, "3k": 400, "4k": 500,
		},
		ImageCents:                  50,
		MinimumCents:                50, // Stripe practical minimum
		DiscountThresholdCents:      1000,
		DiscountPct:                 0.10,
		DepthPreviewCentsPerMinute:  125,
		StereoPreviewCentsPerMinute: 200,
		AnalyzeCreditCents:          50,
		StageShares:                 map[string]float64{"depth": 0.35, "preprocess": 0.05},
		DepthResBase:                980,
		DepthFactorCeiling:          5.0,
		InpaintMultiplier:           1.6,
		MaxDurationS:                30 * 60,
		MaxSourceBytes:              8 << 30,
		MaxActivePerUser:            3,
		// ETA anchors from the same measured run: 1584s wall for 149.5s
		// billable at depth factor 3.57 → (60 + 2.5×149.5) × 3.57 ≈ 1547s.
		EtaBaseSeconds: map[string]float64{
			"depth_preview": 60, "stereo_preview": 90, "production": 120,
		},
		EtaFactor: map[string]float64{
			"depth_preview":    2.5,
			"stereo_preview":   3.5,
			"production_draft": 3.0, "production_1080p": 4.0,
			"production_qhd": 5.0, "production_3k": 6.5, "production_4k": 8.0,
			"production": 4.0,
		},
	}
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
// Same shape-knobs as QuoteStep so the estimate tracks what the user picked;
// deliberately coarse — the running job reports the live ETA.
func (s *Service) EstimateStepETA(ctx context.Context, in StepInputs) int64 {
	rates := s.Rates(ctx)
	key := in.Step
	if in.Step == "production" {
		if _, ok := rates.EtaFactor["production_"+in.Preset]; ok {
			key = "production_" + in.Preset
		}
	}
	factor := rates.EtaFactor[key]
	if factor <= 0 {
		factor = 4.0
	}
	// wall time scales with frames: fps rides the billable term, not the base
	eta := rates.EtaBaseSeconds[in.Step] + factor*in.BillableS*fpsFactor(in.EffectiveFPS)

	if in.DepthRes > 0 {
		df := depthFactor(rates, in.DepthRes, in.ContentWidth, in.ContentHeight)
		depthShare := 1.0
		if in.Step != "depth_preview" {
			depthShare = rates.StageShares["depth"]
		}
		eta *= 1 + depthShare*(df-1)
	}
	if in.Step == "stereo_preview" && in.Inpaint == "propainter" && rates.InpaintMultiplier > 0 {
		eta *= rates.InpaintMultiplier
	}
	reusedShare := 0.0
	for _, stage := range in.ReuseStages {
		reusedShare += rates.StageShares[stage]
	}
	if reusedShare > 0.9 {
		reusedShare = 0.9
	}
	eta *= 1 - reusedShare
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
	fpsF := fpsFactor(in.FPS)
	baseCents := int64(math.Ceil(in.BillableS / 60 * float64(perMin) * fpsF))
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
			"cents_per_minute": perMin,
			"fps_factor":       round4(fpsF),
			"base_cents":       baseCents,
			"depth_res":        depthRes,
			"depth_res_factor": round4(depthResFactor),
			"subtotal_cents":   subtotal,
			"discount_cents":   discount,
		},
	}, nil
}

// QuoteStep prices a pro-pipeline step conversion. The base is billable
// minutes × the step rate × an fps factor (frames are what cost, so a 60 fps
// source prices 2.5× a 24 fps one); DepthRes > 0 then scales the depth share
// by the aspect-aware working-MP factor (see depthFactor);
// inpaint=propainter multiplies a stereo_preview subtotal by
// inpaint_multiplier (production rates already include inpainting).
// ReuseStages lists the stage shares to discount (artifacts confirmed cached
// — production only); CreditCents is the project's analyze credit if this is
// its first paid conversion. Every adjustment is an explicit breakdown line
// so support can reconstruct any charge.
func (s *Service) QuoteStep(ctx context.Context, in StepInputs) (*Quote, error) {
	rates := s.Rates(ctx)
	var perMin int64
	switch in.Step {
	case "depth_preview":
		perMin = rates.DepthPreviewCentsPerMinute
	case "stereo_preview":
		perMin = rates.StereoPreviewCentsPerMinute
	case "production":
		var ok bool
		if perMin, ok = rates.CentsPerMinute[in.Preset]; !ok {
			return nil, fmt.Errorf("no rate for preset %q", in.Preset)
		}
	default:
		return nil, fmt.Errorf("unknown step %q", in.Step)
	}
	fpsF := fpsFactor(in.EffectiveFPS)
	baseCents := int64(math.Ceil(in.BillableS / 60 * float64(perMin) * fpsF))
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

	// stereo_preview pays extra for optional inpainting.
	inpaintMultiplier := 1.0
	if in.Step == "stereo_preview" && in.Inpaint == "propainter" {
		if rates.InpaintMultiplier > 0 {
			inpaintMultiplier = rates.InpaintMultiplier
		}
		subtotal = int64(math.Round(float64(subtotal) * inpaintMultiplier))
	}

	reuseDiscount := int64(0)
	if in.Step == "production" {
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
			"step":                 in.Step,
			"preset":               in.Preset,
			"billable_seconds":     math.Round(in.BillableS*100) / 100,
			"cents_per_minute":     perMin,
			"fps_factor":           round4(fpsF),
			"base_cents":           baseCents, // after fps, before depth/inpaint multipliers
			"depth_res":            in.DepthRes,
			"depth_res_factor":     round4(depthResFactor),
			"inpaint_multiplier":   inpaintMultiplier,
			"subtotal_cents":       subtotal, // after multipliers; discounts apply to this
			"reuse_stages":         in.ReuseStages,
			"reuse_discount_cents": reuseDiscount,
			"discount_cents":       bulkDiscount,
			"analyze_credit_cents": in.CreditCents,
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
