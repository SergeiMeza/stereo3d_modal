package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// A fresh account opens its sample end to end, through the same id check
// the routes run: list → project → its run → downloads, all 200.
func TestSampleOpensEndToEnd(t *testing.T) {
	s, _ := e0Service(t)
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	user := &AuthedUser{UID: "u" + store.NewID()}
	call := func(h func(http.ResponseWriter, *http.Request, *AuthedUser, string), id string) (int, map[string]any) {
		t.Helper()
		if !ValidResourceID(id) {
			t.Fatalf("the routes refuse id %q", id)
		}
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest("GET", "/", nil), user, id)
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	rec := httptest.NewRecorder()
	s.HandleListProjects(rec, httptest.NewRequest("GET", "/v1/projects", nil), user)
	var list map[string]any
	json.Unmarshal(rec.Body.Bytes(), &list)
	sp := list["projects"].([]any)[0].(map[string]any)
	pid := sp["project_id"].(string)
	if !strings.HasPrefix(sp["preview_url"].(string), "https://cdn.public.spatial-video-studio.com/samples/2026-11/") {
		t.Fatalf("preview %v", sp["preview_url"])
	}

	code, proj := call(s.HandleGetProject, pid)
	if code != 200 || proj["sample"] != true {
		t.Fatalf("project %d %v", code, proj)
	}
	convs := proj["conversions"].([]any)
	// 4K first (the newest), then 3K, 1440p and 1080p (owner 2026-11-07)
	if len(convs) != 4 || convs[0].(map[string]any)["params"].(map[string]any)["preset"] != "4k" {
		t.Fatalf("runs %v", convs)
	}
	for i, want := range []string{"4k", "3k", "qhd", "1080p"} {
		if got := convs[i].(map[string]any)["params"].(map[string]any)["preset"]; got != want {
			t.Fatalf("run %d is %v, want %s", i, got, want)
		}
	}
	cid := convs[0].(map[string]any)["conversion_id"].(string)

	code, conv := call(s.HandleGetConversion, cid)
	if code != 200 || conv["state"] != "succeeded" || conv["sample"] != true || conv["project_id"] != pid {
		t.Fatalf("conversion %d %v", code, conv)
	}
	if q, _ := conv["quote"].(map[string]any); q != nil && q["amount_cents"] != float64(0) {
		t.Fatalf("not $0: %v", q)
	}

	code, dl := call(s.HandleDownloads, cid)
	files, _ := dl["files"].([]any)
	if code != 200 || len(files) != 3 { // spatial, full and half SBS
		t.Fatalf("downloads %d %v", code, dl)
	}
	for _, f := range files {
		u := f.(map[string]any)["url"].(string)
		if !strings.HasPrefix(u, "https://cdn.public.spatial-video-studio.com/samples/2026-11/sunset-session-") {
			t.Fatalf("file url %s", u)
		}
	}
	rec = httptest.NewRecorder()
	s.HandleLogPlay(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{"file":"x","kind":"view_in_3d"}`)), user, cid)
	if rec.Code != 200 {
		t.Fatalf("play %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.HandleCreateHandoff(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{}`)), user, cid)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"sample":true`) {
		t.Fatalf("handoff %d %s", rec.Code, rec.Body)
	}
}

// A sample made with the old "smp…" id (the routes refused it) is retired
// for one with a proper id on the next list.
func TestLegacySampleReplaced(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	old := &store.Project{ID: "smp" + store.NewID()[:9], UID: uid, Sample: true, Method: store.MethodLifelike}
	s.Store.CreateProject(ctx, old)
	rec := httptest.NewRecorder()
	s.HandleListProjects(rec, httptest.NewRequest("GET", "/v1/projects", nil), &AuthedUser{UID: uid})
	var list map[string]any
	json.Unmarshal(rec.Body.Bytes(), &list)
	ps := list["projects"].([]any)
	if len(ps) != 1 || ps[0].(map[string]any)["project_id"] != sampleProjectID(uid) {
		t.Fatalf("list %v", ps)
	}
	if got, _ := s.Store.GetProject(ctx, old.ID); got == nil || !got.Deleted {
		t.Fatalf("legacy not retired %+v", got)
	}
}

// An account whose sample has only the 4K run (stored before 2026-11-07)
// gets the 1080p, 1440p and 3K runs once on its list path; the 4K run
// stays the newest.
func TestSampleSizesBackfilled(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	p := &store.Project{ID: sampleProjectID(uid), UID: uid, Name: "Sunset session", Method: store.MethodLifelike, Sample: true,
		Analyze: store.Analyze{State: store.AnalyzeSucceeded}}
	if err := s.Store.CreateProject(ctx, p); err != nil {
		t.Fatal(err)
	}
	old := &store.Conversion{ID: sampleRunID(uid), UID: uid, Sample: true, Kind: "video", ProjectID: p.ID, Step: store.StepProduction,
		Method: store.MethodLifelike, State: store.StateSucceeded, Params: store.Params{Preset: "4k", Formats: sampleFormats},
		Outputs: map[string]string{}, CreatedAt: time.Now().UTC().Add(-72 * time.Hour)}
	for name, f := range sampleFiles {
		old.Outputs[name] = f.URL
	}
	if err := s.Store.CreateConversionAt(ctx, old); err != nil {
		t.Fatal(err)
	}
	if _, added := s.ensureSample(ctx, uid, []*store.Project{p}); added {
		t.Fatal("a second sample")
	}
	convs, _ := s.Store.ListProjectConversions(ctx, p.ID, 10)
	if len(convs) != 4 || convs[0].ID != old.ID {
		t.Fatalf("runs %d, first %s", len(convs), convs[0].Params.Preset)
	}
	for _, c := range convs[1:] {
		if !c.Sample || !c.CreatedAt.Before(old.CreatedAt) || c.Outputs["mvhevc"] == old.Outputs["mvhevc"] {
			t.Fatalf("size run %+v", c)
		}
	}
	backfilledSamples.Delete(uid) // another instance: still once
	s.ensureSample(ctx, uid, []*store.Project{p})
	if again, _ := s.Store.ListProjectConversions(ctx, p.ID, 10); len(again) != 4 {
		t.Fatalf("backfilled twice: %d", len(again))
	}
}
