package api

import (
	"encoding/json"
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The worker's field rules (lifelike3d 84e3eb3 answers 400 otherwise):
// intro_s an integer in {3,4} (0 = omitted), split_max_seconds an integer
// ≥ 10 (the gateway's own floor is 60) or omitted, max_gpu_workers ≥ 1,
// source_crop even integers with w and h ≥ 256, inside the frame.
func TestLifelikeBodyWorkerRules(t *testing.T) {
	p := lifelikeProject()
	p.Probe.Width, p.Probe.Height = 1920, 1080
	p.Crop = "1915:803:3:139" // cropdetect's odd numbers
	crop, ok := barsCrop(p)
	if !ok {
		t.Fatal("bars")
	}
	for _, intro := range []int{0, 3, 4} {
		secs := intro
		c := &store.Conversion{Params: store.Params{Preset: "1080p", Formats: []string{"mvhevc"}, IntroS: &secs, SplitMaxSeconds: 60,
			RemoveBars: true, SourceCrop: &crop}}
		c.Source.GCSKey = "stereo3d/test/users/u/p/source.mp4"
		raw, _ := json.Marshal(lifelikeBody(c, 0))
		body := string(raw)
		var b map[string]json.RawMessage
		json.Unmarshal(raw, &b)
		if intro == 0 && strings.Contains(body, `"intro_s"`) || intro > 0 && string(b["intro_s"]) != map[int]string{3: "3", 4: "4"}[intro] {
			t.Fatalf("intro_s %d: %s", intro, b["intro_s"])
		}
		if string(b["split_max_seconds"]) != "60" || string(b["max_gpu_workers"]) != "1" {
			t.Fatalf("split/gpus %s", body)
		}
		var sc struct{ X, Y, W, H json.Number }
		json.Unmarshal(b["source_crop"], &sc)
		for _, v := range []json.Number{sc.X, sc.Y, sc.W, sc.H} {
			n, err := v.Int64()
			if err != nil || n%2 != 0 || strings.Contains(v.String(), ".") {
				t.Fatalf("source_crop %s", b["source_crop"])
			}
		}
		if w, _ := sc.W.Int64(); w < 256 {
			t.Fatal("w")
		}
		x, _ := sc.X.Int64()
		w, _ := sc.W.Int64()
		if x+w > 1920 {
			t.Fatalf("off the frame %s", b["source_crop"])
		}
	}
	// a crop under 256 a side is never sent
	p.Crop = "250:1080:835:0"
	if _, ok := barsCrop(p); ok {
		t.Fatal("a 250 px crop")
	}
	// no split: omitted, never 0 or null
	c := &store.Conversion{Params: store.Params{Preset: "1080p"}}
	if raw, _ := json.Marshal(lifelikeBody(c, 4)); strings.Contains(string(raw), "split_max_seconds") || strings.Contains(string(raw), "intro_s") {
		t.Fatalf("absent fields sent: %s", raw)
	}
}
