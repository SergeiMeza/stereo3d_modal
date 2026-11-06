package pricing

import (
	"context"
	"encoding/json"
	"strings"
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
// Production bills whole minutes, rounded up on the run's total.
func TestBillableMinutes(t *testing.T) {
	for secs, want := range map[float64]int64{130: 3, 180: 3, 179.99999999: 3, 20: 1, 460 + 460: 16, 60: 1, 0: 0} {
		if got := BillableMinutes(secs); got != want {
			t.Errorf("%gs: %d min, want %d", secs, got, want)
		}
	}
	// 2:10 of 4K list: 3 × 1000; the breakdown says so.
	q := tierQuoteOf(t, StepInputs{Step: "production", Preset: "4k", BillableS: 130, EffectiveFPS: 24})
	if q.AmountCents != 3000 || q.Breakdown["billable_minutes"] != int64(3) {
		t.Fatalf("2:10: %d %v", q.AmountCents, q.Breakdown["billable_minutes"])
	}
	// A split run (7:40 + 7:40) is one range: ceil(15:20) = 16, not 8 + 8.
	q = tierQuoteOf(t, StepInputs{Step: "production", Preset: "1080p", BillableS: 920, EffectiveFPS: 24})
	if q.Breakdown["billable_minutes"] != int64(16) || q.Breakdown["list_base_cents"] != int64(16*400) {
		t.Fatalf("split: %v", q.Breakdown)
	}
	// Previews keep their exact length (per frame).
	p := tierQuoteOf(t, StepInputs{Step: StepLifelikePreview, Preset: "4k", BillableS: 5, EffectiveFPS: 24})
	if _, ok := p.Breakdown["billable_minutes"]; ok {
		t.Fatal("previews unchanged")
	}
}

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
		{"business 4k", with(min1, func(i *StepInputs) { i.Tier = TierBusiness }), 800, "tier"},
		{"studio 1080p", with(min1, func(i *StepInputs) { i.Tier, i.Preset = TierStudio, "1080p" }), 300, "tier"},
		{"30 fps", with(min1, func(i *StepInputs) { i.EffectiveFPS = 30 }), 1250, ""},
		// add-ons on the base: 1000 + 300 + 200 + 500
		{"all add-ons", with(min1, func(i *StepInputs) { i.Foveated, i.Master, i.Express = true, true, true }), 2000, ""},
		// Express included for Business: 800 + 30% foveated
		{"business express", with(min1, func(i *StepInputs) { i.Tier, i.Express, i.Foveated = TierBusiness, true, true }), 1040, "tier"},
		// 6 min of 4K list = 6000 > 5000 → bulk 600 → 5400
		{"bulk", with(min1, func(i *StepInputs) { i.BillableS = 360 }), 5400, "bulk"},
		// Pro 6 min = 5100 beats bulk 5400: the tier, not both
		{"pro beats bulk", with(min1, func(i *StepInputs) { i.BillableS, i.Tier = 360, TierPro }), 5100, "tier"},
		// 8k list 6 min = 16800 → bulk 15120; Pro 14280 wins
		{"no stacking", with(min1, func(i *StepInputs) { i.BillableS, i.Preset, i.Tier = 360, "8k", TierPro }), 14280, "tier"},
		{"first minute", with(min1, func(i *StepInputs) { i.BillableS = 3 }), 1000, ""}, // rounded up to 1 min
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
	if r.PreviewUnits("4k", 5, 24, 24) != 1 || r.PreviewUnits("4k", 8, 24, 24) != 2 || r.PreviewUnits("8k", 5, 24, 24) != 2 || r.PreviewUnits("4k", 5, 60, 60) != 2 {
		t.Error("preview units")
	}
}

// Started units count in source frames: an NTSC rate's frame-rounded 5 s
// (120 frames at 23.976 = 5.005 s) is one free preview, as are 150 at
// 29.97 and 300 at 59.94; one frame past a unit at an integer rate starts
// the next. Minutes the same way: 3:00 at 23.976 is 3, 3:00 + 1 frame at
// 24 is 4.
func TestStartedUnitsNTSC(t *testing.T) {
	r := DefaultsFor("test")
	for _, tc := range []struct {
		frames  int
		fps     float64
		units   int
		comment string
	}{
		{120, 23.976, 1, "the owner's 5 s preview"}, {120, 24000.0 / 1001, 1, "exact NTSC film"},
		{150, 29.97, 1, ""}, {150, 30000.0 / 1001, 1, ""}, {300, 59.94, 1, "×2 for 60 fps below"},
		{120, 24, 1, ""}, {150, 30, 1, ""}, {125, 25, 1, ""}, {300, 60, 1, ""},
		{121, 24, 2, "one frame over"}, {151, 30, 2, ""}, {121, 23.976, 2, "one frame over at NTSC"},
		{240, 23.976, 2, "10 s"}, {241, 24, 3, ""},
	} {
		secs := float64(tc.frames) / tc.fps
		want := tc.units
		if tc.fps >= 50 {
			want *= 2
		}
		if got := r.PreviewUnits("4k", secs, tc.fps, tc.fps); got != want {
			t.Errorf("%d frames at %v fps (%.4f s, %s): %d units, want %d", tc.frames, tc.fps, secs, tc.comment, got, want)
		}
	}
	// a half-rate quick look counts its source frames (the output rate only doubles for 60 fps)
	if got := r.PreviewUnits("1080p", 120/23.976, 23.976, 11.988); got != 1 {
		t.Errorf("quick look %d", got)
	}
	// no rate known: seconds, with a small tolerance
	if got := r.PreviewUnits("4k", 5, 0, 0); got != 1 {
		t.Errorf("no rate %d", got)
	}
	for _, tc := range []struct {
		frames int
		fps    float64
		want   int64
	}{{4316, 23.976, 3}, {4316, 24000.0 / 1001, 3}, {5395, 29.97, 3}, {10789, 59.94, 3}, {4320, 24, 3}, {4321, 24, 4}, {1, 24, 1}, {1439, 23.976, 1}, {1440, 23.976, 2}} {
		if got := BillableMinutesAt(float64(tc.frames)/tc.fps, tc.fps); got != tc.want {
			t.Errorf("minutes: %d frames at %v: %d, want %d", tc.frames, tc.fps, got, tc.want)
		}
	}
}

func with(in StepInputs, f func(*StepInputs)) StepInputs { f(&in); return in }

// HDR output is automatic and free (owner 2026-11-05): with it switched
// on, no quote, add-on list or plan mentions it.
func TestHDRHasNoPrice(t *testing.T) {
	ctx := context.Background()
	on := DefaultsFor("test")
	on.LifelikeHDROutputEnabled = true
	q, err := NewStatic(on).QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "4k", BillableS: 60, EffectiveFPS: 24})
	if err != nil || q.AmountCents != 1000 {
		t.Fatalf("quote %v %v", q, err)
	}
	raw, _ := json.Marshal(map[string]any{"quote": q.Breakdown, "public": NewStatic(on).Public(ctx)})
	if strings.Contains(string(raw), "hdr") {
		t.Fatalf("hdr priced: %s", raw)
	}
}
