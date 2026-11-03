package pricing

import (
	"context"
	"testing"
)

func tierQuoteOf(t *testing.T, in StepInputs) *Quote {
	t.Helper()
	q, err := NewStatic(DefaultsFor("test")).QuoteLifelike(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	return q
}

// 2026-11 pricing on test: list and tier tables, add-ons on top, bulk
// over $50 never stacked with a tier; prod unchanged.
func TestTierPricing(t *testing.T) {
	min1 := StepInputs{Step: "production", Preset: "4k", BillableS: 60, EffectiveFPS: 24}
	cases := []struct {
		name string
		in   StepInputs
		want int64
		kind string
	}{
		{"list 4k", min1, 1000, ""},
		{"pro 4k", with(min1, func(i *StepInputs) { i.Tier = TierPro }), 850, "tier"},
		{"business 4k", with(min1, func(i *StepInputs) { i.Tier = TierBusiness }), 750, "tier"},
		{"studio 1080p", with(min1, func(i *StepInputs) { i.Tier, i.Preset = TierStudio, "1080p" }), 280, "tier"},
		{"30 fps", with(min1, func(i *StepInputs) { i.EffectiveFPS = 30 }), 1250, ""},
		// add-ons on the base: 1000 + 300 + 200 + 500
		{"all add-ons", with(min1, func(i *StepInputs) { i.Foveated, i.Master, i.Express = true, true, true }), 2000, ""},
		// Express included for Business: 750 + 30% foveated
		{"business express", with(min1, func(i *StepInputs) { i.Tier, i.Express, i.Foveated = TierBusiness, true, true }), 975, "tier"},
		// 6 min of 4K list = 6000 > 5000 → bulk 600 → 5400
		{"bulk", with(min1, func(i *StepInputs) { i.BillableS = 360 }), 5400, "bulk"},
		// Pro 6 min = 5100 beats bulk 5400: the tier, not both
		{"pro beats bulk", with(min1, func(i *StepInputs) { i.BillableS, i.Tier = 360, TierPro }), 5100, "tier"},
		// 8k list 6 min = 16800 → bulk 15120; Pro 14280 wins
		{"no stacking", with(min1, func(i *StepInputs) { i.BillableS, i.Preset, i.Tier = 360, "8k", TierPro }), 14280, "tier"},
		{"minimum", with(min1, func(i *StepInputs) { i.BillableS = 3 }), 100, ""},
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
	// A free preview quotes $0 and says what it would cost.
	q := tierQuoteOf(t, StepInputs{Step: StepLifelikePreview, Preset: "4k", BillableS: 5, EffectiveFPS: 24, FreePreview: true, Units: 1})
	if q.AmountCents != 0 || q.Breakdown["free_preview"] != true || q.Breakdown["price_without_free_cents"] != int64(100) {
		t.Errorf("free preview: %d %v", q.AmountCents, q.Breakdown)
	}
	// Prod keeps today's table.
	prod, _ := NewStatic(DefaultsFor("prod")).QuoteLifelike(context.Background(), min1)
	if prod.AmountCents != 850 {
		t.Errorf("prod 4k: %d", prod.AmountCents)
	}
	r := DefaultsFor("test")
	if r.PreviewUnits("4k", 5, 24) != 1 || r.PreviewUnits("4k", 8, 24) != 2 || r.PreviewUnits("8k", 5, 24) != 2 || r.PreviewUnits("4k", 5, 60) != 2 {
		t.Error("preview units")
	}
}

func with(in StepInputs, f func(*StepInputs)) StepInputs { f(&in); return in }
