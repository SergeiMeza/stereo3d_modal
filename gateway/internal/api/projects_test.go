package api

import (
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// proProject is a project past analysis: 24 fps, 2400 frames, scene cuts at
// version 3.
func proProject() *store.Project {
	return &store.Project{
		ID:     "p1",
		Probe:  &store.Probe{FPS: 24, NumFrames: 2400, Width: 1920, Height: 1080, DurationS: 100},
		Scenes: &store.Scenes{Version: 3, Cuts: []int{240, 900, 1800}},
	}
}

func resolveOK(t *testing.T, req *stepConvReq) store.Params {
	t.Helper()
	params, err := resolveStepParams(req, proProject())
	if err != nil {
		t.Fatalf("resolveStepParams(%+v): unexpected error %q", req, err.Message)
	}
	return params
}

func resolveErr(t *testing.T, req *stepConvReq, wantSub string) {
	t.Helper()
	_, err := resolveStepParams(req, proProject())
	if err == nil {
		t.Fatalf("resolveStepParams(%+v): want error containing %q, got nil", req, wantSub)
	}
	if !strings.Contains(err.Message, wantSub) {
		t.Fatalf("resolveStepParams(%+v): want error containing %q, got %q", req, wantSub, err.Message)
	}
}

// ------------------------------------------------------------ step templates

func TestResolveDepthPreviewTemplate(t *testing.T) {
	p := resolveOK(t, &stepConvReq{Step: store.StepDepthPreview})
	if p.Preset != "draft" {
		t.Errorf("preset: want draft, got %s", p.Preset)
	}
	if len(p.Formats) != 1 || p.Formats[0] != "anaglyph" {
		t.Errorf("formats: want [anaglyph], got %v", p.Formats)
	}
	if p.Inpaint != "none" {
		t.Errorf("inpaint: want none, got %s", p.Inpaint)
	}
	if p.TargetFPS != 12 { // half of 24
		t.Errorf("target_fps: want 12, got %v", p.TargetFPS)
	}
	if p.SceneCuts == nil {
		t.Error("scene_cuts: want project cuts snapshot")
	}
}

func TestResolveDepthPreviewAcceptsDepthRes(t *testing.T) {
	// The whole point of the Depth page: pick the FINAL depth resolution here.
	p := resolveOK(t, &stepConvReq{Step: store.StepDepthPreview, DepthRes: 1400})
	if p.DepthRes != 1400 {
		t.Errorf("depth_res: want 1400, got %d", p.DepthRes)
	}
}

func TestResolveDepthPreviewIgnoresPresetAndFormats(t *testing.T) {
	p := resolveOK(t, &stepConvReq{Step: store.StepDepthPreview, Preset: "4k", Formats: []string{"sbs"}})
	if p.Preset != "draft" || len(p.Formats) != 1 || p.Formats[0] != "anaglyph" {
		t.Errorf("depth_preview must stay draft/anaglyph, got %s/%v", p.Preset, p.Formats)
	}
}

func TestResolveDepthPreviewRejectsStereoKnobs(t *testing.T) {
	resolveErr(t, &stepConvReq{Step: store.StepDepthPreview, Inpaint: "propainter"}, "fixed to none")
	resolveErr(t, &stepConvReq{Step: store.StepDepthPreview, DepthScale: 1.0}, "stereo_preview and production only")
	resolveErr(t, &stepConvReq{Step: store.StepDepthPreview,
		SceneOverrides: []sceneOverrideReq{{First: 0, ShotType: "wide"}}}, "stereo_preview and production only")
	// inpaint "none" matches the forced value — accepted as a no-op
	p := resolveOK(t, &stepConvReq{Step: store.StepDepthPreview, Inpaint: "none"})
	if p.Inpaint != "none" {
		t.Errorf("inpaint: want none, got %s", p.Inpaint)
	}
}

func TestResolveStereoPreviewTemplate(t *testing.T) {
	p := resolveOK(t, &stepConvReq{Step: store.StepStereoPreview})
	if p.Preset != "1080p" {
		t.Errorf("preset: want 1080p, got %s", p.Preset)
	}
	if len(p.Formats) != 1 || p.Formats[0] != "sbs" {
		t.Errorf("formats: want [sbs] default, got %v", p.Formats)
	}
	if p.Inpaint != "none" {
		t.Errorf("inpaint: want none default, got %s", p.Inpaint)
	}
	if p.TargetFPS != 12 {
		t.Errorf("target_fps: want 12, got %v", p.TargetFPS)
	}
}

func TestResolveStereoPreviewAcceptsOverrides(t *testing.T) {
	p := resolveOK(t, &stepConvReq{
		Step:       store.StepStereoPreview,
		Formats:    []string{"sbs", "anaglyph"},
		Inpaint:    "propainter",
		DepthRes:   980,
		DepthScale: 1.2,
		SceneOverrides: []sceneOverrideReq{
			{First: 0, Displacement: 0.02},
			{First: 900, ShotType: "wide", Placement: []float64{-0.2, 0.4}},
		},
	})
	if len(p.Formats) != 2 || p.Formats[1] != "anaglyph" {
		t.Errorf("formats: want [sbs anaglyph], got %v", p.Formats)
	}
	if p.Inpaint != "propainter" || p.DepthRes != 980 || p.DepthScale != 1.2 {
		t.Errorf("overrides not applied: %+v", p)
	}
	if len(p.SceneOverrides) != 2 || p.SceneOverrides[1].ShotType != "wide" {
		t.Errorf("scene_overrides: got %+v", p.SceneOverrides)
	}
}

func TestResolveProductionTemplate(t *testing.T) {
	p := resolveOK(t, &stepConvReq{Step: store.StepProduction})
	if p.Preset != "1080p" {
		t.Errorf("preset: want 1080p, got %s", p.Preset)
	}
	if len(p.Formats) != 2 || p.Formats[0] != "mvhevc" || p.Formats[1] != "half_sbs" {
		t.Errorf("formats: want [mvhevc half_sbs], got %v", p.Formats)
	}
	if p.Inpaint != "propainter" {
		t.Errorf("inpaint: want propainter default, got %s", p.Inpaint)
	}
	if p.TargetFPS != 0 { // full source fps
		t.Errorf("target_fps: want 0 (source), got %v", p.TargetFPS)
	}
	// production accepts everything (depth_res 2100 fits the 16:9 source's
	// aspect ceiling ~2184; 2520 would now be rejected — see the ceiling test).
	p = resolveOK(t, &stepConvReq{Step: store.StepProduction, Preset: "4k", Inpaint: "none",
		DepthRes: 2100, DepthScale: 0.3,
		SceneOverrides: []sceneOverrideReq{{First: 240, Displacement: 0.03}}})
	if p.Preset != "4k" || p.Inpaint != "none" || p.DepthRes != 2100 || p.DepthScale != 0.3 {
		t.Errorf("production overrides not applied: %+v", p)
	}
}

func TestResolveUnknownStep(t *testing.T) {
	resolveErr(t, &stepConvReq{Step: "remaster"}, "step must be")
}

// -------------------------------------------------------- field validation

func TestResolveDepthResValidation(t *testing.T) {
	// proProject() is 1920×1080 (1.78:1); its aspect ceiling is ~2184, so the
	// old top-of-rail 2520 is now rejected on THIS source (see the aspect test
	// below). Keep the ok set within the 16:9 ceiling.
	ok := []int{0, 140, 154, 980, 2100}
	for _, v := range ok {
		p := resolveOK(t, &stepConvReq{Step: store.StepProduction, DepthRes: v})
		if p.DepthRes != v {
			t.Errorf("depth_res=%d: not applied, got %d", v, p.DepthRes)
		}
	}
	bad := []int{-14, 13, 126, 139, 141, 979, 2534}
	for _, v := range bad {
		resolveErr(t, &stepConvReq{Step: store.StepProduction, DepthRes: v}, "multiple of 14")
	}
}

// TestResolveDepthResAspectCeiling guards the working-megapixel VRAM ceiling:
// depth_res² × elongation must fit the B200 tier, so a wide source caps out at
// a lower depth_res than the flat [140,2520] rail. This is the bug where a
// 2.39:1 4K source at depth_res 2156 (11.11 MP) sailed past the gateway and
// only failed mid-job in Modal.
func TestResolveDepthResAspectCeiling(t *testing.T) {
	// maxDepthResForAspect: sqrt(8.5e6/elongation) floored to ×14.
	for _, tc := range []struct {
		w, h, want int
	}{
		{1920, 1080, 2184}, // 16:9  → sqrt(8.5e6/1.7778)=2186 → 2184
		{3840, 1608, 1876}, // 2.39:1 → sqrt(8.5e6/2.3881)=1885 → 1876
		{1080, 1080, 2520}, // 1:1   → sqrt(8.5e6)=2915, clamped to the 2520 rail
	} {
		if got := maxDepthResForAspect(tc.w, tc.h); got != tc.want {
			t.Errorf("maxDepthResForAspect(%d,%d) = %d, want %d", tc.w, tc.h, got, tc.want)
		}
	}
	if maxDepthResForAspect(0, 0) != 0 {
		t.Error("maxDepthResForAspect(0,0): want 0 (unknown dims skip the check)")
	}

	// Wide 2.39:1 4K source: the reported failing value must now be rejected
	// at submit with an actionable max, while a value under the ceiling passes.
	wide := &store.Project{
		Probe:  &store.Probe{FPS: 24, NumFrames: 2400, Width: 3840, Height: 1608},
		Scenes: &store.Scenes{Version: 3, Cuts: []int{240}},
	}
	if _, err := resolveStepParams(&stepConvReq{Step: store.StepProduction, DepthRes: 2156}, wide); err == nil {
		t.Fatal("depth_res 2156 on a 2.39:1 source: want VRAM-ceiling rejection, got nil")
	} else if !strings.Contains(err.Message, "VRAM ceiling") || !strings.Contains(err.Message, "1876") {
		t.Errorf("want error naming the ceiling and max 1876, got %q", err.Message)
	}
	if p, err := resolveStepParams(&stepConvReq{Step: store.StepProduction, DepthRes: 1876}, wide); err != nil {
		t.Errorf("depth_res 1876 (at the ceiling) on a 2.39:1 source: unexpected error %q", err.Message)
	} else if p.DepthRes != 1876 {
		t.Errorf("depth_res 1876: not applied, got %d", p.DepthRes)
	}
}

func TestResolveDepthScaleValidation(t *testing.T) {
	for _, v := range []float64{0, 0.3, 1.0, 1.5} {
		p := resolveOK(t, &stepConvReq{Step: store.StepStereoPreview, DepthScale: v})
		if p.DepthScale != v {
			t.Errorf("depth_scale=%v: not applied, got %v", v, p.DepthScale)
		}
	}
	for _, v := range []float64{-1, 0.29, 1.51, 5} {
		resolveErr(t, &stepConvReq{Step: store.StepStereoPreview, DepthScale: v}, "depth_scale")
	}
}

func TestResolveInpaintValidation(t *testing.T) {
	resolveErr(t, &stepConvReq{Step: store.StepStereoPreview, Inpaint: "lama"}, "inpaint must be")
	for _, step := range []string{store.StepStereoPreview, store.StepProduction} {
		for _, v := range []string{"none", "propainter"} {
			p := resolveOK(t, &stepConvReq{Step: step, Inpaint: v})
			if p.Inpaint != v {
				t.Errorf("%s inpaint=%s: not applied, got %s", step, v, p.Inpaint)
			}
		}
	}
}

func TestResolveDisplacementRejectedOnProSteps(t *testing.T) {
	// Global displacement is the legacy mobile knob; pro steps use
	// scene_overrides / depth_scale.
	for _, step := range []string{store.StepDepthPreview, store.StepStereoPreview, store.StepProduction} {
		resolveErr(t, &stepConvReq{Step: step, Displacement: 0.02}, "not a pro-step parameter")
	}
}

// -------------------------------------------------------- scene_overrides

func soReq(overrides ...sceneOverrideReq) *stepConvReq {
	return &stepConvReq{Step: store.StepStereoPreview, SceneOverrides: overrides}
}

func TestSceneOverridesValid(t *testing.T) {
	p := resolveOK(t, soReq(
		sceneOverrideReq{First: 0, Displacement: 0.02},
		sceneOverrideReq{First: 900, ShotType: "close_up"},
		sceneOverrideReq{First: 1800, Placement: []float64{-1.5, 1.5}},
	))
	if len(p.SceneOverrides) != 3 {
		t.Fatalf("want 3 overrides, got %d", len(p.SceneOverrides))
	}
	if p.SceneOverrides[0].Displacement != 0.02 || p.SceneOverrides[1].ShotType != "close_up" ||
		p.SceneOverrides[2].Placement[1] != 1.5 {
		t.Errorf("overrides mangled: %+v", p.SceneOverrides)
	}
}

func TestSceneOverridesFirstMustBeSceneStart(t *testing.T) {
	// firsts are validated against the CURRENT scene cuts (240, 900, 1800)
	resolveErr(t, soReq(sceneOverrideReq{First: 100, ShotType: "wide"}), "not a scene start")
	resolveErr(t, soReq(sceneOverrideReq{First: -240, ShotType: "wide"}), "not a scene start")
	for _, f := range []int{0, 240, 900, 1800} {
		resolveOK(t, soReq(sceneOverrideReq{First: f, ShotType: "wide"}))
	}
}

func TestSceneOverridesStrictlyIncreasing(t *testing.T) {
	resolveErr(t, soReq(
		sceneOverrideReq{First: 240, ShotType: "wide"},
		sceneOverrideReq{First: 240, ShotType: "standard"},
	), "strictly increasing")
	resolveErr(t, soReq(
		sceneOverrideReq{First: 900, ShotType: "wide"},
		sceneOverrideReq{First: 240, ShotType: "standard"},
	), "strictly increasing")
}

func TestSceneOverridesNeedAKey(t *testing.T) {
	resolveErr(t, soReq(sceneOverrideReq{First: 240}), "no override keys")
}

func TestSceneOverridesDisplacementBounds(t *testing.T) {
	resolveOK(t, soReq(sceneOverrideReq{First: 0, Displacement: 0.03})) // upper bound inclusive
	resolveErr(t, soReq(sceneOverrideReq{First: 0, Displacement: 0.031}), "displacement")
	resolveErr(t, soReq(sceneOverrideReq{First: 0, Displacement: -0.01}), "displacement")
}

func TestSceneOverridesShotTypeEnum(t *testing.T) {
	for _, st := range []string{"close_up", "standard", "dynamic", "wide"} {
		resolveOK(t, soReq(sceneOverrideReq{First: 0, ShotType: st}))
	}
	resolveErr(t, soReq(sceneOverrideReq{First: 0, ShotType: "closeup"}), "shot_type")
}

func TestSceneOverridesPlacementBounds(t *testing.T) {
	resolveOK(t, soReq(sceneOverrideReq{First: 0, Placement: []float64{-0.2, 0.4}}))
	resolveErr(t, soReq(sceneOverrideReq{First: 0, Placement: []float64{0.4}}), "placement")
	resolveErr(t, soReq(sceneOverrideReq{First: 0, Placement: []float64{0.4, 0.4}}), "placement")  // far < near
	resolveErr(t, soReq(sceneOverrideReq{First: 0, Placement: []float64{0.4, -0.2}}), "placement") // inverted
	resolveErr(t, soReq(sceneOverrideReq{First: 0, Placement: []float64{-1.6, 0}}), "placement")   // below rail
	resolveErr(t, soReq(sceneOverrideReq{First: 0, Placement: []float64{0, 1.6}}), "placement")    // above rail
	resolveErr(t, soReq(sceneOverrideReq{First: 0, Placement: []float64{-0.2, 0.4, 1}}), "placement")
}

func TestSceneOverridesNeedScenes(t *testing.T) {
	p := proProject()
	p.Scenes = nil
	_, err := resolveStepParams(soReq(sceneOverrideReq{First: 0, ShotType: "wide"}), p)
	if err == nil || !strings.Contains(err.Message, "no scene list") {
		t.Fatalf("want scene-list error, got %v", err)
	}
}

// ------------------------------------------------------------ scenes stamp

func TestStampScenesVersion(t *testing.T) {
	conv := &store.Conversion{}
	stampScenes(conv, proProject())
	if conv.ScenesVer != 3 {
		t.Errorf("want scenes_version 3, got %d", conv.ScenesVer)
	}
	conv = &store.Conversion{}
	stampScenes(conv, &store.Project{})
	if conv.ScenesVer != 0 {
		t.Errorf("want scenes_version 0 for unanalyzed project, got %d", conv.ScenesVer)
	}
}

// --------------------------------------------------------------- passthrough

func TestResolvePassthroughOverride(t *testing.T) {
	p := resolveOK(t, &stepConvReq{Step: store.StepStereoPreview,
		SceneOverrides: []sceneOverrideReq{{First: 240, Passthrough: true}}})
	if len(p.SceneOverrides) != 1 || !p.SceneOverrides[0].Passthrough {
		t.Errorf("passthrough override not carried: %+v", p.SceneOverrides)
	}
}

func TestResolvePassthroughExclusiveWithDepthKnobs(t *testing.T) {
	resolveErr(t, &stepConvReq{Step: store.StepStereoPreview,
		SceneOverrides: []sceneOverrideReq{{First: 240, Passthrough: true, ShotType: "wide"}}},
		"cannot be combined")
	resolveErr(t, &stepConvReq{Step: store.StepStereoPreview,
		SceneOverrides: []sceneOverrideReq{{First: 240, Passthrough: true, Displacement: 0.01}}},
		"cannot be combined")
}
