package api

import (
	"context"
	"encoding/json"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/gcsx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/probe"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The worker's figures first (in the output's object or metadata), only
// when it measured them; ffprobe fills the rest; the run JSON shows them.
func TestOutputsMedia(t *testing.T) {
	job := &modalapi.Job{Outputs: map[string]json.RawMessage{
		"mvhevc":   json.RawMessage(`{"url":"https://storage.googleapis.com/b/stereo3d/test/o/mvhevc.mov","video_kbps":38250.5,"audio_codec":"aac","audio_kbps":192}`),
		"sbs":      json.RawMessage(`"https://storage.googleapis.com/b/stereo3d/test/o/sbs.mp4"`),
		"half_sbs": json.RawMessage(`{"url":"https://storage.googleapis.com/b/stereo3d/test/o/half_sbs.mp4","video_kbps":null}`),
	}, Metadata: json.RawMessage(`{"outputs_media":{"sbs":{"video_kbps":20100,"audio_codec":null,"audio_kbps":null}},"output_bit_depth":8,"output_bit_depth_reason":"10-bit encoder unavailable"}`)}
	if d, why := job.BitDepth(); d != 8 || why != "10-bit encoder unavailable" {
		t.Fatalf("bit depth %d %q", d, why)
	}
	kept := map[string]string{"mvhevc": "k1", "sbs": "k2", "half_sbs": "k3"}
	got := workerOutputsMedia(job, kept)
	if got["mvhevc"].VideoKbps != 38250.5 || got["mvhevc"].AudioCodec != "aac" || got["mvhevc"].Source != "worker" ||
		got["sbs"].VideoKbps != 20100 || got["sbs"].AudioCodec != "" {
		t.Fatalf("worker %+v", got)
	}
	if _, ok := got["half_sbs"]; ok {
		t.Fatal("a null figure counts as measured")
	}

	s, _ := e0Service(t)
	s.GCS = gcsx.NewWithSigner("x", "stereo3d/test/", nil, nil)
	ctx := context.Background()
	c := &store.Conversion{ID: store.NewID(), UID: "u" + store.NewID(), Kind: "video", ProjectID: "p1", State: store.StateSucceeded,
		Outputs: kept, OutputsMedia: got, Params: store.Params{OutputQuality: "master", Bitrate: bitrateMaster}}
	c.Modal.OutputBitDepth = 10
	if err := s.Store.CreateConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	prevProbe, prevURL := mediaProbe, outputURL
	t.Cleanup(func() { mediaProbe, outputURL = prevProbe, prevURL })
	outputURL = func(_ *Service, key string) (string, error) { return "https://signed/" + key, nil }
	probed := 0
	mediaProbe = func(_ context.Context, url string) (*probe.MediaRates, error) {
		probed++
		return &probe.MediaRates{VideoKbps: 0, OverallKbps: 19400}, nil // a stream without its own rate
	}
	s.fillOutputsMedia(ctx, c.ID)
	after, _ := s.Store.GetConversion(ctx, c.ID)
	hs := after.OutputsMedia["half_sbs"]
	if probed != 1 || hs.Source != "ffprobe" || hs.VideoKbps != 0 || hs.OverallKbps != 19400 || after.OutputsMedia["mvhevc"].Source != "worker" {
		t.Fatalf("filled %+v (probed %d)", after.OutputsMedia, probed)
	}
	resp := s.conversionResponse(after, nil)
	om, _ := json.Marshal(resp["outputs_media"])
	if string(om) == "null" || resp["bitrate_requested"] != bitrateMaster || resp["output_bit_depth"] != 10 || resp["quality"] != "master" {
		t.Fatalf("run JSON %s %v", om, resp["bitrate_requested"])
	}
	var shaped map[string]map[string]any
	json.Unmarshal(om, &shaped)
	if shaped["mvhevc"]["video_kbps"] != 38250.5 || shaped["half_sbs"]["overall_kbps"] != 19400.0 || shaped["half_sbs"]["video_kbps"] != nil {
		t.Fatalf("shape %s", om)
	}
}

// ffprobe's rates: the video stream's own, the first audio stream, the
// container's overall.
func TestParseMedia(t *testing.T) {
	m, err := probe.ParseMedia([]byte(`{"streams":[{"codec_type":"video","codec_name":"hevc","bit_rate":"38250512"},
		{"codec_type":"audio","codec_name":"aac","bit_rate":"192000"}],"format":{"bit_rate":"38460000"}}`))
	if err != nil || m.VideoKbps != 38250.5 || m.AudioCodec != "aac" || m.AudioKbps != 192 || m.OverallKbps != 38460 {
		t.Fatalf("%+v %v", m, err)
	}
	if _, err := probe.ParseMedia([]byte(`{"streams":[{"codec_type":"audio"}]}`)); err == nil {
		t.Fatal("no video")
	}
}

// An output object with a number in it (the worker's measured fields)
// still yields its URLs.
func TestCollectOutputsToleratesNumbers(t *testing.T) {
	s, _ := e0Service(t)
	s.GCS = gcsx.NewWithSigner("x", "stereo3d/test/", nil, nil)
	job := &modalapi.Job{Outputs: map[string]json.RawMessage{
		"mvhevc": json.RawMessage(`{"url":"https://storage.googleapis.com/x/stereo3d/test/o/m.mov","video_kbps":38250}`)}}
	out := s.collectOutputs(context.Background(), "c1", job)
	if len(out) != 1 {
		t.Fatalf("outputs %v", out)
	}
}

// A Standard run's repack goes at the stored file's measured rate (repack
// has no cap), at most the cap; High and Master keep their own target.
func TestRepackBitrate(t *testing.T) {
	std := &store.Conversion{Params: store.Params{OutputQuality: "standard", MaxBitrateBps: 40_000_000},
		OutputsMedia: map[string]store.OutputMedia{"mvhevc": {VideoKbps: 18000}}}
	if b := repackBitrate(std, "mvhevc"); b != 18_000_000 {
		t.Fatalf("measured %d", b)
	}
	if b := repackBitrate(std, "sbs"); b != 20_000_000 {
		t.Fatalf("unmeasured %d", b)
	}
	std.OutputsMedia["sbs"] = store.OutputMedia{VideoKbps: 90000}
	if b := repackBitrate(std, "sbs"); b != 40_000_000 {
		t.Fatalf("capped %d", b)
	}
	master := &store.Conversion{Params: store.Params{OutputQuality: "master", OutputBitrateBps: 60_000_000, BitDepth: 10}}
	if b := repackBitrate(master, "mvhevc"); b != 60_000_000 {
		t.Fatalf("master %d", b)
	}
	if b := repackBitrate(&store.Conversion{}, "mvhevc"); b != 0 {
		t.Fatalf("app run %d", b)
	}
}

// The console's run rows carry quality, bitrate_requested and
// outputs_media.
func TestAdminRunMedia(t *testing.T) {
	c := &store.Conversion{ID: "r1", ProjectID: "p1", Params: store.Params{OutputQuality: "high"},
		OutputsMedia: map[string]store.OutputMedia{"sbs": {VideoKbps: 40000, Source: "worker"}}}
	out := adminRunJSON(c)
	if out["quality"] != "high" || out["bitrate_requested"] != "auto" || out["outputs_media"] == nil {
		t.Fatalf("%v", out)
	}
	if out := adminRunJSON(&store.Conversion{ID: "r2"}); out["quality"] != nil || out["bitrate_requested"] != nil || out["outputs_media"] != nil {
		t.Fatalf("%v", out)
	}
}
