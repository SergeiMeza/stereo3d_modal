package api

import (
	"context"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestCappedFPS(t *testing.T) {
	for src, want := range map[float64]float64{60: 30, 59.94: 29.97, 50: 25, 48: 24, 120: 30, 100: 25, 90: 30, 40: 20,
		30: 30, 29.97: 29.97, 24: 24, 23.976: 23.976} {
		if got := cappedFPS(src, fpsFreeMax); got != want {
			t.Errorf("%v: %v, want %v", src, got, want)
		}
	}
	if got := fpsChoices(60, fpsFreeMax); !slices.Equal(got, []float64{30, 20, 15, 12, 10}) {
		t.Errorf("choices 60/30: %v", got)
	}
	if got := fpsChoices(60, fpsPlanMax); got[0] != 60 || got[1] != 30 {
		t.Errorf("choices 60/120: %v", got)
	}
}

func fpsProject(uid string, method string, fps float64) *store.Project {
	p := lifelikeProject()
	p.UID, p.Method = uid, method
	p.Probe.FPS = fps
	p.Probe.NumFrames = int(fps * p.Probe.DurationS)
	return p
}

// Without a plan: sources above 30 fps run divided down (fps_capped), an
// explicit target above 30 is 422 plan_required_fps; a Business or Studio
// plan keeps 60.
func TestFPSNeedsPlanAbove30(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})

	for _, method := range []string{store.MethodLifelike, store.MethodClassic} {
		for src, want := range map[float64]float64{60: 30, 59.94: 29.97, 50: 25, 48: 24, 120: 30, 100: 25, 90: 30, 40: 20} {
			p := fpsProject(uid, method, src)
			params, err := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "1080p"}, p)
			if err != nil || params.TargetFPS != want || !params.FPSCapped {
				t.Fatalf("%s %v: %v capped=%v err=%v", method, src, params.TargetFPS, params.FPSCapped, err)
			}
			if info := s.fpsInfo(ctx, p, params); info["max_fps"] != fpsFreeMax || info["reason"] != "plan_required_above_30fps" || info["target_fps"] != want {
				t.Fatalf("info %v", info)
			}
		}
		p := fpsProject(uid, method, 60)
		if _, err := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "1080p", TargetFPS: 60}, p); err == nil || err.Code != "plan_required_fps" || err.Status != 422 ||
			err.Message != "Frame rates above 30 fps need a Business or Studio plan." {
			t.Fatalf("%s explicit 60: %v", method, err)
		}
		params, err := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "1080p", TargetFPS: 20}, p)
		if err != nil || params.TargetFPS != 20 || params.FPSCapped {
			t.Fatalf("%s 20 on 60: %v %v", method, params, err)
		}
		p = fpsProject(uid, method, 24)
		if params, err := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "1080p"}, p); err != nil || params.FPSCapped || params.TargetFPS != 0 {
			t.Fatalf("%s 24: %v %v", method, params, err)
		}
	}

	// A Studio plan: 60 runs at 60, explicit 60 allowed.
	end := time.Now().Add(20 * 24 * time.Hour)
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.Plan = &store.Plan{Tier: "studio", SubscriptionID: "sub_1", Status: "active", CurrentPeriodEnd: &end}
		return nil
	})
	p := fpsProject(uid, store.MethodLifelike, 60)
	for _, target := range []float64{0, 60} {
		params, err := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "1080p", TargetFPS: target}, p)
		if err != nil || params.FPSCapped || params.TargetFPS != target {
			t.Fatalf("plan %v: %v %v", target, params, err)
		}
	}
	if info := s.fpsInfo(ctx, p, store.Params{}); info["max_fps"] != fpsPlanMax || info["target_fps"] != 60.0 || info["reason"] != nil {
		t.Fatalf("plan info %v", info)
	}
}

// The web names the rate above 30 fps; API callers keep the default.
func TestFPSChoiceRequiredOnWeb(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Cfg = &config.Config{Env: "test", CORSOrigins: []string{"https://studio.example"}}
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	p := fpsProject(uid, store.MethodLifelike, 60)
	web := httptest.NewRequest("POST", "/", nil)
	web.Header.Set("Origin", "https://studio.example")
	api := httptest.NewRequest("POST", "/", nil)

	err := s.requireFPSChoice(ctx, web, p, 0)
	if err == nil || err.Code != "fps_choice_required" || err.Status != 422 {
		t.Fatalf("web without a rate: %v", err)
	}
	if ch, _ := err.Details["target_fps_choices"].([]float64); len(ch) == 0 || ch[0] != 30 {
		t.Fatalf("choices %v", err.Details)
	}
	if err := s.requireFPSChoice(ctx, web, p, 30); err != nil {
		t.Fatalf("web with a rate: %v", err)
	}
	if err := s.requireFPSChoice(ctx, api, p, 0); err != nil {
		t.Fatalf("API default: %v", err)
	}
	if err := s.requireFPSChoice(ctx, web, fpsProject(uid, store.MethodLifelike, 30), 0); err != nil {
		t.Fatalf("30 fps source: %v", err)
	}
}
