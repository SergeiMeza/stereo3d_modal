package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/probe"
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

// analyzeJob serves one completed analyze job with the given header facts.
func analyzeJob(t *testing.T, fps float64, frames int, dur float64) *modalapi.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		meta := map[string]any{"probe": map[string]any{"width": 1920, "height": 1080, "fps": fps, "duration": dur, "num_frames": frames}}
		json.NewEncoder(w).Encode(map[string]any{"job_id": "j1", "status": "completed", "metadata": meta})
	}))
	t.Cleanup(srv.Close)
	return modalapi.New(srv.URL, "", "")
}

func foldWith(t *testing.T, s *Service, counted int, fps float64, frames int, dur float64) *store.Project {
	t.Helper()
	ctx := context.Background()
	s.Modal = analyzeJob(t, fps, frames, dur)
	prev := countSource
	countSource = func(context.Context, *Service, *store.Project) (*probe.Counted, error) {
		if counted == 0 {
			return nil, nil
		}
		return &probe.Counted{Frames: counted, DurationS: dur, Method: "packets"}, nil
	}
	t.Cleanup(func() { countSource = prev })
	p := &store.Project{ID: store.NewID(), UID: "u" + store.NewID(), Method: store.MethodLifelike,
		Source: store.Source{GCSKey: "k", Bytes: 1 << 20}, Analyze: store.Analyze{State: store.AnalyzeRunning, JobID: "j1"}}
	if err := s.Store.CreateProject(ctx, p); err != nil {
		t.Fatal(err)
	}
	got, err := s.refreshAnalyze(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// VFR: priced at the counted rate when it's higher than the stated one;
// a header that understates its frames is caught by the count; above
// 120 counted fps the source is refused.
func TestCountedFramesGuard(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))

	// avg 30 stated, bursts: 135 frames in 3 s counted = 45 fps
	vfr := foldWith(t, s, 135, 30, 90, 3)
	if vfr.Analyze.State != store.AnalyzeSucceeded || vfr.Probe.CountedFrames != 135 || !vfr.Probe.VFR || vfr.Probe.PricingFPS() != 45 {
		t.Fatalf("vfr %+v %+v", vfr.Analyze, vfr.Probe)
	}
	plain := foldWith(t, s, 90, 30, 90, 3)
	if plain.Probe.VFR || plain.Probe.PricingFPS() != 30 {
		t.Fatalf("cfr %+v", plain.Probe)
	}
	// the VFR source prices above the same clip at its stated rate
	end := time.Now().Add(20 * 24 * time.Hour)
	for _, p := range []*store.Project{vfr, plain} {
		s.Store.PutCustomer(ctx, p.UID, &store.Customer{StripeCustomerID: "cus_1",
			Plan: &store.Plan{Tier: "studio", SubscriptionID: "sub_" + p.UID, Status: "active", CurrentPeriodEnd: &end}})
	}
	q := func(p *store.Project) int64 {
		params, err := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "1080p"}, p)
		if err != nil {
			t.Fatal(err)
		}
		qq, _, qerr := s.quoteStep(ctx, p, params, store.StepProduction, 0)
		if qerr != nil {
			t.Fatal(qerr)
		}
		return qq.AmountCents
	}
	if a, b := q(vfr), q(plain); a <= b {
		t.Fatalf("vfr %d not above cfr %d", a, b)
	}

	// lying header: 30 fps / 60 frames stated, 300 frames in 2 s counted
	lying := foldWith(t, s, 300, 30, 60, 2)
	if lying.Analyze.State != store.AnalyzeFailed || !strings.Contains(lying.Analyze.Error, "150 fps") {
		t.Fatalf("lying header %+v", lying.Analyze)
	}
	// a project folded before the count, priced from a probe above 120
	old := lifelikeProject()
	old.Probe.CountedFrames, old.Probe.DurationS = 13000, 100
	if err := methodSourceError(s.Pricing.Rates(ctx), old, store.MethodLifelike); err == nil || err.Code != "source_fps_too_high" {
		t.Fatalf("too high: %v", err)
	}
	// a count that fails leaves the header standing
	if p := foldWith(t, s, 0, 30, 90, 3); p.Analyze.State != store.AnalyzeSucceeded || p.Probe.CountedFrames != 0 {
		t.Fatalf("no count %+v", p.Probe)
	}
}

// A job that renders more than 1% over its quoted frames still settles at
// the quote; a frames_over_quote case records it.
func TestFramesOverQuote(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	c := &store.Conversion{ID: store.NewID(), UID: "u" + store.NewID(), ProjectID: "p1", Kind: "video",
		Source: store.Source{FPS: 30, Frames: 900}, Params: store.Params{FromFrame: 0, ToFrame: 900},
		Quote: store.Quote{AmountCents: 1200}}
	if quotedFrames(c) != 900 {
		t.Fatalf("quoted %d", quotedFrames(c))
	}
	c.Modal.VideoFrames = 905 // within 1%
	s.checkFramesOverQuote(ctx, c)
	if cs, _ := s.Store.ListCasesByConversion(ctx, c.ID, 5); len(cs) != 0 {
		t.Fatalf("within 1%%: %v", cs)
	}
	c.Modal.VideoFrames = 1350 // a 45 fps VFR source priced at 30
	s.checkFramesOverQuote(ctx, c)
	s.checkFramesOverQuote(ctx, c) // once per run
	cs, _ := s.Store.ListCasesByConversion(ctx, c.ID, 5)
	if len(cs) != 1 || cs[0].Reason != "frames_over_quote" || cs[0].Type != store.CaseSupport || cs[0].CustomerVisible {
		t.Fatalf("cases %+v", cs)
	}
	// a target rate prices its own frames
	c.Params.TargetFPS = 15
	if quotedFrames(c) != 450 {
		t.Fatalf("target %d", quotedFrames(c))
	}
}

// A count a hair above the stated rate (stream vs container duration) is
// not VFR: a 30 fps clip stays 30, uncapped.
func TestCountedJitterIsNotVFR(t *testing.T) {
	p := &store.Probe{FPS: 30, DurationS: 99.9, NumFrames: 3000, CountedFrames: 3000}
	if p.PricingFPS() != 30 || cappedFPS(p.PricingFPS(), fpsFreeMax) != 30 {
		t.Fatalf("jitter %v", p.PricingFPS())
	}
}
