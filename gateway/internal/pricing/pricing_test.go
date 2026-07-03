package pricing

import (
	"context"
	"testing"
)

// quoteWith runs QuoteVideo against code defaults (nil Firestore client is
// never dereferenced because the cache is primed). No dims/fps → 16:9
// assumed, no fps scaling.
func quoteWith(t *testing.T, preset string, billableS float64) *Quote {
	t.Helper()
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	q, err := s.QuoteVideo(context.Background(), VideoInputs{Preset: preset, BillableS: billableS})
	if err != nil {
		t.Fatalf("QuoteVideo(%s, %v): %v", preset, billableS, err)
	}
	return q
}

func TestQuoteVideoMinimumCharge(t *testing.T) {
	q := quoteWith(t, "draft", 10) // 10s draft ≈ 34¢ → floor at 50¢
	if q.AmountCents != 50 {
		t.Errorf("want minimum 50, got %d", q.AmountCents)
	}
}

func TestQuoteVideoPerMinute(t *testing.T) {
	// 5 min × $2.50 = 1250¢ → over $10 → 10% off = 1125¢
	q := quoteWith(t, "1080p", 300)
	if q.AmountCents != 1125 {
		t.Errorf("want 1125, got %d", q.AmountCents)
	}
}

func TestQuoteVideoDiscountOverTenDollars(t *testing.T) {
	// 5 min × $5.00 = 2500¢ base; the 4k preset runs depth at input_size
	// 1442 → factor 2.1651 on the 0.35 share → 3519¢ → 10% off = 3167¢
	q := quoteWith(t, "4k", 300)
	if q.AmountCents != 3167 {
		t.Errorf("want 3167, got %d", q.AmountCents)
	}
	if q.Breakdown["discount_cents"].(int64) != 352 {
		t.Errorf("want discount 352, got %v", q.Breakdown["discount_cents"])
	}
}

func TestQuoteVideoLegacyParityWithProductionPhysics(t *testing.T) {
	// The legacy mobile flow runs the same pipeline as pro production, so
	// its quote carries the same fps + aspect-aware depth factors: a 60 fps
	// 2.39:1 upload prices its real frame count and depth work.
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	q, err := s.QuoteVideo(context.Background(), VideoInputs{
		Preset: "1080p", BillableS: 300, Width: 2390, Height: 1000, FPS: 60,
	})
	if err != nil {
		t.Fatal(err)
	}
	// base = ceil(5 × 250 × 2.5) = 3125; depth 980@2.39:1 → factor 1.3444
	// → 3125 + round(3125×0.35×0.3444) = 3502 → −350 bulk = 3152
	if q.AmountCents != 3152 {
		t.Errorf("want 3152, got %d", q.AmountCents)
	}
	if got := q.Breakdown["fps_factor"].(float64); got != 2.5 {
		t.Errorf("want fps_factor 2.5, got %v", got)
	}
	if got := q.Breakdown["depth_res_factor"].(float64); got != 1.3444 {
		t.Errorf("want depth_res_factor 1.3444, got %v", got)
	}
}

func TestQuoteVideoRoundsUpPartialMinutes(t *testing.T) {
	q := quoteWith(t, "1080p", 61) // 1.0167 min × 250 = 254.2 → 255¢ (ceil)
	if q.AmountCents != 255 {
		t.Errorf("want 255, got %d", q.AmountCents)
	}
}

func TestQuoteVideoUnknownPreset(t *testing.T) {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	if _, err := s.QuoteVideo(context.Background(), VideoInputs{Preset: "8k", BillableS: 60}); err == nil {
		t.Error("want error for unknown preset")
	}
}

// stepSvc returns a Service primed with code defaults (nil Firestore is
// never dereferenced).
func stepSvc() *Service {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	return s
}

func quoteStep(t *testing.T, in StepInputs) *Quote {
	t.Helper()
	q, err := stepSvc().QuoteStep(context.Background(), in)
	if err != nil {
		t.Fatalf("QuoteStep(%+v): %v", in, err)
	}
	return q
}

