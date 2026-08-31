package api

import (
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// PaymentIntent metadata must reconstruct the purchase without Firestore:
// full configuration, quote facts, reused stages — with the effective
// pipeline defaults spelled out and Firestore's []any round-trip handled.
func TestJobMetadataFromConversion(t *testing.T) {
	conv := &store.Conversion{
		Kind: "video", Step: store.StepProduction,
		Params: store.Params{
			Preset: "3k", Inpaint: "migan", Formats: []string{"mvhevc", "half_sbs"},
			TargetFPS: 24, DepthRes: 980, DepthScale: 1.1,
			SceneOverrides: []store.SceneOverride{
				{First: 0, Displacement: 0.02},
				{First: 240, Passthrough: true},
			},
		},
		Quote: store.Quote{Breakdown: map[string]any{
			"billable_seconds": 184.83,
			"reuse_stages":     []any{"depth", "preprocess"}, // post-Firestore shape
		}},
	}
	m := jobMetadataFromConversion(conv)
	want := map[string]string{
		"kind": "video", "step": "production", "preset": "3k",
		"inpaint": "migan", "warp": "forward", // default warp made explicit
		"formats": "mvhevc,half_sbs", "target_fps": "24",
		"depth_res": "980", "depth_scale": "1.1",
		"scene_overrides": "2", "passthrough_scenes": "1",
		"billable_seconds": "184.83", "reused_stages": "depth,preprocess",
		"output_height": "1620",
	}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s: want %q, got %q", k, v, m[k])
		}
	}
	if len(m) != len(want) {
		t.Errorf("unexpected extra keys: got %v", m)
	}
	// a legacy conversion (no pro fields) stays minimal — and never panics
	legacy := &store.Conversion{Kind: "video", Params: store.Params{Preset: "1080p", Formats: []string{"sbs"}}}
	lm := jobMetadataFromConversion(legacy)
	if lm["inpaint"] != "" || lm["warp"] != "" {
		t.Errorf("legacy: inpaint/warp must be absent, got %v", lm)
	}
}
