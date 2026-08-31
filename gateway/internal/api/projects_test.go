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

// squareProbeProject is a 1:1 source (elongation 1). Its depth aspect cap is
// √(8.5e6) ≈ 2915 → 2912, above the whole [140, 2520] rail — so depth_res
// format/range tests exercise their own rail without the VRAM ceiling
// interfering. Use proProject() (16:9) when the aspect ceiling itself is under
// test.
func squareProbeProject() *store.Project {
	p := proProject()
	p.Probe.Width, p.Probe.Height = 2160, 2160
	return p
}

func resolveOKP(t *testing.T, req *stepConvReq, p *store.Project) store.Params {
	t.Helper()
	params, err := resolveStepParams(req, p)
	if err != nil {
		t.Fatalf("resolveStepParams(%+v): unexpected error %q", req, err.Message)
	}
	return params
}

func resolveOK(t *testing.T, req *stepConvReq) store.Params {
	t.Helper()
	return resolveOKP(t, req, proProject())
}

func resolveErrP(t *testing.T, req *stepConvReq, p *store.Project, wantSub string) {
	t.Helper()
	_, err := resolveStepParams(req, p)
	if err == nil {
		t.Fatalf("resolveStepParams(%+v): want error containing %q, got nil", req, wantSub)
	}
	if !strings.Contains(err.Message, wantSub) {
		t.Fatalf("resolveStepParams(%+v): want error containing %q, got %q", req, wantSub, err.Message)
	}
}

func resolveErr(t *testing.T, req *stepConvReq, wantSub string) {
	t.Helper()
	resolveErrP(t, req, proProject(), wantSub)
}

// ------------------------------------------------------------ step templates