func TestQuoteStepPreviewRates(t *testing.T) {
	// depth_preview 5 min × 125¢ = 625¢ (no fps given → factor 1)
	q := quoteStep(t, StepInputs{Step: "depth_preview", Preset: "draft", BillableS: 300})
	if q.AmountCents != 625 {
		t.Errorf("depth_preview want 625, got %d", q.AmountCents)
	}
	// stereo_preview 10 min × 200¢ = 2000¢ → over $10 → 10% off = 1800¢
	q = quoteStep(t, StepInputs{Step: "stereo_preview", Preset: "1080p", BillableS: 600})
	if q.AmountCents != 1800 {
		t.Errorf("stereo_preview want 1800, got %d", q.AmountCents)
	}
}

func TestQuoteStepFPSFactor(t *testing.T) {
	// Frames are what cost: the effective fps scales the base linearly,
	// normalized to 24 fps and clamped to [0.5, 2.5].
	cases := []struct {
		fps       float64
		wantCents int64
		wantF     float64
	}{
		{24, 625, 1.0},  // the calibration anchor
		{60, 1407, 2.5}, // 60 fps source: 625×2.5 = 1563 → −10% bulk = 1407
		{12, 313, 0.5},  // half-rate previews
		{6, 313, 0.5},   // floor: fixed per-job overhead doesn't halve forever
		{0, 625, 1.0},   // unknown → no scaling
	}
	for _, c := range cases {
		q := quoteStep(t, StepInputs{
			Step: "depth_preview", Preset: "draft", BillableS: 300, EffectiveFPS: c.fps,
		})
		if q.AmountCents != c.wantCents {
			t.Errorf("fps=%v: want %d, got %d", c.fps, c.wantCents, q.AmountCents)
		}
		if got := q.Breakdown["fps_factor"].(float64); got != c.wantF {
			t.Errorf("fps=%v: want factor %v, got %v", c.fps, c.wantF, got)
		}
	}
}

func TestQuoteStepProductionReuseDiscount(t *testing.T) {
	// 5 min 1080p = 1250¢; depth share 0.35 → −438¢ = 812¢ (under $10, no bulk)
	q := quoteStep(t, StepInputs{
		Step: "production", Preset: "1080p", BillableS: 300, ReuseStages: []string{"depth"},
	})
	if q.AmountCents != 812 {
		t.Errorf("want 812, got %d", q.AmountCents)
	}
	if q.Breakdown["reuse_discount_cents"].(int64) != 438 {
		t.Errorf("want reuse discount 438, got %v", q.Breakdown["reuse_discount_cents"])
	}
}

func TestQuoteStepStereoPreviewReuseDiscount(t *testing.T) {
	// Stereo previews reuse the Depth page's artifact like production does:
	// 5 min × 200¢ = 1000¢; depth share 0.35 → −350¢ = 650¢
	q := quoteStep(t, StepInputs{
		Step: "stereo_preview", Preset: "1080p", BillableS: 300, ReuseStages: []string{"depth"},
	})
	if q.AmountCents != 650 {
		t.Errorf("want 650, got %d", q.AmountCents)
	}
	if q.Breakdown["reuse_discount_cents"].(int64) != 350 {
		t.Errorf("want reuse discount 350, got %v", q.Breakdown["reuse_discount_cents"])
	}
}

func TestQuoteStepReuseIgnoredForDepthPreview(t *testing.T) {
	q := quoteStep(t, StepInputs{
		Step: "depth_preview", Preset: "draft", BillableS: 300, ReuseStages: []string{"depth"},
	})
	if q.Breakdown["reuse_discount_cents"].(int64) != 0 {
		t.Errorf("depth_preview must not get reuse discounts, got %v", q.Breakdown["reuse_discount_cents"])
	}
}

func TestQuoteStepAnalyzeCreditAndFloor(t *testing.T) {
	// 2 min 1080p = 500¢ − 50¢ credit = 450¢
	q := quoteStep(t, StepInputs{
		Step: "production", Preset: "1080p", BillableS: 120, CreditCents: 50,
	})
	if q.AmountCents != 450 {
		t.Errorf("want 450, got %d", q.AmountCents)
	}
	// credit larger than the subtotal still floors at minimum_cents
	q = quoteStep(t, StepInputs{
		Step: "depth_preview", Preset: "draft", BillableS: 60, CreditCents: 5000,
	})
	if q.AmountCents != 50 {
		t.Errorf("want minimum 50, got %d", q.AmountCents)
	}
}

