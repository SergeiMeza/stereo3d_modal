package pricing

import "testing"

// Smoother motion (owner 2026-11-10): +10% of the run's base on every plan,
// with the other add-ons, after the plan price, before the minimum.
func TestStabilizeAddOn(t *testing.T) {
	min1 := StepInputs{Step: "production", Preset: "4k", BillableS: 60, EffectiveFPS: 24, Stabilize: true}
	cases := []struct {
		name string
		in   StepInputs
		want int64
	}{
		{"list", min1, 1760}, // 1600 + 160
		// 1600 + 160 + 800 commercial + 800 express = 3360
		{"with commercial and express", with(min1, func(i *StepInputs) { i.Commercial, i.Express = true, true }), 3360},
		{"pro", with(min1, func(i *StepInputs) { i.Tier = TierPro }), 1496},           // 1360 × 1.1
		{"business", with(min1, func(i *StepInputs) { i.Tier = TierBusiness }), 1408}, // 1280 × 1.1
		{"without", with(min1, func(i *StepInputs) { i.Stabilize = false }), 1600},
	}
	for _, c := range cases {
		if q := tierQuoteOf(t, c.in); q.AmountCents != c.want {
			t.Errorf("%s: %d, want %d %v", c.name, q.AmountCents, c.want, q.Breakdown)
		}
	}
	q := tierQuoteOf(t, min1)
	if q.Breakdown["stabilize"] != true || q.Breakdown["stabilize_cents"] != int64(160) || q.Breakdown["stabilize_label"] != "Smoother motion +10%" {
		t.Errorf("breakdown: %v", q.Breakdown)
	}
	// a 5 s preview: its share is on the frames, then the per-run minimum
	r := DefaultsFor("test")
	pv := tierQuoteOf(t, StepInputs{Step: StepLifelikePreview, Preset: "4k", BillableS: 5, EffectiveFPS: 24, Stabilize: true})
	if pv.AmountCents < r.MinimumFor(StepLifelikePreview) || pv.Breakdown["stabilize_cents"] == nil {
		t.Errorf("preview: %d %v", pv.AmountCents, pv.Breakdown)
	}
	out := map[string]any{}
	r.publicTiers(out, []string{"4k"})
	if a, _ := out["addons"].(map[string]any)[AddOnStabilize].(map[string]any); a == nil || a["pct"] != 0.10 {
		t.Errorf("listed: %v", out["addons"])
	}
}
