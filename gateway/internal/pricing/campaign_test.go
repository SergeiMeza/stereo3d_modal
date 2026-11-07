package pricing

import (
	"context"
	"testing"
	"time"
)

// The launch offer: web Lifelike production at 1080p and 1440p only,
// after the tier discount, on base plus add-ons, the minimum still
// holds; never on previews, the app, 3K and above, or outside its dates.
func TestCampaign(t *testing.T) {
	r := DefaultsFor("test")
	now := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	quote := func(in StepInputs) (int64, map[string]any) {
		t.Helper()
		in.Step, in.BillableS, in.EffectiveFPS, in.Now = "production", 60, 24, now
		q, err := r.quoteLifelikeTiers(in, r.LifelikePriceCentsPerMinute[in.Preset])
		if err != nil {
			t.Fatal(err)
		}
		return q.AmountCents, q.Breakdown
	}
	base, _ := quote(StepInputs{Preset: "1080p"})
	got, bd := quote(StepInputs{Preset: "1080p", Web: true})
	if want := base - int64(float64(base)*0.25+0.5); got != want || bd["campaign_cents"] != base-got || bd["campaign_label"] != "Launch offer −25%" ||
		bd["campaign_name"] != "Launch offer until Jan 10" {
		t.Fatalf("1080p %d → %d %v", base, got, bd)
	}
	high, _ := quote(StepInputs{Preset: "qhd", Quality: AddOnHigh})
	got, bd = quote(StepInputs{Preset: "qhd", Quality: AddOnHigh, Web: true})
	if bd["campaign_cents"].(int64) != int64(float64(high)*0.25+0.5) { // the whole run, quality included
		t.Fatalf("qhd high %d → %d %v", high, got, bd)
	}
	pro, _ := quote(StepInputs{Preset: "qhd", Tier: TierPro})
	got, bd = quote(StepInputs{Preset: "qhd", Tier: TierPro, Web: true})
	if got != pro-bd["campaign_cents"].(int64) || bd["campaign_cents"].(int64) != int64(float64(pro)*0.25+0.5) { // after the plan's price
		t.Fatalf("pro %d → %d", pro, got)
	}
	for name, in := range map[string]StepInputs{
		"3k":         {Preset: "3k", Web: true},
		"4k":         {Preset: "4k", Web: true},
		"app":        {Preset: "1080p"},
		"output 3k":  {Preset: "qhd", OutputPreset: "3k", Web: true},
		"before":     {Preset: "1080p", Web: true, Now: time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC)},
		"after":      {Preset: "1080p", Web: true, Now: time.Date(2027, 1, 11, 8, 0, 0, 0, time.UTC)},
		"switch off": {Preset: "1080p", Web: true, Tier: "off"},
	} {
		rr := r
		if name == "switch off" {
			cp := *r
			c := *r.Campaign
			c.Enabled = false
			cp.Campaign = &c
			rr = &cp
			in.Tier = ""
		}
		in.Step, in.BillableS, in.EffectiveFPS = "production", 60, 24
		if in.Now.IsZero() {
			in.Now = now
		}
		q, _ := rr.quoteLifelikeTiers(in, rr.LifelikePriceCentsPerMinute[in.Preset])
		if q.Breakdown["campaign_cents"] != int64(0) {
			t.Errorf("%s: %v", name, q.Breakdown["campaign_cents"])
		}
	}
	// a short clip: the minimum holds after the offer
	in := StepInputs{Step: "production", Preset: "1080p", BillableS: 1, EffectiveFPS: 24, Web: true, Now: now}
	if q, _ := r.quoteLifelikeTiers(in, r.LifelikePriceCentsPerMinute["1080p"]); q.AmountCents < r.MinimumFor("production") {
		t.Fatalf("below the minimum: %d", q.AmountCents)
	}
	// previews get nothing
	in = StepInputs{Step: StepLifelikePreview, Preset: "1080p", BillableS: 5, EffectiveFPS: 24, Web: true, Now: now}
	if q, _ := r.quoteLifelikeTiers(in, r.LifelikePriceCentsPerMinute["1080p"]); q.Breakdown["campaign_cents"] != int64(0) {
		t.Fatal("preview")
	}
	pub := r.PublicCampaign(now)
	if m, _ := pub["methods"].([]string); len(m) != 2 || m[1] != "classic" {
		t.Fatalf("methods %v", pub["methods"])
	}
	if pub["active"] != true || pub["pct"] != 0.25 || pub["percent"] != 25 || pub["max_preset"] != "qhd" || len(pub["presets"].([]string)) != 2 || pub["ends_at"] == nil {
		t.Fatalf("public %v", pub)
	}
	if DefaultsFor("prod").PublicCampaign(now)["active"] != false {
		t.Fatal("prod has none")
	}
	r2 := *r
	c := *r.Campaign
	c.Pct, c.EndsAt = 0.25, nil
	r2.Campaign = &c
	if r2.CampaignShare() != 0.25 || !r2.CampaignActive(time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatal("fraction or open-ended")
	}
}

// The offer on Classic (owner 2026-11-07: "web app only", "up to 2K"):
// web production at 1080p and 1440p only, with the same label; never the
// app, previews, draft or 3K; prod has no campaign until the release.
func TestCampaignClassic(t *testing.T) {
	s := NewStatic(DefaultsFor("test"))
	ctx := context.Background()
	q := func(step, preset string, web bool) *Quote {
		t.Helper()
		out, err := s.QuoteStep(ctx, StepInputs{Step: step, Preset: preset, OutputPreset: preset, BillableS: 60, EffectiveFPS: 24, SourceFPS: 24,
			DepthRes: PresetInputSize[preset], Web: web})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	for _, preset := range []string{"1080p", "qhd"} {
		app, web := q("production", preset, false), q("production", preset, true)
		if web.Breakdown["campaign_cents"].(int64) <= 0 || web.AmountCents != app.AmountCents-web.Breakdown["campaign_cents"].(int64) ||
			web.Breakdown["campaign_label"] != "Launch offer −25%" || app.Breakdown["campaign_cents"] != int64(0) {
			t.Fatalf("%s: app %d web %d %v", preset, app.AmountCents, web.AmountCents, web.Breakdown)
		}
	}
	for _, c := range []struct{ step, preset string }{{"production", "3k"}, {"production", "draft"}, {"stereo_preview", "1080p"}, {"depth_preview", "1080p"}} {
		if got := q(c.step, c.preset, true).Breakdown["campaign_cents"]; got != int64(0) {
			t.Errorf("%s %s: %v", c.step, c.preset, got)
		}
	}
	prod := NewStatic(DefaultsFor("prod"))
	out, _ := prod.QuoteStep(ctx, StepInputs{Step: "production", Preset: "1080p", OutputPreset: "1080p", BillableS: 60, EffectiveFPS: 24, SourceFPS: 24,
		DepthRes: 980, Web: true})
	if out.Breakdown["campaign_cents"] != int64(0) {
		t.Fatal("prod has no campaign yet")
	}
}