func TestQuoteStepDepthFactorDepthPreview(t *testing.T) {
	// depth_preview is 100% depth work: the factor scales the whole step.
	// 20 min × 125¢ = 2500¢ base; on 16:9 dims the working-MP factor equals
	// the legacy (res/980)² quadratic. Bulk 10% applies over $10.
	cases := []struct {
		depthRes   int
		wantCents  int64
		wantFactor float64
	}{
		{980, 2250, 1.0},   // base resolution → 1× (2500 − 10% bulk)
		{140, 1125, 0.5},   // tiny → clamped to the 0.5 floor (1250 − 125)
		{1960, 9000, 4.0},  // (1960/980)² = 4 → 10000 − 1000
		{2520, 11250, 5.0}, // 6.6× → clamped to the 5.0 ceiling (B200 range)
		{0, 2250, 1.0},     // absent → preset default, no factor
	}
	for _, c := range cases {
		q := quoteStep(t, StepInputs{
			Step: "depth_preview", Preset: "draft", BillableS: 1200,
			DepthRes: c.depthRes, ContentWidth: 1920, ContentHeight: 1080,
		})
		if q.AmountCents != c.wantCents {
			t.Errorf("depth_res=%d: want %d, got %d", c.depthRes, c.wantCents, q.AmountCents)
		}
		if got := q.Breakdown["depth_res_factor"].(float64); got != c.wantFactor {
			t.Errorf("depth_res=%d: want factor %v, got %v", c.depthRes, c.wantFactor, got)
		}
	}
}

func TestQuoteStepDepthFactorIsAspectAware(t *testing.T) {
	// The factor is linear in WORKING MP (res² × elongation), so a wide
	// source prices its real extra work: at 2.39:1 even the base 980 costs
	// 2.39/1.7̄8 = 1.3444× the 16:9 anchor. Unknown dims fall back to 16:9.
	q := quoteStep(t, StepInputs{
		Step: "depth_preview", Preset: "draft", BillableS: 1200,
		DepthRes: 980, ContentWidth: 2390, ContentHeight: 1000,
	})
	if got := q.Breakdown["depth_res_factor"].(float64); got != 1.3444 {
		t.Errorf("2.39:1 factor: want 1.3444, got %v", got)
	}
	// 2500 + round(2500×0.3444) = 3361 → −336 bulk = 3025
	if q.AmountCents != 3025 {
		t.Errorf("want 3025, got %d", q.AmountCents)
	}
	// orientation-agnostic: portrait prices like landscape
	portrait := quoteStep(t, StepInputs{
		Step: "depth_preview", Preset: "draft", BillableS: 1200,
		DepthRes: 980, ContentWidth: 1000, ContentHeight: 2390,
	})
	if portrait.AmountCents != q.AmountCents {
		t.Errorf("portrait %d != landscape %d", portrait.AmountCents, q.AmountCents)
	}
	// dims unknown → 16:9 assumed → legacy quadratic (factor 1 at base)
	unknown := quoteStep(t, StepInputs{
		Step: "depth_preview", Preset: "draft", BillableS: 1200, DepthRes: 980,
	})
	if got := unknown.Breakdown["depth_res_factor"].(float64); got != 1.0 {
		t.Errorf("unknown dims factor: want 1.0, got %v", got)
	}
}

func TestQuoteStepDepthFactorUsesDepthShare(t *testing.T) {
	// stereo_preview / production scale only the depth share (0.35 default).
	// stereo: 10 min × 200 = 2000¢; factor 4 → 2000 + round(2000·0.35·3) =
	// 4100 → −410 bulk = 3690
	q := quoteStep(t, StepInputs{
		Step: "stereo_preview", Preset: "1080p", BillableS: 600, DepthRes: 1960,
	})
	if q.AmountCents != 3690 {
		t.Errorf("stereo_preview want 3690, got %d", q.AmountCents)
	}
	// production: 2 min 1080p = 500¢; factor 4 → 500 + round(500·0.35·3) =
	// 1025 → −103 bulk = 922 (and no inpaint multiplier on production)
	q = quoteStep(t, StepInputs{
		Step: "production", Preset: "1080p", BillableS: 120, DepthRes: 1960,
		Inpaint: "propainter",
	})
	if q.AmountCents != 922 {
		t.Errorf("production want 922, got %d", q.AmountCents)
	}
}

