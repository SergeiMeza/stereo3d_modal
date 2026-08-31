package pricing

import (
	"context"
	"testing"
)

// migan: the middle ground — none < migan < propainter in both steps.
func TestQuoteStepMiganMultipliers(t *testing.T) {
	// stereo_preview 10 min = 3600¢ baseline; migan ×1.15 = 4140 → −414 bulk = 3726
	q := quoteStep(t, StepInputs{Step: "stereo_preview", Preset: "1080p", BillableS: 600, Inpaint: "migan"})
	if q.AmountCents != 3726 || q.Breakdown["inpaint_multiplier"].(float64) != 1.15 {
		t.Errorf("preview migan: want 3726¢ ×1.15, got %d ×%v", q.AmountCents, q.Breakdown["inpaint_multiplier"])
	}
	// production 1080p 2 min = 900¢; migan ×0.5 = 450, between none (360) and propainter (900)
	prod := quoteStep(t, StepInputs{Step: "production", Preset: "1080p", BillableS: 120, Inpaint: "migan"})
	if prod.AmountCents != 450 || prod.Breakdown["inpaint_multiplier"].(float64) != 0.5 {
		t.Errorf("production migan: want 450¢ ×0.5, got %d ×%v", prod.AmountCents, prod.Breakdown["inpaint_multiplier"])
	}
	// ETA residual scales the same way: 120 + 6.0×120×0.5 = 480
	s := stepSvc()
	if eta := s.EstimateStepETA(context.Background(), StepInputs{Step: "production", Preset: "1080p", BillableS: 120, Inpaint: "migan"}); eta != 480 {
		t.Errorf("eta: want 480, got %d", eta)
	}
	// zeroed Firestore fields fall back to the defaults
	z := defaults()
	z.MiganPreviewMultiplier, z.MiganProductionMultiplier = 0, 0
	if z.inpaintMultiplier("stereo_preview", "migan") != 1.15 || z.inpaintMultiplier("production", "migan") != 0.5 {
		t.Errorf("zeroed migan fields must fall back to 1.15 / 0.5")
	}
}
