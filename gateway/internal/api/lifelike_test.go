package api

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// lifelikeProject is proProject as a Lifelike project on a 4K source.
func lifelikeProject() *store.Project {
	p := proProject()
	p.Method = store.MethodLifelike
	p.Probe.Width, p.Probe.Height = 3840, 2160
	return p
}

type httpxErr = httpx.APIError

func itoa(n int) string { return strconv.Itoa(n) }

func llResolveErr(t *testing.T, req *stepConvReq, p *store.Project, wantCode, wantSub string) {
	t.Helper()
	_, err := resolveStepParams(req, p)
	if err == nil {
		t.Fatalf("%+v: want %s, got nil", req, wantCode)
	}
	if err.Code != wantCode || (wantSub != "" && !strings.Contains(err.Message, wantSub)) {
		t.Fatalf("%+v: want %s %q, got %s %q", req, wantCode, wantSub, err.Code, err.Message)
	}
}

// ------------------------------------------------------------- steps

func TestLifelikeStepTemplates(t *testing.T) {
	p := lifelikeProject()
	prev := resolveOKP(t, &stepConvReq{Step: store.StepLifelikePreview, FromFrame: 240, ToFrame: 360}, p)
	if prev.Preset != "1080p" || len(prev.Formats) != 1 || prev.Formats[0] != "sbs" {
		t.Errorf("preview defaults: %+v", prev)
	}
	if prev.TargetFPS != 0 {
		t.Errorf("a lifelike preview renders at the source rate, got %v", prev.TargetFPS)
	}
	if len(prev.SceneCuts) != 3 {
		t.Errorf("scene cuts forwarded: %v", prev.SceneCuts)
	}
	prod := resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: "4k",
		Formats: []string{"mvhevc", "sbs"}, SplitMaxSeconds: 900}, p)
	if prod.Preset != "4k" || prod.SplitMaxSeconds != 900 || prod.Inpaint != "" {
		t.Errorf("production: %+v", prod)
	}
}

func TestLifelikeRejectsClassicSteps(t *testing.T) {
	p := lifelikeProject()
	for _, step := range []string{store.StepDepthPreview, store.StepStereoPreview, "bogus"} {
		llResolveErr(t, &stepConvReq{Step: step}, p, "step_not_supported_for_method", "")
	}
	// and a classic project refuses the lifelike step
	llResolveErr(t, &stepConvReq{Step: store.StepLifelikePreview, ToFrame: 100}, proProject(), "step_not_supported_for_method", "")
}

func TestLifelikeRejectsClassicKnobs(t *testing.T) {
	p := lifelikeProject()
	cases := map[string]stepConvReq{
		"depth_res":          {DepthRes: 980},
		"depth_scale":        {DepthScale: 1.2},
		"inpaint":            {Inpaint: "none"},
		"warp":               {Warp: "backward"},
		"scene_overrides":    {SceneOverrides: []sceneOverrideReq{{First: 0, Displacement: 0.02}}},
		"use_uploaded_depth": {UseUploadedDepth: true},
		"displacement":       {Displacement: 0.02},
	}
	for knob, req := range cases {
		req.Step = store.StepProduction
		llResolveErr(t, &req, p, "invalid_request", knob)
	}
}

func TestLifelikePresetsAndFormats(t *testing.T) {
	p := lifelikeProject()
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "draft"}, p, "invalid_request", "1080p|qhd|3k|4k")
	for _, f := range []string{"tb", "half_tb", "anaglyph", "lr"} {
		llResolveErr(t, &stepConvReq{Step: store.StepProduction, Formats: []string{"mvhevc", f}}, p, "invalid_request", f)
	}
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Formats: []string{}}, p, "invalid_request", "empty")

	// never above the source's short side: a 1080p source offers 1080p only
	hd := lifelikeProject()
	hd.Probe.Width, hd.Probe.Height = 1920, 1080
	for _, preset := range []string{"qhd", "3k", "4k"} {
		llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: preset}, hd, "preset_above_source", "")
	}
	resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: "1080p"}, hd)
	// below 1080 still gets 1080p (rendered at source size)
	sd := lifelikeProject()
	sd.Probe.Width, sd.Probe.Height = 1280, 720
	resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: "1080p"}, sd)
	// portrait: the short side is the width
	portrait := lifelikeProject()
	portrait.Probe.Width, portrait.Probe.Height = 1440, 2560
	resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: "qhd"}, portrait)
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "3k"}, portrait, "preset_above_source", "")
}

