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

	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func barsProject(w, h int, crop string) *store.Project {
	return &store.Project{Method: store.MethodLifelike, Probe: &store.Probe{Width: w, Height: h, FPS: 24, NumFrames: 240, DurationS: 10}, Crop: crop}
}

// BL-03: bars only when the picture inside is smaller than the frame
// turned to the crop's orientation (crop is displayed pixels, probe
// coded), beyond cropdetect's rounding.
func TestHasBars(t *testing.T) {
	for _, tc := range []struct {
		name       string
		w, h       int
		crop       string
		want       bool
		wantW, wid int
	}{
		{"none", 3840, 2160, "", false, 0, 0},
		{"full frame", 3840, 2160, "3840:2160:0:0", false, 0, 0},
		{"2-px rounding", 3840, 2160, "3840:2158:0:0", false, 0, 0},
		{"letterbox", 3840, 2160, "3840:1600:0:280", true, 3840, 1600},
		{"pillarbox", 1920, 1080, "1440:1080:240:0", true, 1440, 1080},
		{"rotated full frame", 1920, 1080, "1080:1920:0:0", false, 0, 0},
		{"rotated letterbox", 1920, 1080, "800:1920:140:0", true, 800, 1920},
		{"malformed", 3840, 2160, "not-a-crop", false, 0, 0},
		{"under 20% of a side (dark video)", 3840, 2160, "3840:400:0:880", false, 0, 0},
		{"off the frame", 3840, 2160, "3840:1600:0:600", false, 0, 0},
		{"odd values made even", 3840, 2160, "3839:1601:1:279", true, 3838, 1600},
		{"under 256 px", 1280, 720, "1280:250:0:235", false, 0, 0},
	} {
		p := barsProject(tc.w, tc.h, tc.crop)
		c, ok := barsCrop(p)
		if ok != tc.want || hasBars(p) != tc.want || (ok && (c.W != tc.wantW || c.H != tc.wid)) {
			t.Errorf("%s: bars %v %+v", tc.name, ok, c)
		}
		if _, _, cropped := depthContentDims(p); cropped != tc.want {
			t.Errorf("%s: depthContentDims cropped %v", tc.name, cropped)
		}
		if removeBars(p) != tc.want {
			t.Errorf("%s: removeBars by default %v", tc.name, removeBars(p))
		}
	}
	p := barsProject(3840, 2160, "3840:1600:0:280")
	keep := false
	p.RemoveBars = &keep
	if removeBars(p) {
		t.Fatal("kept bars")
	}
	p.RemoveBars, p.BarsRemovalOff = nil, true
	if removeBars(p) {
		t.Fatal("switch off")
	}
}

// PATCH remove_bars; the project shows crop, has_bars, remove_bars and
// whether the gateway can take bars off.
func TestRemoveBarsSetting(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	c := projCaller{t, s, &AuthedUser{UID: uid}}
	p := barsProject(3840, 2160, "3840:1600:0:280")
	p.ID, p.UID = store.NewID(), uid
	s.Store.CreateProject(ctx, p)
	read := func(body string) map[string]any {
		var out map[string]any
		json.Unmarshal([]byte(body), &out)
		return out
	}
	code, body := c.do(s.HandleGetProject, p.ID, "")
	out := read(body)
	if code != 200 || out["crop"] != "3840:1600:0:280" || out["has_bars"] != true || out["remove_bars"] != true || out["bars_removal_available"] != true {
		t.Fatalf("get %d %s", code, body)
	}
	code, body = c.do(s.HandleUpdateProject, p.ID, `{"remove_bars":false}`)
	if out = read(body); code != 200 || out["remove_bars"] != false || out["has_bars"] != true {
		t.Fatalf("keep %d %s", code, body)
	}
	got, _ := s.Store.GetProject(ctx, p.ID)
	if got.RemoveBars == nil || *got.RemoveBars || removeBars(got) {
		t.Fatalf("stored %+v", got.RemoveBars)
	}
	c.do(s.HandleUpdateProject, p.ID, `{"remove_bars":true}`)
	if got, _ = s.Store.GetProject(ctx, p.ID); !removeBars(got) {
		t.Fatal("back on")
	}
	plain := barsProject(1920, 1080, "1080:1920:0:0")
	plain.ID, plain.UID = store.NewID(), uid
	s.Store.CreateProject(ctx, plain)
	_, body = c.do(s.HandleGetProject, plain.ID, "")
	if out = read(body); out["has_bars"] != false || out["remove_bars"] != false {
		t.Fatalf("portrait without bars %s", body)
	}
	s.Pricing = pricing.NewStatic(pricing.Defaults()) // prod default: off
	_, body = c.do(s.HandleGetProject, p.ID, "")
	if out = read(body); out["bars_removal_available"] != false {
		t.Fatalf("switch off %s", body)
	}
	if owned, _ := s.ownedProject(ctx, c.user, p.ID); removeBars(owned) {
		t.Fatal("runs keep bars while the switch is off")
	}
}

