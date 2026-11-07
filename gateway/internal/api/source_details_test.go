package api

import (
	"context"
	"encoding/json"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/probe"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

const iphoneFacts = `{"streams":[
 {"codec_type":"video","codec_name":"hevc","profile":"Main 10","pix_fmt":"yuv420p10le","bit_rate":"24103112","color_transfer":"arib-std-b67","color_primaries":"bt2020",
  "side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]},
 {"codec_type":"audio","codec_name":"aac","channels":2,"sample_rate":"44100","bit_rate":"173000"}],
 "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"3.0","tags":{"major_brand":"qt  ","com.apple.quicktime.make":"Apple","com.apple.quicktime.model":"iPhone 15 Pro Max"}}}`

func viewJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(v)
	var out map[string]any
	json.Unmarshal(raw, &out)
	return out
}

// Analysis stores the facts; the project shows source_details (colour
// only while HDR output is on); a project analyzed before has
// details_read false; the console's source has the facts and colour.
func TestSourceDetails(t *testing.T) {
	s, _ := e0Service(t)
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	prev := factsSource
	factsSource = func(context.Context, *Service, *store.Project) (*probe.Facts, error) {
		return probe.ParseFacts([]byte(iphoneFacts))
	}
	t.Cleanup(func() { factsSource = prev })
	p := foldWith(t, s, 90, 30, 90, 3)
	if p.Analyze.State != store.AnalyzeSucceeded || p.Probe.Details == nil || p.Probe.Details.CameraModel != "iPhone 15 Pro Max" {
		t.Fatalf("stored %+v", p.Probe)
	}
	p.Source.Filename, p.Crop = "IMG_4869.MOV", "1920:800:0:140"
	out := viewJSON(t, s.projectResponse(p, nil))
	sd := out["source_details"].(map[string]any)
	file, video, audio := sd["file"].(map[string]any), sd["video"].(map[string]any), sd["audio"].(map[string]any)
	if sd["details_read"] != true || file["name"] != "IMG_4869.MOV" || file["container"] != "mov" || video["codec"] != "hevc" ||
		video["profile"] != "Main 10" || video["bit_depth"] != 10.0 || video["rotation"] != -90.0 || video["fps"] != 30.0 ||
		video["color_transfer"] != nil || audio["codec"] != "aac" || audio["channels"] != 2.0 || audio["sample_rate"] != 44100.0 ||
		sd["source_crop"] != "1920:800:0:140" || sd["stereo"].(map[string]any)["spatial"] != false ||
		sd["camera"].(map[string]any)["model"] != "iPhone 15 Pro Max" {
		t.Fatalf("details %v", sd)
	}
	if _, leaked := out["probe"].(map[string]any)["details"]; leaked {
		t.Fatal("raw details in probe")
	}
	on := pricing.DefaultsFor("test")
	on.LifelikeHDROutputEnabled = true
	s.Pricing = pricing.NewStatic(on)
	if v := viewJSON(t, s.projectResponse(p, nil))["source_details"].(map[string]any)["video"].(map[string]any); v["color_transfer"] != "arib-std-b67" || v["color_primaries"] != "bt2020" {
		t.Fatalf("colour while HDR on %v", v)
	}
	old := *p
	pr := *p.Probe
	pr.Details = nil
	old.Probe = &pr
	sd = viewJSON(t, s.projectResponse(&old, nil))["source_details"].(map[string]any)
	if sd["details_read"] != false || sd["audio"] != nil || sd["stereo"] != nil || sd["video"].(map[string]any)["codec"] != nil || sd["video"].(map[string]any)["fps"] != 30.0 {
		t.Fatalf("before %v", sd)
	}
	if _, err := s.Store.UpdateProject(context.Background(), p.ID, func(x *store.Project) error { x.Crop = p.Crop; return nil }); err != nil {
		t.Fatal(err)
	}
	src := viewJSON(t, s.adminSourceJSON(context.Background(), p.ID, map[string]*store.Project{}))
	if src["probe"] == nil || src["source_bytes"] == nil || src["has_bars"] != true || src["crop"] != p.Crop || src["remove_bars"] != true ||
		src["source_details"].(map[string]any)["video"].(map[string]any)["color_transfer"] != "arib-std-b67" {
		t.Fatalf("console %v", src)
	}
	if s.adminSourceJSON(context.Background(), "", nil) != nil {
		t.Fatal("no project")
	}
}

// The upload's file name reaches the project; a name sent at creation
// wins; paths and control characters are dropped.
func TestSourceFilename(t *testing.T) {
	if got := cleanFilename(`C:\Users\me\Videos\Trip` + "\x00" + `.mov`); got != "Trip.mov" {
		t.Fatalf("%q", got)
	}
	if got := cleanFilename("  "); got != "" {
		t.Fatalf("%q", got)
	}
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	id := store.NewID()
	if err := s.Store.PutUploadName(ctx, id, uid, "Beach day.MOV"); err != nil {
		t.Fatal(err)
	}
	if s.Store.UploadName(ctx, id, uid) != "Beach day.MOV" || s.Store.UploadName(ctx, id, "someone-else") != "" {
		t.Fatal("upload name")
	}
}