func TestLifelikePreviewSpan(t *testing.T) {
	p := lifelikeProject() // 24 fps
	llResolveErr(t, &stepConvReq{Step: store.StepLifelikePreview}, p, "invalid_request", "from_frame and to_frame")
	llResolveErr(t, &stepConvReq{Step: store.StepLifelikePreview, FromFrame: 0, ToFrame: 120, SplitMaxSeconds: 900}, p, "invalid_request", "production only")
	rule := pricing.Defaults().LifelikePreviewSeconds() // 2-10 s
	span := func(from, to int) *httpxErr {
		params := resolveOKP(t, &stepConvReq{Step: store.StepLifelikePreview, FromFrame: from, ToFrame: to}, p)
		return checkPreviewSpan(p, params, rule)
	}
	for _, ok := range [][2]int{{0, 48}, {0, 120}, {0, 240}, {100, 341}} { // 2 s, 5 s, 10 s, 10 s + a frame
		if err := span(ok[0], ok[1]); err != nil {
			t.Errorf("%v: %v", ok, err)
		}
	}
	for _, bad := range [][2]int{{0, 24}, {0, 264}} { // 1 s, 11 s
		if err := span(bad[0], bad[1]); err == nil {
			t.Errorf("%v must be refused", bad)
		}
	}
	// config can move the rule
	if err := checkPreviewSpan(p, store.Params{ToFrame: 264}, pricing.PreviewSeconds{MinS: 2, MaxS: 15}); err != nil {
		t.Errorf("15 s rule: %v", err)
	}
	// quick look: half the source rate is a valid target
	if q := resolveOKP(t, &stepConvReq{Step: store.StepLifelikePreview, ToFrame: 120, TargetFPS: 12}, p); q.TargetFPS != 12 {
		t.Errorf("quick look target_fps: %v", q.TargetFPS)
	}
}

// lifelike_enabled_presets: only enabled sizes are offered, and a full
// option needs an enabled step above the source.
func TestLifelikeQualitiesEnabledOnly(t *testing.T) {
	ids := func(qs []quality) string {
		var out []string
		for _, q := range qs {
			out = append(out, q.ID+":"+q.Preset+"/"+q.PricePreset)
		}
		return strings.Join(out, " ")
	}
	p := lifelikeProject()
	p.Probe.Width, p.Probe.Height = 8192, 4320
	if got := ids(lifelikeQualities(p, pricing.DefaultLifelikeEnabled)); got != "1080p:1080p/1080p qhd:qhd/qhd 3k:3k/3k 4k:4k/4k" {
		t.Errorf("8K source, default presets: %s", got)
	}
	p.Probe.Width, p.Probe.Height = 5120, 2560 // between 4k and 5k
	if got := ids(lifelikeQualities(p, pricing.DefaultLifelikeEnabled)); got != "1080p:1080p/1080p qhd:qhd/qhd 3k:3k/3k 4k:4k/4k" {
		t.Errorf("no full option without an enabled step above: %s", got)
	}
	if got := ids(lifelikeQualities(p, []string{"1080p", "qhd", "3k", "4k", "5k"})); got != "1080p:1080p/1080p qhd:qhd/qhd 3k:3k/3k 4k:4k/4k full:5k/4k" {
		t.Errorf("5k enabled: %s", got)
	}
	// config parsing: order and unknown names
	r := pricing.Rates{LifelikeEnabledPresets: []string{"8k", "1080p", "bogus", "4k"}}
	if got := strings.Join(r.EnabledLifelikePresets(), ","); got != "1080p,4k,8k" {
		t.Errorf("enabled from config: %s", got)
	}
	if got := strings.Join((&pricing.Rates{}).EnabledLifelikePresets(), ","); got != "1080p,qhd,3k,4k" {
		t.Errorf("absent: %s", got)
	}
	// the service path reads the config
	cfg := pricing.Defaults()
	cfg.LifelikeEnabledPresets = []string{"1080p", "qhd", "3k", "4k", "5k", "6k", "8k"}
	s := &Service{Pricing: pricing.NewStatic(cfg)}
	big := lifelikeProject()
	big.Probe.Width, big.Probe.Height = 8192, 4320
	if params, err := s.resolveParams(context.Background(), &stepConvReq{Step: store.StepProduction, Preset: "8k"}, big); err != nil || params.Preset != "8k" {
		t.Errorf("8k enabled in config: %+v %v", params, err)
	}
	def := &Service{Pricing: pricing.NewStatic(nil)}
	if _, err := def.resolveParams(context.Background(), &stepConvReq{Step: store.StepProduction, Preset: "8k"}, big); err == nil || err.Code != "preset_unavailable" {
		t.Errorf("8k not enabled: %v", err)
	}
}

