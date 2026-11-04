package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/probe"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// iphoneHDRStreams: HEVC Main 10, BT.2020, HLG, Dolby Vision 8.4.
const iphoneHDRStreams = `{"streams":[{"codec_name":"hevc","profile":"Main 10","pix_fmt":"yuv420p10le","color_space":"bt2020nc",
"color_transfer":"arib-std-b67","color_primaries":"bt2020","side_data_list":[{"side_data_type":"DOVI configuration record",
"dv_profile":8,"dv_level":5,"dv_bl_signal_compatibility_id":4}]}]}`

// foldDynamic folds an analyze with the source read as streams.
func foldDynamic(t *testing.T, s *Service, streams string) *store.Project {
	t.Helper()
	prev := dynamicSource
	dynamicSource = func(context.Context, *Service, *store.Project) (*probe.DynamicRange, error) {
		if streams == "" {
			return nil, nil
		}
		return probe.ParseDynamic([]byte(streams))
	}
	t.Cleanup(func() { dynamicSource = prev })
	return foldWith(t, s, 90, 30, 90, 3)
}

// Analysis stores the dynamic range; dv_5 is refused before any charge,
// in words without HDR; the project shows the range only while HDR
// output is on.
func TestSourceDynamicRange(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	off := pricing.DefaultsFor("test")
	on := pricing.DefaultsFor("test")
	on.LifelikeHDROutputEnabled = true
	s.Pricing = pricing.NewStatic(off)

	iphone := foldDynamic(t, s, iphoneHDRStreams)
	if iphone.Analyze.State != store.AnalyzeSucceeded || iphone.Probe.DynamicRange != probe.RangeDV8 || iphone.Probe.DynamicRangeBase != probe.RangeHLG || !hdrSource(iphone) {
		t.Fatalf("iphone %+v %+v", iphone.Analyze, iphone.Probe)
	}
	view := func(p *store.Project) map[string]any {
		raw, _ := json.Marshal(s.projectResponse(p, nil))
		var out map[string]any
		json.Unmarshal(raw, &out)
		return out
	}
	if out := view(iphone); out["dynamic_range"] != nil || out["hdr_source"] != nil || out["hdr_available"] != false || out["hdr_output"] != false ||
		out["probe"].(map[string]any)["dynamic_range"] != nil {
		t.Fatalf("hidden while off %v", out)
	}
	s.Pricing = pricing.NewStatic(on)
	if out := view(iphone); out["dynamic_range"] != "dv_8" || out["hdr_source"] != true || out["hdr_available"] != true || out["hdr_output"] != true {
		t.Fatalf("on %v", out)
	}
	sdr := foldDynamic(t, s, `{"streams":[{"profile":"High","color_transfer":"bt709"}]}`)
	if out := view(sdr); out["dynamic_range"] != "sdr" || out["hdr_source"] != false || out["hdr_available"] != false || out["hdr_output"] != false {
		t.Fatalf("sdr %v", out)
	}
	// unread (projects analyzed before, or ffprobe failed): nothing shown
	if out := view(foldDynamic(t, s, "")); out["dynamic_range"] != nil || out["hdr_available"] != false {
		t.Fatalf("unread %v", out)
	}
	// dv_5: refused at analysis whatever the switch, without HDR wording
	s.Pricing = pricing.NewStatic(off)
	dv5 := foldDynamic(t, s, `{"streams":[{"side_data_list":[{"side_data_type":"DOVI configuration record","dv_profile":5,"dv_bl_signal_compatibility_id":0}]}]}`)
	if dv5.Analyze.State != store.AnalyzeFailed || dv5.Analyze.Error != errDolbyVision5Text || dv5.Probe != nil {
		t.Fatalf("dv5 %+v", dv5.Analyze)
	}
	stored := lifelikeProject()
	stored.Probe.DynamicRange = probe.RangeDV5
	if _, err := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction}, stored); err == nil || err.Status != 422 || err.Code != "source_dolby_vision_unsupported" {
		t.Fatalf("dv5 guard %v", err)
	}
}

