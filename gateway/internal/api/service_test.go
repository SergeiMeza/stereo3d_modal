package api

import (
	"encoding/json"
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// bodyJSON marshals a modalBody map; encoding/json sorts map keys, so the
// output is deterministic and tests can assert the EXACT wire shape. 8 is
// the pricing default for max_gpu_workers, so this is the production shape.
func bodyJSON(t *testing.T, conv *store.Conversion) string {
	t.Helper()
	raw, err := json.Marshal((&Service{}).modalBody(conv, 8))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestModalBodyProStepExactShape(t *testing.T) {
	conv := &store.Conversion{
		ID: "c1", Kind: "video", Step: store.StepStereoPreview, ProjectID: "p1",
		Source: store.Source{GCSKey: "stereo3d/test/users/u1/abc/source.mp4"},
		Params: store.Params{
			Preset: "1080p", Formats: []string{"sbs"},
			TargetFPS: 12, FromFrame: 100, ToFrame: 200,
			Inpaint: "none", DepthRes: 1400, DepthScale: 0.8,
			SceneCuts: []int{240, 900},
			SceneOverrides: []store.SceneOverride{
				{First: 0, Displacement: 0.02},
				{First: 240, ShotType: "wide", Placement: []float64{-0.2, 0.4}},
			},
		},
	}
	want := `{"adaptive":true,` +
		`"depth_res":1400,` +
		`"depth_scale":0.8,` +
		`"formats":["sbs"],` +
		`"from_frame":100,` +
		`"inpaint":"none",` +
		`"input_path":"stereo3d/test/users/u1/abc/source.mp4",` +
		`"max_gpu_workers":8,` +
		`"notify":true,` +
		`"preset":"1080p",` +
		`"scene_cuts":[240,900],` +
		`"scene_overrides":[{"displacement":0.02,"first":0},{"first":240,"placement":[-0.2,0.4],"shot_type":"wide"}],` +
		`"target_fps":12,` +
		`"to_frame":200}`
	if got := bodyJSON(t, conv); got != want {
		t.Errorf("modal body mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestModalBodyAdaptiveForAllProSteps(t *testing.T) {
	for _, step := range []string{store.StepDepthPreview, store.StepStereoPreview, store.StepProduction} {
		conv := &store.Conversion{Kind: "video", Step: step,
			Params: store.Params{Preset: "draft", Formats: []string{"anaglyph"}}}
		body := (&Service{}).modalBody(conv, 8)
		if body["adaptive"] != true {
			t.Errorf("%s: adaptive must be true", step)
		}
	}
}

func TestModalBodyProStepAlwaysSendsCuts(t *testing.T) {
	// A pro step's cut list is authoritative even when EMPTY ([] = one
	// scene) — omitting it would make Modal re-run auto detection and
	// silently override the user's scene edit (and mistarget
	// scene_overrides). nil must encode as [] (JSON null reads as absent).
	for _, cuts := range [][]int{nil, {}} {
		conv := &store.Conversion{Kind: "video", Step: store.StepStereoPreview,
			Params: store.Params{Preset: "1080p", Formats: []string{"sbs"}, SceneCuts: cuts}}
		raw, err := json.Marshal((&Service{}).modalBody(conv, 8))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), `"scene_cuts":[]`) {
			t.Errorf("cuts=%#v: pro body must carry \"scene_cuts\":[], got %s", cuts, raw)
		}
	}
	// Legacy route: empty cuts stay omitted (auto-detect is the contract).
	legacy := &store.Conversion{Kind: "video",
		Params: store.Params{Preset: "1080p", Formats: []string{"sbs"}}}
	if _, present := (&Service{}).modalBody(legacy, 8)["scene_cuts"]; present {
		t.Error("legacy body must omit empty scene_cuts")
	}
}

func TestModalBodyLegacyVideoUnchanged(t *testing.T) {
	// Legacy mobile route (no step): displacement still forwards; no pro keys.
	conv := &store.Conversion{Kind: "video",
		Params: store.Params{Preset: "1080p", Formats: []string{"mvhevc"}, Displacement: 0.02}}
	body := (&Service{}).modalBody(conv, 8)
	if body["displacement"] != 0.02 {
		t.Errorf("displacement must forward for legacy conversions, got %v", body["displacement"])
	}
	for _, k := range []string{"adaptive", "depth_res", "depth_scale", "scene_overrides", "inpaint"} {
		if _, present := body[k]; present {
			t.Errorf("legacy body must not carry %q", k)
		}
	}
}

func TestModalBodySkipsUnsetProKnobs(t *testing.T) {
	conv := &store.Conversion{Kind: "video", Step: store.StepDepthPreview,
		Params: store.Params{Preset: "draft", Formats: []string{"anaglyph"}, Inpaint: "none", TargetFPS: 12}}
	body := (&Service{}).modalBody(conv, 8)
	for _, k := range []string{"depth_res", "depth_scale", "scene_overrides", "displacement"} {
		if _, present := body[k]; present {
			t.Errorf("unset knob %q must not be forwarded", k)
		}
	}
}

func TestModalBodyMaxGPUWorkers(t *testing.T) {
	conv := &store.Conversion{Kind: "video", Step: store.StepProduction,
		Params: store.Params{Preset: "4k", Formats: []string{"mvhevc"}}}
	// ≤0 omits the field so the pipeline default applies
	for _, n := range []int{0, -1} {
		if _, present := (&Service{}).modalBody(conv, n)["max_gpu_workers"]; present {
			t.Errorf("workers=%d: field must be omitted", n)
		}
	}
	if got := (&Service{}).modalBody(conv, 8)["max_gpu_workers"]; got != 8 {
		t.Errorf("want 8 workers forwarded, got %v", got)
	}
	// clamped to the workspace's 10-GPU ceiling
	if got := (&Service{}).modalBody(conv, 64)["max_gpu_workers"]; got != 10 {
		t.Errorf("want clamp to 10, got %v", got)
	}
	// image jobs never fan out — no worker cap on the image body
	img := &store.Conversion{Kind: "image"}
	if _, present := (&Service{}).modalBody(img, 8)["max_gpu_workers"]; present {
		t.Error("image body must not carry max_gpu_workers")
	}
}

// -------------------------------------------------------- scene profile fold

func TestProfileShotsDefensiveParsing(t *testing.T) {
	// Real-world metadata: depth_script entries carry extra research keys
	// (keyframes, confidence, ...) and other metadata siblings — all ignored.
	meta := json.RawMessage(`{
		"probe": {"fps": 24},
		"depth_script": [
			{"first_src": 0, "last_src": 240, "shot_type": "standard",
			 "displacement": 0.018, "placement": [-0.3, 0.5],
			 "keyframes": [0, 60, 120], "confidence": 0.91, "extra": {"a": 1}},
			{"first_src": 240, "last_src": 900, "shot_type": "close_up", "displacement": 0.01},
			{"shot_type": "wide", "displacement": 0.02, "keyframes": []}
		]
	}`)
	shots := profileShots(meta)
	if len(shots) != 2 { // third entry lacks first_src/last_src → skipped
		t.Fatalf("want 2 usable shots, got %d: %+v", len(shots), shots)
	}
	if shots[0].FirstSrc != 0 || shots[0].LastSrc != 240 || shots[0].ShotType != "standard" ||
		shots[0].Displacement != 0.018 || len(shots[0].Placement) != 2 || shots[0].Placement[0] != -0.3 {
		t.Errorf("shot 0 mangled: %+v", shots[0])
	}
	if shots[1].FirstSrc != 240 || shots[1].LastSrc != 900 || shots[1].Placement != nil {
		t.Errorf("shot 1 mangled: %+v", shots[1])
	}
}

func TestProfileShotsAcceptsZeroFrames(t *testing.T) {
	// first_src: 0 is a real value (first scene) — presence, not zero-ness,
	// must gate inclusion.
	shots := profileShots(json.RawMessage(`{"depth_script":[{"first_src":0,"last_src":1,"shot_type":"wide","displacement":0.01}]}`))
	if len(shots) != 1 || shots[0].FirstSrc != 0 || shots[0].LastSrc != 1 {
		t.Fatalf("want the frame-0 shot, got %+v", shots)
	}
}

func TestProfileShotsNoScript(t *testing.T) {
	cases := []json.RawMessage{
		nil,
		json.RawMessage(`{}`),
		json.RawMessage(`{"probe": {"fps": 24}}`),
		json.RawMessage(`{"depth_script": []}`),
		json.RawMessage(`{"depth_script": "not-a-list"}`),
		json.RawMessage(`not json at all`),
	}
	for _, meta := range cases {
		if shots := profileShots(meta); shots != nil && len(shots) != 0 {
			t.Errorf("metadata %s: want no shots, got %+v", meta, shots)
		}
	}
}