// S3D-04: what a source can be rendered at.
func TestLifelikeQualities(t *testing.T) {
	ids := func(qs []quality) string {
		var out []string
		for _, q := range qs {
			out = append(out, q.ID+":"+q.Preset+"/"+q.PricePreset+"@"+itoa(q.LabelShortSide))
		}
		return strings.Join(out, " ")
	}
	cases := []struct {
		w, h int
		want string
	}{
		{3840, 2160, "1080p:1080p/1080p@1080 qhd:qhd/qhd@1440 3k:3k/3k@1620 4k:4k/4k@2160"},
		{1920, 1080, "1080p:1080p/1080p@1080"},
		// 2.39:1 scope 4K: between 3k and 4k → full renders 4k, costs 3k
		{3840, 1607, "1080p:1080p/1080p@1080 qhd:qhd/qhd@1440 full:3k/qhd@1606"},
		{3840, 1700, "1080p:1080p/1080p@1080 qhd:qhd/qhd@1440 3k:3k/3k@1620 full:4k/3k@1700"},
		// a 720p clip: full renders 1080p (clamped to 720), costs 1080p
		{1280, 720, "full:1080p/1080p@720"},
		// portrait: the short side is the width
		{1440, 2560, "1080p:1080p/1080p@1080 qhd:qhd/qhd@1440"},
		// 8K: every step up to 8k (S3D-48)
		{8192, 4320, "1080p:1080p/1080p@1080 qhd:qhd/qhd@1440 3k:3k/3k@1620 4k:4k/4k@2160 5k:5k/5k@2880 6k:6k/6k@3240 8k:8k/8k@4320"},
		// between 4k and 5k: full renders 5k, costs 4k
		{5120, 2560, "1080p:1080p/1080p@1080 qhd:qhd/qhd@1440 3k:3k/3k@1620 4k:4k/4k@2160 full:5k/4k@2560"},
		// above 8K: scaled down to 8k, nothing more
		{15360, 8640, "1080p:1080p/1080p@1080 qhd:qhd/qhd@1440 3k:3k/3k@1620 4k:4k/4k@2160 5k:5k/5k@2880 6k:6k/6k@3240 8k:8k/8k@4320"},
	}
	for _, tc := range cases {
		p := lifelikeProject()
		p.Probe.Width, p.Probe.Height = tc.w, tc.h
		if got := ids(lifelikeQualities(p, pricing.LifelikePresets)); got != tc.want {
			t.Errorf("%dx%d:\n got %s\nwant %s", tc.w, tc.h, got, tc.want)
		}
	}
}

