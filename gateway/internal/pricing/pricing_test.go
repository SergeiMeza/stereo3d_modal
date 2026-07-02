package pricing

import (
	"context"
	"testing"
)

// quoteWith runs QuoteVideo against code defaults (nil Firestore client is
// never dereferenced because the cache is primed).
func quoteWith(t *testing.T, preset string, billableS float64) *Quote {
	t.Helper()
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	q, err := s.QuoteVideo(context.Background(), preset, billableS)
	if err != nil {
		t.Fatalf("QuoteVideo(%s, %v): %v", preset, billableS, err)
	}
	return q
}

func TestQuoteVideoMinimumCharge(t *testing.T) {
	q := quoteWith(t, "draft", 10) // 10s draft ≈ 5¢ → floor at 50¢
	if q.AmountCents != 50 {
		t.Errorf("want minimum 50, got %d", q.AmountCents)
	}
}

func TestQuoteVideoPerMinute(t *testing.T) {
	q := quoteWith(t, "1080p", 300) // 5 min × $1.00
	if q.AmountCents != 500 {
		t.Errorf("want 500, got %d", q.AmountCents)
	}
}

func TestQuoteVideoDiscountOverTenDollars(t *testing.T) {
	q := quoteWith(t, "4k", 300) // 5 min × $3.00 = 1500¢ → 10% off = 1350¢
	if q.AmountCents != 1350 {
		t.Errorf("want 1350, got %d", q.AmountCents)
	}
	if q.Breakdown["discount_cents"].(int64) != 150 {
		t.Errorf("want discount 150, got %v", q.Breakdown["discount_cents"])
	}
}

func TestQuoteVideoRoundsUpPartialMinutes(t *testing.T) {
	q := quoteWith(t, "1080p", 61) // 1.0167 min → 102¢ (ceil)
	if q.AmountCents != 102 {
		t.Errorf("want 102, got %d", q.AmountCents)
	}
}

func TestQuoteVideoUnknownPreset(t *testing.T) {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	if _, err := s.QuoteVideo(context.Background(), "8k", 60); err == nil {
		t.Error("want error for unknown preset")
	}
}

