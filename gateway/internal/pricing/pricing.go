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
	// DepthResBase: the depth_res that prices at 1×. Depth inference cost
	// scales ~quadratically with resolution, so the depth share of a step is
	// multiplied by clamp((depth_res/base)², 0.5, 4.0).
	DepthResBase float64 `firestore:"depth_res_base"`
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

func defaults() *Rates {
	return &Rates{
		RateVersion: "2026-07-02.defaults",
		Currency:    "usd",
		CentsPerMinute: map[string]int64{
			"draft": 25, "1080p": 100, "qhd": 150, "3k": 200, "4k": 300,
		},
		ImageCents:                  50,
		MinimumCents:                50, // Stripe practical minimum
		DiscountThresholdCents:      1000,
		DiscountPct:                 0.10,
		DepthPreviewCentsPerMinute:  10,
		StereoPreviewCentsPerMinute: 25,
		AnalyzeCreditCents:          50,
		StageShares:                 map[string]float64{"depth": 0.35, "preprocess": 0.05},
		DepthResBase:                980,
		InpaintMultiplier:           1.6,
		MaxDurationS:                30 * 60,
		MaxSourceBytes:              8 << 30,
		MaxActivePerUser:            3,
		// Rough anchors from observed test-env runs; tune in Firestore as
		// real timings accumulate.
		EtaBaseSeconds: map[string]float64{
			"depth_preview": 60, "stereo_preview": 90, "production": 120,
		},
		EtaFactor: map[string]float64{
			"depth_preview":    1.5,
			"stereo_preview":   2.5,
			"production_draft": 3.0, "production_1080p": 4.0,
			"production_qhd": 5.0, "production_3k": 6.5, "production_4k": 8.0,
			"production": 4.0,
		},
	}
}

// EstimateStepETA predicts a step's wall-clock seconds for the quote screen.
// Same shape-knobs as QuoteStep so the estimate tracks what the user picked;
// deliberately coarse — the running job reports the live ETA.
func (s *Service) EstimateStepETA(ctx context.Context, step, preset string, billableS float64,
	depthRes int, inpaint string, reuseStages []string) int64 {
	rates := s.Rates(ctx)
	key := step
	if step == "production" {
		if _, ok := rates.EtaFactor["production_"+preset]; ok {
			key = "production_" + preset
		}
	}
	factor := rates.EtaFactor[key]
	if factor <= 0 {
		factor = 4.0
	}
	eta := rates.EtaBaseSeconds[step] + factor*billableS

	if depthRes > 0 {
		base := rates.DepthResBase
		if base <= 0 {
			base = 980
		}
		depthResFactor := math.Min(4.0, math.Max(0.5, math.Pow(float64(depthRes)/base, 2)))
		depthShare := 1.0
		if step != "depth_preview" {
			depthShare = rates.StageShares["depth"]
		}
		eta *= 1 + depthShare*(depthResFactor-1)
	}
	if step == "stereo_preview" && inpaint == "propainter" && rates.InpaintMultiplier > 0 {
		eta *= rates.InpaintMultiplier
	}
	reusedShare := 0.0
	for _, stage := range reuseStages {
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

// QuoteVideo prices a video conversion. billableS is the effective duration
// after trim; frames after target_fps decimation don't change the price —
// duration is what users understand and what the old app anchored on.
func (s *Service) QuoteVideo(ctx context.Context, preset string, billableS float64) (*Quote, error) {
	rates := s.Rates(ctx)
	perMin, ok := rates.CentsPerMinute[preset]
	if !ok {
		return nil, fmt.Errorf("no rate for preset %q", preset)
	}
	minutes := billableS / 60
	subtotal := int64(math.Ceil(minutes * float64(perMin)))
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
			"preset":           preset,
			"billable_seconds": math.Round(billableS*100) / 100,
			"cents_per_minute": perMin,
			"subtotal_cents":   subtotal,
			"discount_cents":   discount,
		},
	}, nil
}

// QuoteStep prices a pro-pipeline step conversion. depthRes > 0 scales the
// depth share of the subtotal by clamp((depthRes/depth_res_base)², 0.5, 4.0);
// inpaint=propainter multiplies a stereo_preview subtotal by
// inpaint_multiplier (production rates already include inpainting).
// reuseStages lists the stage shares to discount (artifacts confirmed cached
// — production only); creditCents is the project's analyze credit if this is
// its first paid conversion. Every adjustment is an explicit breakdown line
// so support can reconstruct any charge.
func (s *Service) QuoteStep(ctx context.Context, step, preset string, billableS float64,
	depthRes int, inpaint string, reuseStages []string, creditCents int64) (*Quote, error) {
	rates := s.Rates(ctx)
	var perMin int64
	switch step {
	case "depth_preview":
		perMin = rates.DepthPreviewCentsPerMinute
	case "stereo_preview":
		perMin = rates.StereoPreviewCentsPerMinute
	case "production":
		var ok bool
		if perMin, ok = rates.CentsPerMinute[preset]; !ok {
			return nil, fmt.Errorf("no rate for preset %q", preset)
		}
	default:
		return nil, fmt.Errorf("unknown step %q", step)
	}
	baseCents := int64(math.Ceil(billableS / 60 * float64(perMin)))
	subtotal := baseCents

	// depth_res multiplier on the DEPTH share of the step. depth_preview is
	// 100% depth inference; the other steps use the stage_shares depth share.
	depthResFactor := 1.0
	if depthRes > 0 {
		base := rates.DepthResBase
		if base <= 0 {
			base = 980 // sane fallback if the config doc zeroes it
		}
		depthResFactor = math.Min(4.0, math.Max(0.5, math.Pow(float64(depthRes)/base, 2)))
		depthShare := 1.0
		if step != "depth_preview" {
			depthShare = rates.StageShares["depth"]
		}
		subtotal += int64(math.Round(float64(subtotal) * depthShare * (depthResFactor - 1)))
	}

	// stereo_preview pays extra for optional inpainting.
	inpaintMultiplier := 1.0
	if step == "stereo_preview" && inpaint == "propainter" {
		if rates.InpaintMultiplier > 0 {
			inpaintMultiplier = rates.InpaintMultiplier
		}
		subtotal = int64(math.Round(float64(subtotal) * inpaintMultiplier))
	}

	reuseDiscount := int64(0)
	if step == "production" {
		share := 0.0
		for _, stage := range reuseStages {
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
	total := afterReuse - bulkDiscount - creditCents
	if total < rates.MinimumCents {
		total = rates.MinimumCents
	}
	return &Quote{
		AmountCents: total,
		Currency:    rates.Currency,
		RateVersion: rates.RateVersion,
		Breakdown: map[string]any{
			"step":                 step,
			"preset":               preset,
			"billable_seconds":     math.Round(billableS*100) / 100,
			"cents_per_minute":     perMin,
			"base_cents":           baseCents, // before depth_res / inpaint multipliers
			"depth_res":            depthRes,
			"depth_res_factor":     depthResFactor,
			"inpaint_multiplier":   inpaintMultiplier,
			"subtotal_cents":       subtotal, // after multipliers; discounts apply to this
			"reuse_stages":         reuseStages,
			"reuse_discount_cents": reuseDiscount,
			"discount_cents":       bulkDiscount,
			"analyze_credit_cents": creditCents,
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