// The run records remove_bars and the crop it takes off (admin and "Get
// another format" read them from params); kept bars or the switch off
// record nothing.
func TestRunParamsRecordBars(t *testing.T) {
	all := pricing.LifelikePresets
	p := barsProject(1920, 1080, "800:1920:140:0") // rotated letterbox
	params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction}, p, all)
	if err != nil || !params.RemoveBars || params.SourceCrop == nil || *params.SourceCrop != (store.Crop{X: 140, Y: 0, W: 800, H: 1920}) {
		t.Fatalf("removing %+v %v", params, err)
	}
	raw, _ := json.Marshal(params)
	var out map[string]any
	json.Unmarshal(raw, &out)
	if out["remove_bars"] != true || out["source_crop"].(map[string]any)["w"] != float64(800) {
		t.Fatalf("params json %s", raw)
	}
	if got := runBarsJSON(&store.Conversion{Params: params}); got.(*store.Crop).W != 800 || runBarsJSON(&store.Conversion{}) != nil {
		t.Fatalf("admin %v", got)
	}
	keep := false
	p.RemoveBars = &keep
	if params, _ := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction}, p, all); params.RemoveBars || params.SourceCrop != nil {
		t.Fatalf("kept %+v", params)
	}
	p.RemoveBars, p.BarsRemovalOff = nil, true
	if params, _ := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction}, p, all); params.RemoveBars || params.SourceCrop != nil {
		t.Fatalf("switch off %+v", params)
	}
	if params, _ := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction}, barsProject(1920, 1080, "1080:1920:0:0"), all); params.RemoveBars || params.SourceCrop != nil {
		t.Fatalf("no bars %+v", params)
	}
}

// /convert gets source_crop on every Lifelike path when the run removes
// bars, and nothing otherwise.
func TestLifelikeBodySourceCrop(t *testing.T) {
	crop := &store.Crop{X: 0, Y: 280, W: 3840, H: 1600}
	for _, c := range []*store.Conversion{
		{Step: store.StepProduction, Params: store.Params{Preset: "4k", RemoveBars: true, SourceCrop: crop}},
		{Step: store.StepProduction, Params: store.Params{Preset: "4k", RemoveBars: true, SourceCrop: crop, SplitMaxSeconds: 60}},
		{Step: store.StepProduction, Params: store.Params{Preset: "4k", RemoveBars: true, SourceCrop: crop, Express: true}},
		{Step: store.StepLifelikePreview, Params: store.Params{Preset: "4k", RemoveBars: true, SourceCrop: crop, FromFrame: 24, ToFrame: 144}},
	} {
		raw, _ := json.Marshal(lifelikeBody(c, 4))
		var b map[string]any
		json.Unmarshal(raw, &b)
		sc, _ := b["source_crop"].(map[string]any)
		if sc == nil || sc["x"] != float64(0) || sc["y"] != float64(280) || sc["w"] != float64(3840) || sc["h"] != float64(1600) {
			t.Fatalf("%s %+v: %s", c.Step, c.Params, raw)
		}
	}
	if b := lifelikeBody(&store.Conversion{Params: store.Params{Preset: "4k"}}, 4); b["source_crop"] != nil {
		t.Fatal("whole frame sends no source_crop")
	}
}