func TestResolveDepthPreviewTemplate(t *testing.T) {
	p := resolveOK(t, &stepConvReq{Step: store.StepDepthPreview})
	if p.Preset != "draft" {
		t.Errorf("preset: want draft, got %s", p.Preset)
	}
	if !p.DepthOnly {
		t.Error("depth_only: want true (the Depth page never runs stereo)")
	}
	if len(p.Formats) != 0 || p.Formats == nil {
		t.Errorf("formats: want non-nil empty (nothing encoded), got %v", p.Formats)
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
	if p.Preset != "draft" || len(p.Formats) != 0 || !p.DepthOnly {
		t.Errorf("depth_preview must stay draft/depth-only with no formats, got %s/%v (depth_only=%v)",
			p.Preset, p.Formats, p.DepthOnly)
	}
}

func TestResolveDepthPreviewRejectsStereoKnobs(t *testing.T) {
	resolveErr(t, &stepConvReq{Step: store.StepDepthPreview, Inpaint: "propainter"}, "fixed to none")
	resolveErr(t, &stepConvReq{Step: store.StepDepthPreview, DepthScale: 1.0}, "stereo_preview and production only")
	// depth knobs in scene_overrides stay stereo-only on the depth step…
	resolveErr(t, &stepConvReq{Step: store.StepDepthPreview,
		SceneOverrides: []sceneOverrideReq{{First: 0, ShotType: "wide"}}}, "passthrough only")
	resolveErr(t, &stepConvReq{Step: store.StepDepthPreview,
		SceneOverrides: []sceneOverrideReq{
			{First: 0, Passthrough: true},
			{First: 240, Displacement: 0.02},
		}}, "passthrough only")
	// inpaint "none" matches the forced value — accepted as a no-op
	p := resolveOK(t, &stepConvReq{Step: store.StepDepthPreview, Inpaint: "none"})
	if p.Inpaint != "none" {
		t.Errorf("inpaint: want none, got %s", p.Inpaint)
	}
}

func TestResolveDepthPreviewAcceptsPassthroughOverrides(t *testing.T) {
	// passthrough-ONLY overrides are the depth step's scene input: Modal
	// skips the AI depth pass for those scenes and writes black depth.
	p := resolveOK(t, &stepConvReq{Step: store.StepDepthPreview,
		SceneOverrides: []sceneOverrideReq{
			{First: 0, Passthrough: true},
			{First: 900, Passthrough: true},
		}})
	if len(p.SceneOverrides) != 2 || !p.SceneOverrides[0].Passthrough || !p.SceneOverrides[1].Passthrough {
		t.Errorf("passthrough overrides not applied: %+v", p.SceneOverrides)
	}
	if p.SceneOverrides[1].First != 900 {
		t.Errorf("first: want 900, got %d", p.SceneOverrides[1].First)
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

func TestResolveRejectsExplicitEmptyFormats(t *testing.T) {
	// Deselecting every format in the UI must not silently fall back to the
	// step default — reject at the source. Absent (nil) keeps meaning
	// "step default"; depth_preview ignores formats entirely.
	for _, step := range []string{store.StepStereoPreview, store.StepProduction} {
		resolveErr(t, &stepConvReq{Step: step, Formats: []string{}}, "at least one output format")
	}
	p := resolveOK(t, &stepConvReq{Step: store.StepDepthPreview, Formats: []string{}})
	if !p.DepthOnly {
		t.Errorf("depth_preview must ignore an empty formats list, got %+v", p)
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
	// production accepts everything (square source so depth_res 2520 clears the
	// aspect-aware VRAM ceiling — a 16:9 source would reject 2520; see
	// TestResolveDepthResAspectCeiling).
	p = resolveOKP(t, &stepConvReq{Step: store.StepProduction, Preset: "4k", Inpaint: "none",
		DepthRes: 2520, DepthScale: 0.3,
		SceneOverrides: []sceneOverrideReq{{First: 240, Displacement: 0.03}}}, squareProbeProject())
	if p.Preset != "4k" || p.Inpaint != "none" || p.DepthRes != 2520 || p.DepthScale != 0.3 {
		t.Errorf("production overrides not applied: %+v", p)
	}
}

func TestResolveUnknownStep(t *testing.T) {
	resolveErr(t, &stepConvReq{Step: "remaster"}, "step must be")
}

// -------------------------------------------------------- field validation

func TestResolveDepthResValidation(t *testing.T) {
	// Square source: the aspect-aware VRAM ceiling clears the whole rail, so
	// this test exercises only the format/range rail (multiple of 14 in [140,
	// 2520]). The aspect ceiling has its own test below.
	sq := squareProbeProject()
	ok := []int{0, 140, 154, 980, 2520}
	for _, v := range ok {
		p := resolveOKP(t, &stepConvReq{Step: store.StepProduction, DepthRes: v}, sq)
		if p.DepthRes != v {
			t.Errorf("depth_res=%d: not applied, got %d", v, p.DepthRes)
		}
	}
	bad := []int{-14, 13, 126, 139, 141, 979, 2534}
	for _, v := range bad {
		resolveErrP(t, &stepConvReq{Step: store.StepProduction, DepthRes: v}, sq, "multiple of 14")
	}
}

// The bug this guards: the flat [140, 2520] rail passes wide-aspect depth_res
// values Modal's B200 VRAM ceiling (work_mp = depth_res² × elongation ≤ 8.5)
// cannot fit, so the job failed deep inside Modal. The gateway now rejects them
// up front with the largest depth_res the source aspect allows.
func TestResolveDepthResAspectCeiling(t *testing.T) {
	// 2.39:1 source (5120×2142): the offending real-world case. depth_res 2156
	// → 2156² × 2.390 / 1e6 = 11.11 MP, well over the 8.5 ceiling → rejected.
	wide := proProject()
	wide.Probe.Width, wide.Probe.Height = 5120, 2142
	resolveErrP(t, &stepConvReq{Step: store.StepProduction, DepthRes: 2156}, wide, "exceeds the GPU VRAM ceiling")
	// The aspect cap on this source is 1876 (⌊√(8.5e6/2.390)⌋ → ×14); a value at
	// or below it is accepted.
	p := resolveOKP(t, &stepConvReq{Step: store.StepProduction, DepthRes: 1876}, wide)
	if p.DepthRes != 1876 {
		t.Errorf("depth_res 1876 must clear the 2.39:1 ceiling, got %d", p.DepthRes)
	}
	// A 16:9 source rejects even the rail-max 2520 (11.3 MP > 8.5).
	resolveErr(t, &stepConvReq{Step: store.StepProduction, DepthRes: 2520}, "exceeds the GPU VRAM ceiling")
	// With no probe (dimensions unknown) the aspect check is skipped — the flat
	// rail still applies, so a rail-valid value is accepted.
	noProbe := proProject()
	noProbe.Probe = nil
	if p := resolveOKP(t, &stepConvReq{Step: store.StepProduction, DepthRes: 2520}, noProbe); p.DepthRes != 2520 {
		t.Errorf("no-probe depth_res 2520 must pass the flat rail, got %d", p.DepthRes)
	}
}

// The bug this guards: Modal enforces the VRAM ceiling on the POST-CROP work
// file (preprocess removes letterbox bars), so a 2.39:1 film in a 16:9
// 3840×2160 container passed the container-aspect check here (2100² × 1.78 =
// 7.84 MP ≤ 8.5) and then failed inside Modal at 2100² × 2.39 = 10.54 MP. The
// gateway must validate at the analyze-detected content crop.
func TestResolveDepthResCropAwareCeiling(t *testing.T) {
	letterboxed := proProject()
	letterboxed.Probe.Width, letterboxed.Probe.Height = 3840, 2160
	letterboxed.Crop = "3840:1606:0:277" // 2.39:1 content inside the 16:9 container

	// The container aspect alone would accept 2100; the crop must reject it.
	resolveErrP(t, &stepConvReq{Step: store.StepProduction, DepthRes: 2100}, letterboxed,
		"after black-bar crop")
	// At or below the cropped-aspect cap (⌊√(8.5e6/2.391)⌋ → ×14 = 1876) passes.
	if p := resolveOKP(t, &stepConvReq{Step: store.StepProduction, DepthRes: 1876}, letterboxed); p.DepthRes != 1876 {
		t.Errorf("depth_res 1876 must clear the cropped 2.39:1 ceiling, got %d", p.DepthRes)
	}

	// Same container WITHOUT a crop: 2100 fits the 16:9 ceiling (7.84 MP).
	uncropped := proProject()
	uncropped.Probe.Width, uncropped.Probe.Height = 3840, 2160
	if p := resolveOKP(t, &stepConvReq{Step: store.StepProduction, DepthRes: 2100}, uncropped); p.DepthRes != 2100 {
		t.Errorf("uncropped 16:9 depth_res 2100 must pass, got %d", p.DepthRes)
	}

	// A malformed crop string falls back to the container probe (no crash,
	// container-aspect validation).
	malformed := proProject()
	malformed.Probe.Width, malformed.Probe.Height = 3840, 2160
	malformed.Crop = "not-a-crop"
	if p := resolveOKP(t, &stepConvReq{Step: store.StepProduction, DepthRes: 2100}, malformed); p.DepthRes != 2100 {
		t.Errorf("malformed crop must fall back to probe dims, got %d", p.DepthRes)
	}
	// A full-frame crop (no bars detected) behaves identically to no crop.
	fullframe := proProject()
	fullframe.Probe.Width, fullframe.Probe.Height = 3840, 2160
	fullframe.Crop = "3840:2160:0:0"
	if p := resolveOKP(t, &stepConvReq{Step: store.StepProduction, DepthRes: 2100}, fullframe); p.DepthRes != 2100 {
		t.Errorf("full-frame crop depth_res 2100 must pass, got %d", p.DepthRes)
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

func TestResolveWarpValidation(t *testing.T) {
	resolveErr(t, &stepConvReq{Step: store.StepStereoPreview, Warp: "gather"}, "warp must be")
	resolveErr(t, &stepConvReq{Step: store.StepDepthPreview, Warp: "backward"}, "stereo_preview and production only")
	// backward + an explicit inpaint model is a contradiction (no holes to fill)
	resolveErr(t, &stepConvReq{Step: store.StepProduction, Warp: "backward", Inpaint: "propainter"}, "cannot be combined")
	for _, step := range []string{store.StepStereoPreview, store.StepProduction} {
		// forward keeps the step's inpaint default / explicit value
		p := resolveOK(t, &stepConvReq{Step: step, Warp: "forward", Inpaint: "propainter"})
		if p.Warp != "forward" || p.Inpaint != "propainter" {
			t.Errorf("%s warp=forward: got warp=%s inpaint=%s", step, p.Warp, p.Inpaint)
		}
		// backward forces inpaint none — even on production, whose default
		// is propainter — and accepts an explicit none
		for _, inpaint := range []string{"", "none"} {
			p = resolveOK(t, &stepConvReq{Step: step, Warp: "backward", Inpaint: inpaint})
			if p.Warp != "backward" || p.Inpaint != "none" {
				t.Errorf("%s warp=backward inpaint=%q: got warp=%s inpaint=%s", step, inpaint, p.Warp, p.Inpaint)
			}
		}
	}
	// absent warp: not stored (pipeline default), inpaint untouched
	p := resolveOK(t, &stepConvReq{Step: store.StepProduction})
	if p.Warp != "" || p.Inpaint != "propainter" {
		t.Errorf("no warp: got warp=%q inpaint=%s", p.Warp, p.Inpaint)
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

// ------------------------------------------------------------- depth upload

// uploadProject is proProject with a registered depth-map upload.
func uploadProject() *store.Project {
	p := proProject()
	p.DepthUpload = &store.DepthUpload{
		GCSKey: "uploads/users/u1/dm1.mp4", Name: "my-depth.mp4",
		Frames: 2400, Width: 1920, Height: 1080, Bytes: 1 << 20,
	}
	return p
}

func TestResolveUseUploadedDepth(t *testing.T) {
	p := resolveOKP(t, &stepConvReq{Step: store.StepStereoPreview, UseUploadedDepth: true,
		TargetFPS: 12}, uploadProject())
	if p.DepthSource != "uploads/users/u1/dm1.mp4" {
		t.Errorf("want DepthSource resolved from the project, got %q", p.DepthSource)
	}
	// the upload is frame-exact against the FULL source, so the half-rate
	// preview default (and any explicit decimation) is cleared
	if p.TargetFPS != 0 {
		t.Errorf("want TargetFPS cleared to 0 (full source rate), got %v", p.TargetFPS)
	}
	if p.DepthRes != 0 {
		t.Errorf("want DepthRes 0 with an uploaded depth, got %d", p.DepthRes)
	}
}

func TestResolveUseUploadedDepthRejections(t *testing.T) {
	// no upload registered on the project
	resolveErr(t, &stepConvReq{Step: store.StepStereoPreview, UseUploadedDepth: true},
		"no uploaded depth map")
	// meaningless on the depth step
	resolveErrP(t, &stepConvReq{Step: store.StepDepthPreview, UseUploadedDepth: true},
		uploadProject(), "stereo_preview and production")
	// mutually exclusive with depth_res
	resolveErrP(t, &stepConvReq{Step: store.StepProduction, UseUploadedDepth: true,
		DepthRes: 980}, uploadProject(), "mutually exclusive")
	// trims cannot match a full-length frame-exact depth file
	resolveErrP(t, &stepConvReq{Step: store.StepProduction, UseUploadedDepth: true,
		FromFrame: 10, ToFrame: 100}, uploadProject(), "does not support trimming")
}

func TestStepQuoteInputsUploadedDepthSkipsFactor(t *testing.T) {
	svc := &Service{}
	p := uploadProject()
	params := resolveOKP(t, &stepConvReq{Step: store.StepStereoPreview,
		UseUploadedDepth: true}, p)
	in := svc.stepQuoteInputs(p, params, store.StepStereoPreview, 100)
	if in.DepthRes != 0 {
		t.Errorf("uploaded depth must not carry a depth_res factor, got %d", in.DepthRes)
	}
	if in.EffectiveFPS != 24 {
		t.Errorf("uploaded depth runs at the source rate; want EffectiveFPS 24, got %v", in.EffectiveFPS)
	}
	// without the upload the preset default applies (regression guard)
	params2 := resolveOKP(t, &stepConvReq{Step: store.StepStereoPreview}, p)
	in2 := svc.stepQuoteInputs(p, params2, store.StepStereoPreview, 100)
	if in2.DepthRes != 980 {
		t.Errorf("want preset-default depth_res 980, got %d", in2.DepthRes)
	}
}
