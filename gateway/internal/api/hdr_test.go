package api

import (
	"context"
	"encoding/json"
	"testing"

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
	if out := view(iphone); out["dynamic_range"] != nil || out["hdr_source"] != nil || out["hdr_available"] != false ||
		out["probe"].(map[string]any)["dynamic_range"] != nil {
		t.Fatalf("hidden while off %v", out)
	}
	s.Pricing = pricing.NewStatic(on)
	if out := view(iphone); out["dynamic_range"] != "dv_8" || out["hdr_source"] != true || out["hdr_available"] != true {
		t.Fatalf("on %v", out)
	}
	sdr := foldDynamic(t, s, `{"streams":[{"profile":"High","color_transfer":"bt709"}]}`)
	if out := view(sdr); out["dynamic_range"] != "sdr" || out["hdr_source"] != false || out["hdr_available"] != false {
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
	if _, err := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction}, stored); err == nil || err.Status != 422 || err.Code != "source_unsupported" {
		t.Fatalf("dv5 guard %v", err)
	}
}