// With bars off, sizes are Lifelike's crop_output_size (the steps keep
// their long edge, the picture's aspect, never upscaled); without, the
// step's short side and the frame's aspect, turned like the picture.
func TestOutputDimsWithBars(t *testing.T) {
	all := pricing.LifelikePresets
	for _, tc := range []struct {
		name           string
		w, h           int
		crop, preset   string
		short, ow, oh  int
		remove, reach4 bool
	}{
		{"letterbox 4k", 3840, 2160, "3840:1600:0:280", "4k", 2160, 3840, 1600, true, true},
		{"letterbox 1080p", 3840, 2160, "3840:1600:0:280", "1080p", 2160, 1920, 800, true, true},
		{"pillarbox 1080p", 1920, 1080, "1440:1080:240:0", "1080p", 810, 1440, 1080, true, false},
		// Lifelike's rule keeps the long edge: a 4:3 crop at 1080p is 1920x1440
		{"4:3 pillarbox 1080p", 3840, 2160, "2880:2160:480:0", "1080p", 1620, 1920, 1440, true, false},
		{"4:3 pillarbox 3k", 3840, 2160, "2880:2160:480:0", "3k", 1620, 2880, 2160, true, false},
		{"rotated letterbox", 1920, 1080, "800:1920:140:0", "1080p", 1080, 800, 1920, true, false},
		{"rotated full frame", 1920, 1080, "1080:1920:0:0", "1080p", 1080, 1080, 1920, false, false},
		{"no crop", 3840, 2160, "", "4k", 2160, 3840, 2160, false, true},
	} {
		p := barsProject(tc.w, tc.h, tc.crop)
		if got := sourceShortSide(p); got != tc.short {
			t.Errorf("%s: short side %d", tc.name, got)
		}
		params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: tc.preset}, p, all)
		if err != nil || params.RemoveBars != tc.remove || params.OutputWidth != tc.ow || params.OutputHeight != tc.oh {
			t.Errorf("%s: %+v %v", tc.name, params, err)
		}
		_, err = resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "4k"}, p, all)
		if (err == nil) != tc.reach4 {
			t.Errorf("%s: 4k reachable %v", tc.name, err)
		}
	}
	// keeping the bars: the whole frame again
	p := barsProject(3840, 2160, "3840:1600:0:280")
	keep := false
	p.RemoveBars = &keep
	if params, _ := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "4k"}, p, all); params.OutputWidth != 3840 || params.OutputHeight != 2160 {
		t.Fatalf("kept %+v", params)
	}
}

// The quote shows the cropped output size, and the run records it.
func TestQuoteShowsCroppedSize(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	c := projCaller{t, s, &AuthedUser{UID: uid}}
	p := barsProject(3840, 2160, "3840:1600:0:280")
	p.ID, p.UID, p.Source.GCSKey, p.Analyze.State = store.NewID(), uid, "stereo3d/test/uploads/x.mp4", store.AnalyzeSucceeded
	p.Scenes = &store.Scenes{Version: 1, Cuts: []int{}}
	s.Store.CreateProject(ctx, p)
	code, body := c.do(s.HandleQuoteStep, p.ID, `{"step":"production","preset":"4k"}`)
	var out map[string]any
	json.Unmarshal([]byte(body), &out)
	if code != 200 || out["output_width"] != float64(3840) || out["output_height"] != float64(1600) || out["remove_bars"] != true {
		t.Fatalf("quote %d %s", code, body)
	}
	c.do(s.HandleUpdateProject, p.ID, `{"remove_bars":false}`)
	_, body = c.do(s.HandleQuoteStep, p.ID, `{"step":"production","preset":"4k"}`)
	json.Unmarshal([]byte(body), &out)
	if out["output_height"] != float64(2160) || out["remove_bars"] != false {
		t.Fatalf("kept %s", body)
	}
}