// HDR output is automatic and free (owner 2026-11-05): while the switch
// is on every Lifelike run of an HDR source (full, preview, split,
// Express) records params.hdr and sends hdr_output; an SDR source, a
// Classic project or the switch off change nothing; a request's "hdr"
// (older web builds) is ignored, never a 422.
func TestHDRAutomatic(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	off := pricing.DefaultsFor("test")
	on := pricing.DefaultsFor("test")
	on.LifelikeHDROutputEnabled = true
	hdr := lifelikeProject()
	hdr.UID = "u" + store.NewID()
	hdr.Probe.DynamicRange, hdr.Probe.DynamicRangeBase = probe.RangeDV8, probe.RangeHLG
	sdr := lifelikeProject()
	sdr.UID = hdr.UID
	sdr.Probe.DynamicRange = probe.RangeSDR
	reqs := []stepConvReq{
		{Step: store.StepProduction, Preset: "4k"},
		{Step: store.StepLifelikePreview, Preset: "4k", FromFrame: 0, ToFrame: 120},
		{Step: store.StepProduction, Preset: "4k", SplitMaxSeconds: 60},
		{Step: store.StepProduction, Preset: "4k", Express: true},
	}
	run := func(p *store.Project, req stepConvReq) (store.Params, map[string]any) {
		t.Helper()
		params, err := s.resolveParams(ctx, &req, p)
		if err != nil {
			t.Fatalf("%+v: %v", req, err)
		}
		return params, lifelikeBody(&store.Conversion{Step: req.Step, Params: params}, 4)
	}
	s.Pricing = pricing.NewStatic(on)
	for _, req := range reqs {
		if params, b := run(hdr, req); !params.HDR || b["hdr_output"] != true {
			t.Fatalf("hdr source %+v: %+v %v", req, params, b)
		}
		if params, b := run(sdr, req); params.HDR || b["hdr_output"] != nil {
			t.Fatalf("sdr source %+v: %+v", req, params)
		}
	}
	// free: the same price as without it
	params, _ := run(hdr, reqs[0])
	q, _, qerr := s.quoteStep(ctx, hdr, params, store.StepProduction, 0)
	if qerr != nil || q.AmountCents != 2000 || q.Breakdown["hdr"] != nil {
		t.Fatalf("quote %v %v", q, qerr)
	}
	// an older web's "hdr" is ignored either way, never a 422
	var old stepConvReq
	if err := json.Unmarshal([]byte(`{"step":"production","preset":"4k","hdr":true}`), &old); err != nil {
		t.Fatal(err)
	}
	if params, _ := run(sdr, old); params.HDR {
		t.Fatal("hdr on an SDR source")
	}
	s.Pricing = pricing.NewStatic(off)
	for _, req := range append(reqs, old) {
		if params, b := run(hdr, req); params.HDR || b["hdr_output"] != nil {
			t.Fatalf("switch off %+v: %+v", req, params)
		}
	}
}

// Lifelike's plan-time Dolby Vision refusal (error_code
// source_dolby_vision_unsupported) fails the run plainly, nothing charged.
func TestDolbyVisionJobRefusal(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"job_id": "j1", "status": "failed", "error_code": "source_dolby_vision_unsupported",
			"error": "This Dolby Vision format isn't supported. Export the video as HDR10 or SDR and try again."})
	}))
	t.Cleanup(srv.Close)
	s.Lifelike = modalapi.New(srv.URL, "", "")
	fake.pis["pi_dv"] = map[string]any{"status": "requires_capture", "amount_received": int64(0)}
	now := time.Now()
	c := &store.Conversion{ID: store.NewID(), UID: "u" + store.NewID(), Kind: "video", Method: store.MethodLifelike,
		Step: store.StepProduction, State: store.StateProcessing, Params: store.Params{Preset: "4k"},
		Quote:  store.Quote{AmountCents: 1200, Currency: "usd"},
		Stripe: store.Stripe{PaymentIntentID: "pi_dv", PIStatus: "requires_capture"}, Modal: store.Modal{JobID: "j1", SubmittedAt: &now}}
	if err := s.Store.CreateConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	got, err := s.refreshFromModal(ctx, c)
	if err != nil || got.State != store.StateFailed || got.Error.Code != "source_dolby_vision_unsupported" ||
		got.Error.UserMessage != "This Dolby Vision format isn't supported. Export the video as HDR10 or SDR and try again. You were not charged." ||
		!strings.Contains(got.Error.InternalMessage, "error_code source_dolby_vision_unsupported") {
		t.Fatalf("run %+v %v", got.Error, err)
	}
	if fake.pis["pi_dv"]["status"] != "canceled" || got.Stripe.CapturedCents != 0 {
		t.Fatalf("hold %v", fake.pis["pi_dv"])
	}
}