func TestQuoteStepInpaintMultiplier(t *testing.T) {
	// stereo_preview 10 min = 2000¢; propainter ×1.6 = 3200 → −320 = 2880
	q := quoteStep(t, StepInputs{
		Step: "stereo_preview", Preset: "1080p", BillableS: 600, Inpaint: "propainter",
	})
	if q.AmountCents != 2880 {
		t.Errorf("want 2880, got %d", q.AmountCents)
	}
	if got := q.Breakdown["inpaint_multiplier"].(float64); got != 1.6 {
		t.Errorf("want inpaint_multiplier 1.6, got %v", got)
	}
	// inpaint=none → no multiplier: 2000 → −200 = 1800
	q = quoteStep(t, StepInputs{
		Step: "stereo_preview", Preset: "1080p", BillableS: 600, Inpaint: "none",
	})
	if q.AmountCents != 1800 {
		t.Errorf("want 1800, got %d", q.AmountCents)
	}
}

func TestQuoteStepDepthResThenInpaintOrder(t *testing.T) {
	// stereo 10 min 2000¢; depth 140 → 2000 − round(2000·0.35·0.5) = 1650;
	// then propainter ×1.6 = 2640 → −264 bulk = 2376.
	q := quoteStep(t, StepInputs{
		Step: "stereo_preview", Preset: "1080p", BillableS: 600, DepthRes: 140,
		Inpaint: "propainter",
	})
	if q.AmountCents != 2376 {
		t.Errorf("want 2376, got %d", q.AmountCents)
	}
}

func TestQuoteStepReuseDiscountOnAdjustedSubtotal(t *testing.T) {
	// production 4 min = 1000¢; factor 4 → 2050¢; depth reuse −round(2050·0.35)=718
	// → 1332 → −133 bulk = 1199
	q := quoteStep(t, StepInputs{
		Step: "production", Preset: "1080p", BillableS: 240, DepthRes: 1960,
		Inpaint: "propainter", ReuseStages: []string{"depth"},
	})
	if q.AmountCents != 1199 {
		t.Errorf("want 1199, got %d", q.AmountCents)
	}
	if got := q.Breakdown["reuse_discount_cents"].(int64); got != 718 {
		t.Errorf("want reuse discount 718, got %v", got)
	}
}

func TestQuoteStepDepthResMinimumStillApplies(t *testing.T) {
	// 20s depth_preview = 42¢; factor 0.5 → 21¢ → floors at 50¢.
	q := quoteStep(t, StepInputs{
		Step: "depth_preview", Preset: "draft", BillableS: 20, DepthRes: 140,
	})
	if q.AmountCents != 50 {
		t.Errorf("want minimum 50, got %d", q.AmountCents)
	}
}

func TestQuoteStepUnknownStep(t *testing.T) {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	if _, err := s.QuoteStep(context.Background(), StepInputs{Step: "mystery", Preset: "1080p", BillableS: 60}); err == nil {
		t.Error("want error for unknown step")
	}
}

// The calibration anchor: job 4cd27aa0aaee (2026-07-03) — 149.46s 4K 2.39:1
// letterboxed source (content 3840×1606) @24fps, depth_res 1596 — cost
// $5.59 raw and took 1584s wall. The model must price ≈2× raw and estimate
// the wall clock within ~15%.
func TestCalibrationAnchorMeasuredRun(t *testing.T) {
	in := StepInputs{
		Step: "depth_preview", Preset: "draft", BillableS: 149.458333,
		DepthRes: 1596, ContentWidth: 3840, ContentHeight: 1606,
		EffectiveFPS: 24,
	}
	q := quoteStep(t, in)
	// raw $5.59 → 2× ≈ $11.17; accept a ±15% calibration band
	if q.AmountCents < 950 || q.AmountCents > 1285 {
		t.Errorf("calibration run: want ≈1117¢ (2× raw $5.59), got %d", q.AmountCents)
	}
	s := stepSvc()
	eta := s.EstimateStepETA(context.Background(), in)
	if eta < 1350 || eta > 1800 {
		t.Errorf("calibration run: want eta ≈1584s ±15%%, got %d", eta)
	}
}

