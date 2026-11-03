package pricing

import (
	"context"
	"testing"
)

// S3D-67: 20% off full runs for Pro, before the 10% over $10, $1 floor
// kept, never on previews, off unless enabled.
func TestProDiscount(t *testing.T) {
	ctx := context.Background()
	on := DefaultsFor("prod") // the S3D-67 path (tier pricing off)
	on.ProDiscountEnabled = true
	on.LifelikeEnabledPresets = LifelikePresets
	svc := NewStatic(on)
	q, err := svc.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "4k", BillableS: 120, EffectiveFPS: 24, Pro: true})
	if err != nil {
		t.Fatal(err)
	}
	// 1700 → Pro 340 → 1360 > 1000 → bulk 136 → 1224
	if q.AmountCents != 1224 || q.Breakdown["pro_discount_cents"] != int64(340) || q.Breakdown["discount_cents"] != int64(136) || q.Breakdown["pro_discount_pct"] != 0.2 {
		t.Errorf("lifelike pro: %d %v", q.AmountCents, q.Breakdown)
	}
	list, _ := svc.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "4k", BillableS: 120, EffectiveFPS: 24})
	if list.AmountCents != 1530 || list.Breakdown["pro_discount_cents"] != int64(0) {
		t.Errorf("list: %d %v", list.AmountCents, list.Breakdown)
	}
	// 5K minute: 1300 → 1040 → still over $10 → 936
	q, _ = svc.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "5k", BillableS: 60, EffectiveFPS: 24, Pro: true})
	if q.AmountCents != 936 {
		t.Errorf("5k pro: %d %v", q.AmountCents, q.Breakdown)
	}
	// Pro brings 1134 under the bulk threshold: 907, no bulk
	q, _ = svc.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "4k", BillableS: 80, EffectiveFPS: 24, Pro: true})
	if q.AmountCents != 907 || q.Breakdown["discount_cents"] != int64(0) {
		t.Errorf("4k 80 s pro: %d %v", q.AmountCents, q.Breakdown)
	}
	// floor stays
	q, _ = svc.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "1080p", BillableS: 10, EffectiveFPS: 24, Pro: true})
	if q.AmountCents != 100 {
		t.Errorf("floor: %d", q.AmountCents)
	}
	// previews: no Pro line
	p, _ := svc.QuoteLifelike(ctx, StepInputs{Step: StepLifelikePreview, Preset: "4k", BillableS: 10, EffectiveFPS: 24, Pro: true})
	pl, _ := svc.QuoteLifelike(ctx, StepInputs{Step: StepLifelikePreview, Preset: "4k", BillableS: 10, EffectiveFPS: 24})
	if p.AmountCents != pl.AmountCents || p.Breakdown["pro"] != true {
		t.Errorf("preview: %d vs %d %v", p.AmountCents, pl.AmountCents, p.Breakdown)
	}
	// Classic production too, previews not
	c, _ := svc.QuoteStep(ctx, StepInputs{Step: "production", Preset: "1080p", BillableS: 60, EffectiveFPS: 24, Pro: true})
	cl, _ := svc.QuoteStep(ctx, StepInputs{Step: "production", Preset: "1080p", BillableS: 60, EffectiveFPS: 24})
	if c.AmountCents >= cl.AmountCents {
		t.Errorf("classic pro not cheaper: %d vs %d", c.AmountCents, cl.AmountCents)
	}
	sp, _ := svc.QuoteStep(ctx, StepInputs{Step: "stereo_preview", Preset: "1080p", BillableS: 30, EffectiveFPS: 24, Pro: true})
	if sp.Breakdown["pro_discount_cents"] != int64(0) {
		t.Errorf("classic preview: %v", sp.Breakdown)
	}
	// prod default: off
	off := NewStatic(DefaultsFor("prod"))
	q, _ = off.QuoteLifelike(ctx, StepInputs{Step: "production", Preset: "4k", BillableS: 120, EffectiveFPS: 24, Pro: true})
	if q.AmountCents != 1530 {
		t.Errorf("prod default should be off: %d", q.AmountCents)
	}
	r := DefaultsFor("test")
	r.ProDiscountPct = 0.15
	if r.ProDiscount() != 0.15 {
		t.Error("pct override")
	}
}