func TestLifelikeFullResolutionRequests(t *testing.T) {
	scope := lifelikeProject()
	scope.Probe.Width, scope.Probe.Height = 3840, 1606
	for _, preset := range []string{"full", "3k"} { // "3k" is what full renders here
		params := resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: preset}, scope)
		if params.Preset != "3k" || params.PricePreset != "qhd" || params.Quality != "full" {
			t.Errorf("%s: %+v", preset, params)
		}
		if outputShortSide(scope, params) != 1606 || pricePreset(params) != "qhd" {
			t.Errorf("%s: output %d, priced %s", preset, outputShortSide(scope, params), pricePreset(params))
		}
	}
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "4k"}, scope, "preset_above_source", "1606p")
	// a 720p clip: no preset means full (rendered at 720, priced at 1080p)
	sd := lifelikeProject()
	sd.Probe.Width, sd.Probe.Height = 1280, 720
	if params := resolveOKP(t, &stepConvReq{Step: store.StepProduction}, sd); params.Quality != "full" || params.Preset != "1080p" || params.PricePreset != "" {
		t.Errorf("720p default: %+v", params)
	}
	// a 4K source: a plain step carries no price override
	if params := resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: "4k"}, lifelikeProject()); params.Quality != "4k" || params.PricePreset != "" {
		t.Errorf("4k: %+v", params)
	}
	// 5k-8k aren't enabled by default: refused as unavailable (before any
	// charge); enabled, 8k on a 4K source is above the source
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "8k"}, lifelikeProject(), "preset_unavailable", "4K or lower")
	if _, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "8k"}, lifelikeProject(), pricing.LifelikePresets); err == nil || err.Code != "preset_above_source" {
		t.Errorf("8k enabled, 4K source: %v", err)
	}
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, Preset: "12k"}, lifelikeProject(), "invalid_request", "full")
}

func TestSplitMaxSecondsRails(t *testing.T) {
	p := lifelikeProject()
	for _, n := range []int{59, 3601, -5} {
		llResolveErr(t, &stepConvReq{Step: store.StepProduction, SplitMaxSeconds: n}, p, "invalid_request", "split_max_seconds")
	}
	for _, n := range []int{60, 900, 3600} {
		resolveOKP(t, &stepConvReq{Step: store.StepProduction, SplitMaxSeconds: n}, p)
	}
	// classic has no split contract yet: refused, never silently dropped
	llResolveErr(t, &stepConvReq{Step: store.StepProduction, SplitMaxSeconds: 900}, proProject(), "split_unsupported", "")
}

// ------------------------------------------------------------- method caps

func TestMethodSourceError(t *testing.T) {
	rates := pricing.Defaults() // classic 600 s, lifelike unlimited
	p := lifelikeProject()
	p.Probe.DurationS = 3600
	if methodSourceError(rates, p, store.MethodLifelike) != nil {
		t.Error("lifelike is unlimited by default")
	}
	err := methodSourceError(rates, p, store.MethodClassic)
	if err == nil || err.Code != "source_too_long_for_method" || err.Status != 400 {
		t.Fatalf("classic over its cap: %v", err)
	}
	p.Probe.DurationS = 300
	if methodSourceError(rates, p, store.MethodClassic) != nil {
		t.Error("a 5-minute source fits classic")
	}
	p.Probe = nil
	if methodSourceError(rates, p, store.MethodClassic) != nil {
		t.Error("no probe yet: the analyze fold applies the cap")
	}
	rates.LifelikeMaxSourceDurationS = 1800
	p.Probe = &store.Probe{DurationS: 2000}
	if e := methodSourceError(rates, p, store.MethodLifelike); e == nil || e.Code != "source_too_long_for_method" {
		t.Error("a configured lifelike cap applies")
	}
}