// cropOutputSize gives Lifelike's crop_output_size numbers (values from
// its formula, stereo_math.py at 1d23c0e, and the contract's table).
func TestCropOutputSizeMatchesLifelike(t *testing.T) {
	for _, tc := range [][5]int{
		{3840, 1600, 2160, 3840, 1600}, {3840, 1600, 1080, 1920, 800}, {1440, 1080, 1080, 1440, 1080},
		{2880, 2160, 1080, 1920, 1440}, {1998, 1080, 1080, 1920, 1038}, {800, 1920, 1080, 800, 1920},
		{4320, 4320, 2880, 4320, 4320}, {3600, 1500, 2160, 3600, 1500}, {1918, 817, 1080, 1918, 816},
		// LIFELIKE_API.md "Black bars" worked examples (2cca9a5)
		{3840, 1600, 1440, 2560, 1066}, {1216, 2160, 1080, 1080, 1920}, {800, 1920, 2160, 800, 1920},
	} {
		if w, h := cropOutputSize(tc[0], tc[1], tc[2]); w != tc[3] || h != tc[4] {
			t.Errorf("%v: %dx%d", tc, w, h)
		}
	}
}

// A near-square crop at 5K doubles past H.264 level 6.2 for full SBS:
// the size lists no sbs, a run asking for it is refused (a preview swaps
// to half SBS) and Get another format hides it, like 6K/8K; 4K of the
// same crop still has it.
func TestFullSBSLevelWithCrop(t *testing.T) {
	all := pricing.LifelikePresets
	p := barsProject(7680, 4320, "4320:4320:1680:0")
	if !fullSBSFits(3840, 3840) || fullSBSFits(4320, 4320) || !fullSBSFits(3840, 2160) {
		t.Fatal("level 6.2 frame size")
	}
	byPreset := map[string][]string{}
	for _, q := range lifelikeQualities(p, all) {
		byPreset[q.Preset] = q.Formats
	}
	if !slices.Contains(byPreset["4k"], "sbs") || slices.Contains(byPreset["5k"], "sbs") || !slices.Contains(byPreset["5k"], "half_sbs") {
		t.Fatalf("qualities %v", byPreset)
	}
	if _, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "5k", Formats: []string{"sbs"}}, p, all); err == nil || err.Code != "format_unavailable" {
		t.Fatalf("5k sbs %v", err)
	}
	prev, err := resolveLifelikeParams(&stepConvReq{Step: store.StepLifelikePreview, Preset: "5k", FromFrame: 0, ToFrame: 120}, p, all)
	if err != nil || !slices.Equal(prev.Formats, []string{"half_sbs", "mvhevc"}) || prev.OutputWidth != 4320 {
		t.Fatalf("5k preview %+v %v", prev, err)
	}
	if params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "4k", Formats: []string{"sbs"}}, p, all); err != nil || params.OutputWidth != 3840 {
		t.Fatalf("4k sbs %+v %v", params, err)
	}
	// keeping the bars: without a crop the rule is the preset's alone
	keep := false
	p.RemoveBars = &keep
	if params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "5k", Formats: []string{"sbs"}}, p, all); err != nil || fullSBSRefused(params) {
		t.Fatalf("kept bars 5k sbs %+v %v", params, err)
	}
	// Get another format on a finished cropped 5K run
	s, _ := formatsService(t)
	uid := "u" + store.NewID()
	c := finishedRun(t, s, uid, "5k", "mvhevc")
	s.Store.Transition(context.Background(), c.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		x.Params.RemoveBars, x.Params.SourceCrop = true, &store.Crop{X: 1680, W: 4320, H: 4320}
		x.Params.OutputWidth, x.Params.OutputHeight = 4320, 4320
		return nil
	})
	if _, out := formatsCall(s, uid, c.ID, http.MethodGet, ""); strings.Join(strs(out["available"]), ",") != "half_sbs" {
		t.Fatalf("formats %v", out)
	}
	if code, out := formatsCall(s, uid, c.ID, http.MethodPost, `{"format":"sbs"}`); code != 409 || out["details"].(map[string]any)["reason"] != "too_wide" {
		t.Fatalf("post sbs %d %v", code, out)
	}
}

