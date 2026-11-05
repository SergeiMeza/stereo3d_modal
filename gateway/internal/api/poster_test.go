package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/probe"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The project's picture is analyze's poster (a non-black frame, 3DS QA
// 2026-11-05: a video opening on black showed an all-black card); a
// project analyzed before it reads the first scene's keyframe as before.
func TestAnalyzePoster(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	thumbs := map[string]any{
		"strip":  []any{map[string]any{"frame": 0, "url": "https://cdn/strip_1.jpg"}, map[string]any{"frame": 24, "url": "https://cdn/strip_2.jpg"}},
		"scenes": []any{map[string]any{"scene": 0, "frame": 12, "url": "https://cdn/scene_1.jpg"}},
		"poster": map[string]any{"frame": 24, "url": "https://cdn/poster_1.jpg"},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		meta := map[string]any{"probe": map[string]any{"width": 1920, "height": 1080, "fps": 24, "duration": 10, "num_frames": 240},
			"thumbnails": thumbs}
		json.NewEncoder(w).Encode(map[string]any{"job_id": "j1", "status": "completed", "metadata": meta})
	}))
	t.Cleanup(srv.Close)
	s.Modal = modalapi.New(srv.URL, "", "")
	prev := countSource
	countSource = func(context.Context, *Service, *store.Project) (*probe.Counted, error) { return nil, nil }
	t.Cleanup(func() { countSource = prev })
	p := &store.Project{ID: store.NewID(), UID: "u" + store.NewID(), Method: store.MethodLifelike,
		Source: store.Source{GCSKey: "k", Bytes: 1 << 20}, Analyze: store.Analyze{State: store.AnalyzeRunning, JobID: "j1"}}
	if err := s.Store.CreateProject(ctx, p); err != nil {
		t.Fatal(err)
	}
	got, err := s.refreshAnalyze(ctx, p)
	if err != nil || got.Poster == nil || got.Poster.Frame != 24 || got.Poster.URL != "https://cdn/poster_1.jpg" {
		t.Fatalf("poster %+v %v", got, err)
	}
	resp := s.projectResponse(got, nil)
	if ps, _ := resp["poster"].(*store.Thumb); ps == nil || ps.URL != "https://cdn/poster_1.jpg" {
		t.Fatalf("response poster %v", resp["poster"])
	}
	if sc := resp["scene_thumbs"].([]store.Thumb); sc[0].URL != "https://cdn/scene_1.jpg" {
		t.Fatalf("scene thumbs stay per scene %v", sc)
	}
	// analyzed before the poster: the first scene's keyframe, as before
	old := &store.Project{SceneThumbs: []store.Thumb{{Frame: 12, URL: "https://cdn/scene_1.jpg"}}, StripThumbs: []store.Thumb{{URL: "https://cdn/strip_1.jpg"}}}
	if ps := projectPoster(old); ps == nil || ps.URL != "https://cdn/scene_1.jpg" {
		t.Fatalf("old project %+v", ps)
	}
	if projectPoster(&store.Project{}) != nil {
		t.Fatal("no thumbnails, no poster")
	}
}
