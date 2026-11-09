package pricing

import (
	"context"
	"testing"
)

// Commercial use (owner 2026-11-09): +50% of the run's base on every plan,
// with the other add-ons, after the plan price, before the minimum.
func TestCommercialUse(t *testing.T) {
	min1 := StepInputs{Step: "production", Preset: "4k", BillableS: 60, EffectiveFPS: 24, Commercial: true}
	cases := []struct {
		name string
		in   StepInputs
		want int64
		kind string
	}{
		{"list", min1, 2400, ""}, // 1600 + 800
		// 1600 + 800 commercial + 800 express + 480 high = 3680
		{"express and high", with(min1, func(i *StepInputs) { i.Express, i.Quality = true, QualityHigh }), 3680, ""},
		{"master", with(min1, func(i *StepInputs) { i.Quality = QualityMaster }), 3200, ""},
		{"pro", with(min1, func(i *StepInputs) { i.Tier = TierPro }), 2040, "tier"},           // 1360 × 1.5
		{"business", with(min1, func(i *StepInputs) { i.Tier = TierBusiness }), 1920, "tier"}, // 1280 × 1.5
		// Studio: 1200 + commercial 600 + master 600; Express stays included
		{"studio master express", with(min1, func(i *StepInputs) { i.Tier, i.Quality, i.Express = TierStudio, QualityMaster, true }), 2400, "tier"},
		// a grandfathered plan: included, no charge
		{"business included", with(min1, func(i *StepInputs) { i.Tier, i.CommercialIncluded = TierBusiness, true }), 1280, "tier"},
		// 6 min list 9600 × 1.5 = 14400 → bulk 12960; Pro 8160 × 1.5 = 12240 wins
		{"pro beats bulk", with(min1, func(i *StepInputs) { i.BillableS, i.Tier = 360, TierPro }), 12240, "tier"},
		{"bulk", with(min1, func(i *StepInputs) { i.BillableS = 360 }), 12960, "bulk"},
	}
	for _, c := range cases {
		q := tierQuoteOf(t, c.in)
		kind := ""
		if d, ok := q.Breakdown["discount"].(map[string]any); ok && d != nil {
			kind, _ = d["kind"].(string)
		}
		if q.AmountCents != c.want || kind != c.kind {
			t.Errorf("%s: %d (%s), want %d (%s) %v", c.name, q.AmountCents, kind, c.want, c.kind, q.Breakdown)
		}
	}
	q := tierQuoteOf(t, min1)
	if q.Breakdown["commercial"] != true || q.Breakdown["commercial_cents"] != int64(800) || q.Breakdown["commercial_label"] != "Commercial use +50%" {
		t.Errorf("breakdown: %v", q.Breakdown)
	}
	q = tierQuoteOf(t, with(min1, func(i *StepInputs) { i.Tier, i.CommercialIncluded = TierStudio, true }))
	if q.Breakdown["commercial"] != true || q.Breakdown["commercial_included"] != true || q.Breakdown["commercial_cents"] != nil {
		t.Errorf("included breakdown: %v", q.Breakdown)
	}
	if q := tierQuoteOf(t, with(min1, func(i *StepInputs) { i.Commercial = false })); q.Breakdown["commercial"] != false || q.AmountCents != 1600 {
		t.Errorf("without: %d %v", q.AmountCents, q.Breakdown)
	}
}

// A preview's commercial share is on its frames, and the per-run minimum
// still applies after it.
func TestCommercialPreviewAndMinimum(t *testing.T) {
	r := DefaultsFor("test")
	// 4K 5 s at 24 fps: 120 frames → 133; +67 = 200
	q := tierQuoteOf(t, StepInputs{Step: StepLifelikePreview, Preset: "4k", BillableS: 5, EffectiveFPS: 24, Commercial: true})
	if want := max(int64(200), r.MinimumFor(StepLifelikePreview)); q.AmountCents != want {
		t.Errorf("preview: %d, want %d %v", q.AmountCents, want, q.Breakdown)
	}
	// a 1 s 1080p preview is under the minimum either way
	tiny := StepInputs{Step: StepLifelikePreview, Preset: "1080p", BillableS: 1, EffectiveFPS: 24}
	plain := tierQuoteOf(t, tiny)
	tiny.Commercial = true
	com := tierQuoteOf(t, tiny)
	if plain.AmountCents != r.MinimumFor(StepLifelikePreview) || com.AmountCents != plain.AmountCents {
		t.Errorf("minimum: plain %d commercial %d, minimum %d", plain.AmountCents, com.AmountCents, r.MinimumFor(StepLifelikePreview))
	}
}

// Classic isn't offered Commercial use: its quote ignores the flag.
func TestCommercialClassicUntouched(t *testing.T) {
	ctx := context.Background()
	s := NewStatic(DefaultsFor("test"))
	in := StepInputs{Step: "production", Preset: "1080p", BillableS: 120, EffectiveFPS: 24}
	a, err := s.QuoteStep(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	in.Commercial = true
	b, _ := s.QuoteStep(ctx, in)
	if a.AmountCents != b.AmountCents || b.Breakdown["commercial_cents"] != nil {
		t.Errorf("classic: %d vs %d %v", a.AmountCents, b.AmountCents, b.Breakdown)
	}
}

// /v1/pricing lists the add-on.
func TestCommercialListed(t *testing.T) {
	r := DefaultsFor("test")
	out := map[string]any{}
	r.publicTiers(out, []string{"4k"})
	c, ok := out["addons"].(map[string]any)[AddOnCommercial].(map[string]any)
	if !ok || c["pct"] != 0.5 {
		t.Fatalf("addons: %v", out["addons"])
	}
}
