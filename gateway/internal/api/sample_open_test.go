package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
	if len(convs) != 1 {
		t.Fatalf("runs %v", convs)
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
	if code != 200 || len(files) != 2 {
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