func TestResolveMethod(t *testing.T) {
	on := &Service{Lifelike: modalapi.New("https://x", "", "")}
	off := &Service{}
	// Old clients send no method and only know the classic steps.
	for _, s := range []*Service{on, off} {
		if m, err := s.resolveMethod(""); err != nil || m != store.MethodClassic {
			t.Errorf("no method must mean classic, got %s %v", m, err)
		}
	}
	if m, err := on.resolveMethod(store.MethodLifelike); err != nil || m != store.MethodLifelike {
		t.Errorf("explicit lifelike: %s %v", m, err)
	}
	if _, err := off.resolveMethod(store.MethodLifelike); err == nil || err.Code != "method_unavailable" {
		t.Errorf("explicit lifelike without the service: %v", err)
	}
	if _, err := on.resolveMethod("magic"); err == nil {
		t.Error("unknown method must 400")
	}
	// The UI default (GET /v1/limits default_method) is lifelike where the
	// service runs.
	if on.defaultMethod() != store.MethodLifelike || off.defaultMethod() != store.MethodClassic {
		t.Errorf("default_method: on %s, off %s", on.defaultMethod(), off.defaultMethod())
	}
}

// ------------------------------------------------------------- submit body

func TestLifelikeBodyExactShape(t *testing.T) {
	conv := &store.Conversion{Kind: "video", Step: store.StepProduction, Method: store.MethodLifelike,
		Source: store.Source{GCSKey: "stereo3d/test/users/u1/abc/source.mp4"},
		Params: store.Params{Preset: "4k", Formats: []string{"mvhevc", "sbs"}, FromFrame: 24, ToFrame: 2400,
			TargetFPS: 23.976, SplitMaxSeconds: 900, SceneCuts: []int{240, 900}}}
	raw, _ := json.Marshal(lifelikeBody(conv, 12))
	want := `{"formats":["mvhevc","sbs"],"from_frame":24,"input_path":"stereo3d/test/users/u1/abc/source.mp4",` +
		`"max_gpu_workers":8,"preset":"4k","scene_cuts":[240,900],"split_max_seconds":900,"target_fps":23.976,"to_frame":2400}`
	if string(raw) != want {
		t.Errorf("lifelike body\n got: %s\nwant: %s", raw, want)
	}
	// preview: one container, cuts always present
	prev := &store.Conversion{Kind: "video", Step: store.StepLifelikePreview, Method: store.MethodLifelike,
		Params: store.Params{Preset: "1080p", Formats: []string{"sbs"}, ToFrame: 120}}
	b := lifelikeBody(prev, 4)
	if b["max_gpu_workers"] != 1 {
		t.Errorf("preview workers: %v", b["max_gpu_workers"])
	}
	if raw, _ := json.Marshal(b["scene_cuts"]); string(raw) != "[]" {
		t.Errorf("scene_cuts must be [] not null, got %s", raw)
	}
	for _, k := range []string{"adaptive", "notify", "inpaint", "depth_res", "from_frame"} {
		if _, ok := b[k]; ok {
			t.Errorf("%s must not be sent to lifelike", k)
		}
	}
}

func TestModalForRoutesByMethod(t *testing.T) {
	classic, ll := modalapi.New("https://c", "", ""), modalapi.New("https://l", "", "")
	s := &Service{Modal: classic, Lifelike: ll}
	if s.modalFor(&store.Conversion{}) != classic || s.modalFor(&store.Conversion{Method: "classic"}) != classic {
		t.Error("classic runs go to the stereo3d API")
	}
	if s.modalFor(&store.Conversion{Method: store.MethodLifelike}) != ll {
		t.Error("lifelike runs go to the lifelike3d API")
	}
	if (&Service{Modal: classic}).modalFor(&store.Conversion{Method: store.MethodLifelike}) != nil {
		t.Error("lifelike without the service: nil, never the classic API")
	}
}

// ------------------------------------------------------------- job record

