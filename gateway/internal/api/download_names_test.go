package api

import (
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// S3D-31: <stem>_<resolution>[_partN]_<layout>.<ext>, unique per project.
func TestProjectDownloadNames(t *testing.T) {
	p := lifelikeProject()
	p.Name = "Holiday 2026.mp4"
	t0 := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)
	run := func(id string, h int, params store.Params, outputs map[string]string) *store.Conversion {
		return &store.Conversion{ID: id, State: store.StateSucceeded, CreatedAt: t0.Add(time.Duration(h) * time.Hour),
			Params: params, Outputs: outputs}
	}
	k := func(f string) string { return "stereo3d/test/outputs/job/" + f }
	convs := []*store.Conversion{
		run("b", 2, store.Params{Preset: "4k"}, map[string]string{"mvhevc": k("mvhevc.mov"), "sbs": k("sbs.mp4")}),
		run("a", 1, store.Params{Preset: "4k"}, map[string]string{"mvhevc": k("mvhevc.mov"), "half_sbs": k("half_sbs.mp4")}),
		run("c", 3, store.Params{Preset: "qhd"}, map[string]string{"mvhevc_part01": k("mvhevc_part01.mov"), "mvhevc_part02": k("mvhevc_part02.mov")}),
		run("d", 4, store.Params{Preset: "3k", Quality: "full"}, map[string]string{"tb": k("tb.mp4"), "half_tb": k("half_tb.mp4")}),
		{ID: "failed", State: store.StateFailed, Params: store.Params{Preset: "4k"}, Outputs: map[string]string{"mvhevc": k("x.mov")}},
	}
	p.Probe.Width, p.Probe.Height = 3840, 1607 // full at 3k renders 1606p
	names := projectDownloadNames(p, convs)
	want := map[string]map[string]string{
		"a": {"mvhevc": "Holiday 2026_4K_spatial.mov", "half_sbs": "Holiday 2026_4K_HSBS.mp4"},
		"b": {"mvhevc": "Holiday 2026_4K_spatial (2).mov", "sbs": "Holiday 2026_4K_SBS.mp4"},
		"c": {"mvhevc_part01": "Holiday 2026_1440p_part1_spatial.mov", "mvhevc_part02": "Holiday 2026_1440p_part2_spatial.mov"},
		"d": {"tb": "Holiday 2026_1606p_TB.mp4", "half_tb": "Holiday 2026_1606p_HTB.mp4"},
	}
	for id, outs := range want {
		for o, w := range outs {
			if got := names[id][o]; got != w {
				t.Errorf("%s/%s: got %q want %q", id, o, got, w)
			}
		}
	}
	if _, ok := names["failed"]; ok {
		t.Error("failed runs have no files")
	}
}

func TestDownloadStem(t *testing.T) {
	if got := downloadStem("  a/b\\c:d\"e.mov "); got != "a-b-c-de" {
		t.Errorf("cleaned: %q", got)
	}
	if downloadStem("") != "video" {
		t.Error("empty → video")
	}
	long := strings.Repeat("日", 100) // 300 bytes
	got := downloadStem(long)
	if len(got) > 200 || !strings.HasPrefix(long, got) || len(got)%3 != 0 {
		t.Errorf("cut at a character boundary within 200 bytes: %d bytes", len(got))
	}
}

func TestContentDisposition(t *testing.T) {
	got := contentDisposition(`東京 trip "1"_4K_spatial.mov`)
	if !strings.HasPrefix(got, `attachment; filename="__ trip _1__4K_spatial.mov"; filename*=UTF-8''`) {
		t.Errorf("ascii fallback: %s", got)
	}
	if !strings.Contains(got, "%E6%9D%B1%E4%BA%AC%20trip%20%221%22_4K_spatial.mov") {
		t.Errorf("utf-8 name: %s", got)
	}
}