func TestQuoteStepPreviewRates(t *testing.T) {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	q, err := s.QuoteStep(context.Background(), "depth_preview", "draft", 300, 0, "", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 50 { // 5 min × 10¢ = 50¢
		t.Errorf("depth_preview want 50, got %d", q.AmountCents)
	}
	q, err = s.QuoteStep(context.Background(), "stereo_preview", "1080p", 600, 0, "", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 250 { // 10 min × 25¢
		t.Errorf("stereo_preview want 250, got %d", q.AmountCents)
	}
}

func TestQuoteStepProductionReuseDiscount(t *testing.T) {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	// 5 min 1080p = 500¢; depth share 0.35 → −175¢ = 325¢
	q, err := s.QuoteStep(context.Background(), "production", "1080p", 300, 0, "", []string{"depth"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 325 {
		t.Errorf("want 325, got %d", q.AmountCents)
	}
	if q.Breakdown["reuse_discount_cents"].(int64) != 175 {
		t.Errorf("want reuse discount 175, got %v", q.Breakdown["reuse_discount_cents"])
	}
}

func TestQuoteStepReuseIgnoredForPreviews(t *testing.T) {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	q, err := s.QuoteStep(context.Background(), "depth_preview", "draft", 300, 0, "", []string{"depth"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.Breakdown["reuse_discount_cents"].(int64) != 0 {
		t.Errorf("previews must not get reuse discounts, got %v", q.Breakdown["reuse_discount_cents"])
	}
}

func TestQuoteStepAnalyzeCreditAndFloor(t *testing.T) {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	// 2 min 1080p = 200¢ − 50¢ credit = 150¢
	q, err := s.QuoteStep(context.Background(), "production", "1080p", 120, 0, "", nil, 50)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 150 {
		t.Errorf("want 150, got %d", q.AmountCents)
	}
	// credit larger than the subtotal still floors at minimum_cents
	q, err = s.QuoteStep(context.Background(), "depth_preview", "draft", 60, 0, "", nil, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 50 {
		t.Errorf("want minimum 50, got %d", q.AmountCents)
	}
}

// stepSvc returns a Service primed with code defaults (nil Firestore is
// never dereferenced).
func stepSvc() *Service {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	return s
}

func TestQuoteStepDepthResFactorDepthPreview(t *testing.T) {
	// depth_preview is 100% depth work: the factor scales the whole step.
	// 20 min draft depth = 200¢ base.
	cases := []struct {
		depthRes   int
		wantCents  int64
		wantFactor float64
	}{
		{980, 200, 1.0},  // base resolution → 1×
		{140, 100, 0.5},  // (140/980)² ≈ 0.02 → clamped to the 0.5 floor
		{1960, 800, 4.0}, // (1960/980)² = 4 exactly
		{2520, 800, 4.0}, // (2520/980)² ≈ 6.6 → clamped to the 4.0 cap
		{0, 200, 1.0},    // absent → preset default, no factor
	}
	for _, c := range cases {
		q, err := stepSvc().QuoteStep(context.Background(), "depth_preview", "draft", 1200, c.depthRes, "", nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		if q.AmountCents != c.wantCents {
			t.Errorf("depth_res=%d: want %d, got %d", c.depthRes, c.wantCents, q.AmountCents)
		}
		if got := q.Breakdown["depth_res_factor"].(float64); got != c.wantFactor {
			t.Errorf("depth_res=%d: want factor %v, got %v", c.depthRes, c.wantFactor, got)
		}
	}
}

func TestQuoteStepDepthResFactorUsesDepthShare(t *testing.T) {
	// stereo_preview / production scale only the depth share (0.35 default).
	// stereo: 10 min = 250¢; factor 4 → 250 + round(250·0.35·3) = 513
	q, err := stepSvc().QuoteStep(context.Background(), "stereo_preview", "1080p", 600, 1960, "", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 513 {
		t.Errorf("stereo_preview want 513, got %d", q.AmountCents)
	}
	// production: 2 min 1080p = 200¢; factor 4 → 200 + round(200·0.35·3) = 410
	q, err = stepSvc().QuoteStep(context.Background(), "production", "1080p", 120, 1960, "propainter", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 410 { // and no inpaint multiplier on production
		t.Errorf("production want 410, got %d", q.AmountCents)
	}
}

func TestQuoteStepInpaintMultiplier(t *testing.T) {
	// stereo_preview 10 min = 250¢; propainter ×1.6 = 400¢
	q, err := stepSvc().QuoteStep(context.Background(), "stereo_preview", "1080p", 600, 0, "propainter", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 400 {
		t.Errorf("want 400, got %d", q.AmountCents)
	}
	if got := q.Breakdown["inpaint_multiplier"].(float64); got != 1.6 {
		t.Errorf("want inpaint_multiplier 1.6, got %v", got)
	}
	// inpaint=none → no multiplier
	q, err = stepSvc().QuoteStep(context.Background(), "stereo_preview", "1080p", 600, 0, "none", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 250 {
		t.Errorf("want 250, got %d", q.AmountCents)
	}
}

func TestQuoteStepDepthResThenInpaintOrder(t *testing.T) {
	// stereo 10 min 250¢; depth_res 140 → 250 − round(250·0.35·0.5) = 206;
	// then propainter ×1.6 → 330.
	q, err := stepSvc().QuoteStep(context.Background(), "stereo_preview", "1080p", 600, 140, "propainter", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 330 {
		t.Errorf("want 330, got %d", q.AmountCents)
	}
}

func TestQuoteStepReuseDiscountOnAdjustedSubtotal(t *testing.T) {
	// production 4 min = 400¢; factor 4 → 820¢; depth reuse −round(820·0.35)=287
	q, err := stepSvc().QuoteStep(context.Background(), "production", "1080p", 240, 1960, "propainter", []string{"depth"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 533 {
		t.Errorf("want 533, got %d", q.AmountCents)
	}
	if got := q.Breakdown["reuse_discount_cents"].(int64); got != 287 {
		t.Errorf("want reuse discount 287, got %v", got)
	}
}

func TestQuoteStepDepthResMinimumStillApplies(t *testing.T) {
	// 1 min depth_preview = 10¢; factor 0.5 → 5¢ → floors at 50¢.
	q, err := stepSvc().QuoteStep(context.Background(), "depth_preview", "draft", 60, 140, "", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if q.AmountCents != 50 {
		t.Errorf("want minimum 50, got %d", q.AmountCents)
	}
}

func TestQuoteStepUnknownStep(t *testing.T) {
	s := &Service{cached: defaults()}
	s.fetchedAt = maxTime()
	if _, err := s.QuoteStep(context.Background(), "mystery", "1080p", 60, 0, "", nil, 0); err == nil {
		t.Error("want error for unknown step")
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