func TestSplitPartsFromJobRecord(t *testing.T) {
	job := &modalapi.Job{Metadata: json.RawMessage(`{"probe":{"fps":24},"parts":[
		{"index":1,"from_frame":0,"to_frame":21600,"start_s":0,"duration_s":900},
		{"index":2,"from_frame":21600,"to_frame":30000,"start_s":900,"duration_s":350}]}`)}
	parts := splitParts(job)
	if len(parts) != 2 || parts[1].Index != 2 || parts[1].StartS != 900 || parts[1].DurationS != 350 {
		t.Errorf("parts: %+v", parts)
	}
	one := &modalapi.Job{Metadata: json.RawMessage(`{"parts":[{"index":1,"from_frame":0,"to_frame":100}]}`)}
	if splitParts(one) != nil {
		t.Error("a single part is not a split output")
	}
	if splitParts(&modalapi.Job{}) != nil {
		t.Error("no metadata: nil")
	}
	var rec modalapi.Job
	if err := json.Unmarshal([]byte(`{"status":"in_progress","waiting_for_gpu":true,"queued_s":42.5}`), &rec); err != nil {
		t.Fatal(err)
	}
	if !rec.WaitingForGPU || rec.QueuedS != 42.5 {
		t.Errorf("waiting_for_gpu / queued_s decode: %+v", rec)
	}
}

func TestConversionResponseLifelikeFields(t *testing.T) {
	c := &store.Conversion{ID: "c1", State: store.StateProcessing, ProjectID: "p1",
		Step: store.StepProduction, Method: store.MethodLifelike,
		Stripe: store.Stripe{Mode: store.BillingModeAutoPrecharge, PIStatus: store.PISucceeded, CapturedCents: 4000},
		Modal:  store.Modal{Stage: "render", WaitingForGPU: true, QueuedS: 31},
		Parts:  []store.Part{{Index: 1}, {Index: 2}}}
	r := (&Service{}).conversionResponse(c, nil)
	if r["method"] != "lifelike" || r["charge_timing"] != "before" || r["waiting_for_gpu"] != true || r["queued_s"] != 31.0 {
		t.Errorf("response: %v", r)
	}
	if b := r["billing"].(map[string]any); b["status"] != "charged" {
		t.Errorf("billing: %v", b)
	}
	if _, ok := r["parts"]; !ok {
		t.Error("parts missing")
	}
	old := (&Service{}).conversionResponse(&store.Conversion{State: store.StateSucceeded, ProjectID: "p",
		Stripe: store.Stripe{Mode: store.BillingModeAuto, PIStatus: store.PIBatched}}, nil)
	if old["method"] != "classic" || old["charge_timing"] != "after" || old["waiting_for_gpu"] != false {
		t.Errorf("pre-lifelike record: %v", old)
	}
}

// ------------------------------------------------------------- downloads

func TestDownloadNames(t *testing.T) {
	cases := []struct {
		name, ext, want string
		part            int
	}{
		{"mvhevc_part02", ".mov", "Trip 3D Part 2.mov", 2},
		{"sbs_part01", ".mp4", "Trip 3D SBS Part 1.mp4", 1},
		{"half_sbs_part10", ".mp4", "Trip 3D Half SBS Part 10.mp4", 10},
		{"mvhevc", ".mov", "Trip 3D.mov", 0},
		{"depth_vis", ".mp4", "Trip depth_vis.mp4", 0},
		{"weird_partX", ".mp4", "Trip weird_partX.mp4", 0},
	}
	for _, tc := range cases {
		if got := downloadFilename("Trip", tc.name, tc.ext); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
		if _, part := splitOutputName(tc.name); part != tc.part {
			t.Errorf("%s: part %d want %d", tc.name, part, tc.part)
		}
	}
	if got := downloadFilename("", "mvhevc", ".mov"); got != "Video 3D.mov" {
		t.Errorf("unnamed project: %q", got)
	}
	files := []outputFile{{Format: "sbs", Part: 2}, {Format: "mvhevc", Part: 2}, {Format: "sbs", Part: 1}, {Format: "mvhevc", Part: 1}}
	sortOutputFiles(files)
	if files[0].Format != "mvhevc" || files[0].Part != 1 || files[3].Format != "sbs" || files[3].Part != 2 {
		t.Errorf("sort: %+v", files)
	}
}