// The crop sent is what Lifelike's submit checks take: even values,
// inside the frame (LIFELIKE_API.md "Black bars", 2cca9a5).
func TestSourceCropIsEven(t *testing.T) {
	p := barsProject(3840, 2160, "3839:1601:1:279")
	c, ok := barsCrop(p)
	if !ok || c != (store.Crop{X: 2, Y: 280, W: 3838, H: 1600}) || c.X+c.W > 3840 || c.Y+c.H > 2160 {
		t.Fatalf("crop %+v %v", c, ok)
	}
	params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "4k"}, p, pricing.LifelikePresets)
	if err != nil || params.SourceCrop == nil || *params.SourceCrop != c {
		t.Fatalf("params %+v %v", params, err)
	}
	b := lifelikeBody(&store.Conversion{Params: params}, 4)
	sc := b["source_crop"].(map[string]int)
	for _, k := range []string{"x", "y", "w", "h"} {
		if sc[k]%2 != 0 {
			t.Fatalf("odd %s in %v", k, sc)
		}
	}
}

// A crop refusal, as a failed job (the cold check at plan time) or a 400
// at submit, fails the run on the normal path: hold released, a free
// preview given back, the crop's words on the run.
func TestCropRefusalFailsCleanly(t *testing.T) {
	s, fake := e0Service(t)
	ctx := context.Background()
	jobErr := cropUnfitText
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"job_id": "j1", "status": "failed", "error": jobErr})
	}))
	t.Cleanup(srv.Close)
	s.Lifelike = modalapi.New(srv.URL, "", "")
	uid := "u" + store.NewID()
	p := &store.Project{ID: store.NewID(), UID: uid, Method: store.MethodLifelike,
		Probe: &store.Probe{FPS: 30, NumFrames: 3000, DurationS: 100}, Analyze: store.Analyze{State: store.AnalyzeSucceeded}}
	s.Store.CreateProject(ctx, p)
	params := store.Params{Preset: "4k", Formats: []string{"sbs"}, RemoveBars: true, SourceCrop: &store.Crop{Y: 280, W: 3840, H: 1600}}
	run := func(pi string, fp *store.FreePreview) *store.Conversion {
		now := time.Now()
		c := &store.Conversion{ID: store.NewID(), UID: uid, ProjectID: p.ID, Kind: "video", Method: store.MethodLifelike,
			Step: store.StepProduction, State: store.StateProcessing, Source: store.Source{FPS: 30, Frames: 3000},
			Params: params, Quote: store.Quote{AmountCents: 1200, Currency: "usd"}, FreePreview: fp,
			Modal: store.Modal{JobID: "j1", SubmittedAt: &now}}
		if pi != "" {
			fake.pis[pi] = map[string]any{"status": "requires_capture", "amount_received": int64(0)}
			c.Stripe = store.Stripe{PaymentIntentID: pi, PIStatus: "requires_capture"}
		}
		if err := s.Store.CreateConversion(ctx, c); err != nil {
			t.Fatal(err)
		}
		return c
	}
	got, err := s.refreshFromModal(ctx, run("pi_crop", nil))
	if err != nil || got.State != store.StateFailed || got.Error.Code != "source_crop_unfit" ||
		got.Error.UserMessage != "The crop area doesn't fit this video. You were not charged. Try again, or keep the black bars." {
		t.Fatalf("crop %+v %v", got.Error, err)
	}
	if fake.pis["pi_crop"]["status"] != "canceled" || got.Stripe.CapturedCents != 0 {
		t.Fatalf("hold %v %+v", fake.pis["pi_crop"], got.Stripe)
	}
	// a free preview's units come back
	day := time.Now().UTC().Format("2006-01-02")
	if ok, err := s.Store.ConsumeFreePreviews(ctx, uid, "intro", day, 1, 1, 5, true); !ok || err != nil {
		t.Fatalf("consume %v %v", ok, err)
	}
	jobErr = cropFullSBSText
	got, _ = s.refreshFromModal(ctx, run("", &store.FreePreview{Units: 1, PeriodKey: "intro", DayKey: day}))
	if got.Error.Code != "format_unavailable" || !strings.HasPrefix(got.Error.UserMessage, cropFullSBSText) || !got.FreePreview.Returned {
		t.Fatalf("sbs %+v %+v", got.Error, got.FreePreview)
	}
	if u, _ := s.Store.GetPreviewUsage(ctx, uid, "intro", day); u.IntroUsed || u.DayUsed != 0 {
		t.Fatalf("preview not given back %+v", u)
	}
	// a 400 at submit reads the same
	c := &store.Conversion{Params: params}
	if code, msg, ok := cropFailureCopy(c, `{"detail":"source_crop must fit inside the video's 1080x1920 displayed frame"}`); !ok || code != "source_crop_unfit" || !strings.HasPrefix(msg, cropUnfitText) {
		t.Fatalf("400 %s %s", code, msg)
	}
	if code, _, ok := cropFailureCopy(c, `{"detail":"full-width sbs of 8640x4320 isn't available (no video level covers it); use half_sbs"}`); !ok || code != "format_unavailable" {
		t.Fatalf("400 sbs %s", code)
	}
	if _, _, ok := cropFailureCopy(c, "CUDA out of memory"); ok {
		t.Fatal("other failures keep their copy")
	}
}

