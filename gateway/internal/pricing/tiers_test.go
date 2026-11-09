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
	// 2:10 of 4K list: 3 × 1600; the breakdown says so.
	q := tierQuoteOf(t, StepInputs{Step: "production", Preset: "4k", BillableS: 130, EffectiveFPS: 24})
	if q.AmountCents != 4800 || q.Breakdown["billable_minutes"] != int64(3) {
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
		{"list 4k", min1, 1600, ""}, // 4× 1080p (owner 2026-11-07)
		{"pro 4k", with(min1, func(i *StepInputs) { i.Tier = TierPro }), 1360, "tier"},
		{"business 4k", with(min1, func(i *StepInputs) { i.Tier = TierBusiness }), 1280, "tier"},
		{"studio 1080p", with(min1, func(i *StepInputs) { i.Tier, i.Preset = TierStudio, "1080p" }), 300, "tier"},
		{"30 fps", with(min1, func(i *StepInputs) { i.EffectiveFPS = 30 }), 2000, ""},
		// owner 2026-11-09: Lifelike's fps factor has no ceiling, 120 fps = 5×
		{"business 60 fps", with(min1, func(i *StepInputs) { i.Tier, i.EffectiveFPS = TierBusiness, 60 }), 3200, "tier"},
		{"business 120 fps", with(min1, func(i *StepInputs) { i.Tier, i.EffectiveFPS = TierBusiness, 120 }), 6400, "tier"},
		// add-ons on the base: 1600 + 800 (foveated 50%, owner 2026-11-09) + 800 (master 50%) + 800 (express 50%) = 4000, not over $50
		{"all add-ons", with(min1, func(i *StepInputs) { i.Foveated, i.Master, i.Express = true, true, true }), 4000, ""},
		{"express", with(min1, func(i *StepInputs) { i.Express = true }), 2400, ""},
		{"master", with(min1, func(i *StepInputs) { i.Master = true }), 2400, ""},
		{"quality master", with(min1, func(i *StepInputs) { i.Quality = QualityMaster }), 2400, ""},
		{"quality high", with(min1, func(i *StepInputs) { i.Quality = QualityHigh }), 2080, ""},
		{"standard is free", with(min1, func(i *StepInputs) { i.Quality = QualityStandard }), 1600, ""},
		{"one quality add-on per run", with(min1, func(i *StepInputs) { i.Master, i.Quality = true, QualityHigh }), 2400, ""},
		{"business pays high", with(min1, func(i *StepInputs) { i.Tier, i.Quality = TierBusiness, QualityHigh }), 1664, "tier"},
		{"master and express", with(min1, func(i *StepInputs) { i.Master, i.Express = true, true }), 3200, ""},
		{"pro master and express", with(min1, func(i *StepInputs) { i.Tier, i.Master, i.Express = TierPro, true, true }), 2720, "tier"},
		// Express included for Business: 1280 + 50% foveated
		{"business express", with(min1, func(i *StepInputs) { i.Tier, i.Express, i.Foveated = TierBusiness, true, true }), 1920, "tier"},
		// 6 min of 4K list = 9600 > 5000 → bulk 960 → 8640
		{"bulk", with(min1, func(i *StepInputs) { i.BillableS = 360 }), 8640, "bulk"},
		// Pro 6 min = 8160 beats bulk 8640: the tier, not both
		{"pro beats bulk", with(min1, func(i *StepInputs) { i.BillableS, i.Tier = 360, TierPro }), 8160, "tier"},
		// 8k list 6 min = 38400 → bulk 34560; Pro 32640 wins
		{"no stacking", with(min1, func(i *StepInputs) { i.BillableS, i.Preset, i.Tier = 360, "8k", TierPro }), 32640, "tier"},
		{"first minute", with(min1, func(i *StepInputs) { i.BillableS = 3 }), 1600, ""}, // rounded up to 1 min
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
	if q.AmountCents != 0 || q.Breakdown["free_preview"] != true || q.Breakdown["price_without_free_cents"] != int64(133) {
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
	if err != nil || q.AmountCents != 1600 {
		t.Fatalf("quote %v %v", q, err)
	}
	raw, _ := json.Marshal(map[string]any{"quote": q.Breakdown, "public": NewStatic(on).Public(ctx)})
	if strings.Contains(string(raw), "hdr") {
		t.Fatalf("hdr priced: %s", raw)
	}
}

// Quality tiers in Mbit/s: the 1080p and 4K anchors, by pixels between,
// ×1.4 above 30 fps for standard and high, master not.
func TestQualityMbps(t *testing.T) {
	r := DefaultsFor("test")
	for _, tc := range []struct {
		tier string
		w, h int
		fps  float64
		want float64
	}{
		{QualityStandard, 1920, 1080, 24, 25}, {QualityStandard, 3840, 2160, 25, 40}, {QualityStandard, 1920, 1080, 60, 35},
		{QualityHigh, 1920, 1080, 30, 40}, {QualityHigh, 3840, 2160, 60, 112}, {QualityMaster, 3840, 2160, 60, 150},
		{QualityMaster, 1920, 1080, 24, 100}, {QualityHigh, 2560, 1440, 24, 50.4},
	} {
		if got := r.QualityMbps(tc.tier, tc.w, tc.h, tc.fps); got != tc.want {
			t.Errorf("%s %dx%d@%v: %v, want %v", tc.tier, tc.w, tc.h, tc.fps, got, tc.want)
		}
	}
	r.QualityHighMbps = map[string]float64{"1080p": 50, "4k": 90}
	if r.QualityMbps(QualityHigh, 1920, 1080, 24) != 50 || r.QualityBitDepth() != 10 {
		t.Fatal("config")
	}
}
