package api

import (
	"slices"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// lifelike3d-test 2026-11-03: 5K-8K keep one original eye (null = left),
// are experimental, and refuse full-width SBS at 6K/8K.
func TestLifelikeAbove4K(t *testing.T) {
	p := lifelikeProject()
	p.Probe.Width, p.Probe.Height = 7680, 4320 // 8K source
	all := pricing.LifelikePresets
	qs := lifelikeQualities(p, all)
	if len(qs) != 7 {
		t.Fatalf("qualities: %+v", qs)
	}
	for _, q := range qs {
		above := q.LabelShortSide > 2160
		if q.OriginalEyeRequired != above || q.Experimental != above {
			t.Errorf("%s: eye %v experimental %v", q.ID, q.OriginalEyeRequired, q.Experimental)
		}
		if got := slices.Contains(q.Formats, "sbs"); got == (q.Preset == "6k" || q.Preset == "8k") {
			t.Errorf("%s formats %v", q.ID, q.Formats)
		}
	}
	params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "5k", Formats: []string{"mvhevc", "sbs"}}, p, all)
	if err != nil || params.OriginalEye != "left" || !slices.Contains(params.Formats, "sbs") {
		t.Fatalf("5k: %+v %v", params, err)
	}
	right := "right"
	if params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "6k", OriginalEye: &right}, p, all); err != nil || params.OriginalEye != "right" {
		t.Errorf("6k right: %+v %v", params, err)
	}
	if _, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "6k", Formats: []string{"sbs"}}, p, all); err == nil || err.Code != "format_unavailable" {
		t.Errorf("6k sbs: %v", err)
	}
	if params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "8k"}, p, all); err != nil || !slices.Equal(params.Formats, []string{"mvhevc", "half_sbs"}) {
		t.Errorf("8k default formats: %+v %v", params, err)
	}
	if params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepLifelikePreview, Preset: "8k", FromFrame: 0, ToFrame: 120}, p, all); err != nil || !slices.Equal(params.Formats, []string{"half_sbs"}) {
		t.Errorf("8k preview: %+v %v", params, err)
	}
	// up to 4K the original eye stays optional and off by default
	if params, err := resolveLifelikeParams(&stepConvReq{Step: store.StepProduction, Preset: "4k"}, p, all); err != nil || params.OriginalEye != "" {
		t.Errorf("4k: %+v %v", params, err)
	}
	c := &store.Conversion{Method: store.MethodLifelike, Params: store.Params{Preset: "6k"}}
	if resp := (&Service{}).conversionResponse(c, nil); resp["experimental"] != true {
		t.Errorf("experimental missing: %v", resp["experimental"])
	}
}

func TestTestEnvDefaults(t *testing.T) {
	test, prod := pricing.DefaultsFor("test"), pricing.DefaultsFor("prod")
	if !slices.Equal(test.EnabledLifelikePresets(), pricing.LifelikePresets) || !test.FoveationEnabled {
		t.Errorf("test: %v %v", test.EnabledLifelikePresets(), test.FoveationEnabled)
	}
	if slices.Contains(prod.EnabledLifelikePresets(), "5k") || prod.FoveationEnabled {
		t.Errorf("prod: %v %v", prod.EnabledLifelikePresets(), prod.FoveationEnabled)
	}
}