func TestQuoteImage(t *testing.T) {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	q, err := s.QuoteImage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 50 {
		t.Errorf("want 50, got %d", q.AmountCents)
	}
}

// --------------------------------------------------------------- ETA model

// The ETA model is additive: base + depth term + preset-keyed residual.
// The 4k anchor: job c51480d2c0aa (2026-07-03) — depth reused, 4k
// propainter stereo ran ≈45 min for 149.46s billable.
func TestETAStereoPreviewScalesByPreset(t *testing.T) {
	s := stepSvc()
	base := StepInputs{
		Step: "stereo_preview", BillableS: 149.458333, EffectiveFPS: 24,
		Inpaint: "propainter", ReuseStages: []string{"depth"},
	}
	in1080 := base
	in1080.Preset = "1080p"
	in4k := base
	in4k.Preset = "4k"
	eta1080 := s.EstimateStepETA(context.Background(), in1080)
	eta4k := s.EstimateStepETA(context.Background(), in4k)
	// 4k: 90 + 11 × 149.46 × 1.6 ≈ 2720s ≈ 45 min (the measured anchor);
	// 1080p: 90 + 3.5 × 149.46 × 1.6 ≈ 927s
	if eta4k < 2300 || eta4k > 3200 {
		t.Errorf("4k stereo preview: want ≈2720s (measured ≈45 min), got %d", eta4k)
	}
	if eta4k < 2*eta1080 {
		t.Errorf("4k must estimate ≥2× the 1080p wall (got %d vs %d)", eta4k, eta1080)
	}
}

func TestETADepthTermZeroedOnReuseAndUpload(t *testing.T) {
	s := stepSvc()
	fresh := StepInputs{
		Step: "stereo_preview", Preset: "4k", BillableS: 149.458333,
		EffectiveFPS: 24, Inpaint: "propainter",
		DepthRes: 1596, ContentWidth: 3840, ContentHeight: 1606,
	}
	reused := fresh
	reused.ReuseStages = []string{"depth"}
	uploaded := fresh
	uploaded.DepthRes = 0 // user-provided depth map: no inference at all

	etaFresh := s.EstimateStepETA(context.Background(), fresh)
	etaReused := s.EstimateStepETA(context.Background(), reused)
	etaUploaded := s.EstimateStepETA(context.Background(), uploaded)
	// fresh adds the depth term: 2.8 × 149.46 × 3.57 ≈ 1493s on top
	if diff := etaFresh - etaReused; diff < 1200 || diff > 1800 {
		t.Errorf("fresh−reused: want the ≈1493s depth term, got %d (%d vs %d)",
			diff, etaFresh, etaReused)
	}
	if etaReused != etaUploaded {
		t.Errorf("reused (%d) and user-provided (%d) depth must estimate the same",
			etaReused, etaUploaded)
	}
}

func TestQuoteStepStereoPreviewScalesByPreset(t *testing.T) {
	// A 4k stereo preview does ~2.5× the splat/inpaint work of 1080p — the
	// old flat 200¢/min rate underpriced it (the 2026-07-03 4k run billed
	// $14.31 against a $9.09 quote). Rates target ~2× BILLED cost (billed
	// ≈ 1.2× the in-source estimate). 10 min: 1080p 2000¢ vs 4k 5000¢
	// (before depth factor / inpaint / discounts).
	q1080 := quoteStep(t, StepInputs{Step: "stereo_preview", Preset: "1080p", BillableS: 600})
	q4k := quoteStep(t, StepInputs{Step: "stereo_preview", Preset: "4k", BillableS: 600})
	if q1080.Breakdown["base_cents"].(int64) != 2000 {
		t.Errorf("1080p base: want 2000, got %v", q1080.Breakdown["base_cents"])
	}
	if q4k.Breakdown["base_cents"].(int64) != 5000 {
		t.Errorf("4k base: want 5000, got %v", q4k.Breakdown["base_cents"])
	}
}