// The run keeps Lifelike's record of its crop.
func TestRunKeepsLifelikeCropRecord(t *testing.T) {
	c := &store.Conversion{}
	noteScheduling(c, &modalapi.Job{Metadata: json.RawMessage(`{"source_crop":{"x":0,"y":280,"w":3840,"h":1600},
		"source_crop_requested":{"x":0,"y":280,"w":3840,"h":1600},"source_display_size":[3840,2160]}`)})
	if c.Modal.SourceCrop == nil || *c.Modal.SourceCrop != (store.Crop{Y: 280, W: 3840, H: 1600}) || c.Modal.SourceCropRequested == nil ||
		!slices.Equal(c.Modal.SourceDisplaySize, []int{3840, 2160}) {
		t.Fatalf("record %+v", c.Modal)
	}
	// the whole frame sent: applied null, requested kept
	c = &store.Conversion{}
	noteScheduling(c, &modalapi.Job{Metadata: json.RawMessage(`{"source_crop":null,"source_crop_requested":{"x":0,"y":0,"w":1080,"h":1920},"source_display_size":[1080,1920]}`)})
	if c.Modal.SourceCrop != nil || c.Modal.SourceCropRequested.H != 1920 {
		t.Fatalf("no-op %+v", c.Modal)
	}
	c = &store.Conversion{}
	noteScheduling(c, &modalapi.Job{Metadata: json.RawMessage(`{"video_frames":10}`)})
	if c.Modal.SourceCrop != nil || c.Modal.SourceCropRequested != nil || c.Modal.SourceDisplaySize != nil {
		t.Fatalf("older job %+v", c.Modal)
	}
}