// ------------------------------------------------------------- precharge

func TestChargeTiming(t *testing.T) {
	r := pricing.Defaults()
	if chargeTiming(r, 2500) != "after" || chargeTiming(r, 2501) != "before" {
		t.Error("above $25 is charged before; $25 itself is billed after")
	}
	r.PrechargeThresholdCents = 0 // absent from the config doc
	if chargeTiming(r, 2600) != "before" {
		t.Error("absent threshold falls back to $25")
	}
}

func TestPrechargeSettlement(t *testing.T) {
	pc := func(state, pi string, captured int64) *store.Conversion {
		return &store.Conversion{State: state, Stripe: store.Stripe{
			Mode: store.BillingModeAutoPrecharge, PaymentIntentID: "pi_1", PIStatus: pi, CapturedCents: captured}}
	}
	// success: nothing more to collect
	if got := settlementAfterSuccess(pc(store.StateProcessing, store.PISucceeded, 4000)); got != store.PISucceeded {
		t.Errorf("precharged success settles as %q", got)
	}
	// failure copy tells the truth about the money
	if p := notChargedPhrase(pc(store.StateFailed, store.PICancelPending, 4000)); p != "your payment is being refunded in full" {
		t.Errorf("charged run: %q", p)
	}
	if p := notChargedPhrase(pc(store.StateExpired, store.PICancelPending, 0)); p != "you were not charged" {
		t.Errorf("3DS never confirmed: %q", p)
	}
	cases := map[string]*store.Conversion{
		"charged":        pc(store.StateSucceeded, store.PISucceeded, 4000),
		"refund_pending": pc(store.StateFailed, store.PICancelPending, 4000),
		"refunded":       {State: store.StateCanceled, Stripe: store.Stripe{Mode: store.BillingModeAutoPrecharge, PIStatus: store.PIRefunded, CapturedCents: 4000, RefundedCents: 4000}},
		"not_charged":    pc(store.StateExpired, store.PICanceled, 0),
	}
	for want, c := range cases {
		if b := prechargeBilling(c); b == nil || b["status"] != want {
			t.Errorf("%s: got %v", want, b)
		}
	}
	waiting := pc(store.StateCreated, "", 0)
	waiting.Stripe.ClientSecret = "secret"
	if prechargeBilling(waiting) != nil {
		t.Error("3DS pending: the requires_action block answers")
	}
}

// ------------------------------------------------------------- overdue

func TestOverdueAllowsGPUQueueing(t *testing.T) {
	now := time.Now()
	submitted := now.Add(-40 * time.Minute)
	c := &store.Conversion{State: store.StateProcessing, CreatedAt: submitted}
	c.Modal.SubmittedAt = &submitted
	c.Support.ExpectedSeconds = 600 // overdue after 10 + 15 min
	if !isOverdue(c, now) {
		t.Fatal("40 min on a 10 min estimate is overdue")
	}
	c.Modal.QueuedS = 20 * 60 // 20 of those minutes waiting for a GPU
	if isOverdue(c, now) {
		t.Error("time spent waiting for a GPU must not count against the run")
	}
}

func TestProcessingDeadlineScalesWithEstimate(t *testing.T) {
	short := &store.Conversion{Support: store.Support{ExpectedSeconds: 600}}
	if processingDeadline(short) != processingTTL {
		t.Errorf("short runs keep the 24 h ceiling, got %s", processingDeadline(short))
	}
	long := &store.Conversion{Support: store.Support{ExpectedSeconds: 10 * 3600}}
	if processingDeadline(long) != 30*time.Hour {
		t.Errorf("a 10 h estimate gets 3× its estimate, got %s", processingDeadline(long))
	}
}
