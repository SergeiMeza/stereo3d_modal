package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Owner bug 2026-11-07: the "Sunset session" sample made a new account's
// first upload its second project, so the intro preview the onboarding
// promises free was priced at $1.00. The sample doesn't count; deleted
// projects don't either, because the intro is taken once per account.
func TestIntroPreviewWithSample(t *testing.T) {
	s, _, uid := splitFixture(t, 0)
	ctx := context.Background()
	newProject := func() *store.Project {
		p := barsProject(3840, 2160, "3840:2160:0:0")
		p.ID, p.UID, p.Source.GCSKey, p.Analyze.State = store.NewID(), uid, "stereo3d/test/uploads/x.mp4", store.AnalyzeSucceeded
		p.Scenes = &store.Scenes{Version: 1, Cuts: []int{}}
		if err := s.Store.CreateProject(ctx, p); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond) // created_at order
		return p
	}
	quote := func(p *store.Project) map[string]any {
		r := httptest.NewRequest("POST", "/", strings.NewReader(`{"step":"lifelike_preview","preset":"4k","from_frame":0,"to_frame":120}`))
		w := httptest.NewRecorder()
		s.HandleQuoteStep(w, r, &AuthedUser{UID: uid}, p.ID)
		var out map[string]any
		json.Unmarshal(w.Body.Bytes(), &out)
		if w.Code != 200 {
			t.Fatalf("quote %d %s", w.Code, w.Body)
		}
		return out
	}
	free := func(q map[string]any) bool {
		fp, _ := q["free_previews"].(map[string]any)
		return fp["free"] == true && q["payment_flow"] == store.FlowFreePreview
	}
	// the sample, as a new account's first list makes it
	sample := &store.Project{ID: sampleProjectID(uid), UID: uid, Sample: true, Name: "Sunset session", Method: store.MethodLifelike}
	if err := s.Store.CreateProject(ctx, sample); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	first := newProject()
	if q := quote(first); !free(q) {
		t.Fatalf("sample + first upload: %v %v", q["free_previews"], q["payment_flow"])
	}
	// a full run's quote on that project isn't free (the intro is for a
	// preview): free_previews.free false, a paid flow
	{
		r := httptest.NewRequest("POST", "/", strings.NewReader(`{"step":"production","preset":"4k"}`))
		w := httptest.NewRecorder()
		s.HandleQuoteStep(w, r, &AuthedUser{UID: uid}, first.ID)
		var q map[string]any
		json.Unmarshal(w.Body.Bytes(), &q)
		fp, _ := q["free_previews"].(map[string]any)
		if w.Code != 200 || fp["free"] != false || fp["intro"] != true || q["payment_flow"] == store.FlowFreePreview {
			t.Fatalf("full run quote %d %v %v", w.Code, fp, q["payment_flow"])
		}
	}
	// a second project of its own: no intro
	second := newProject()
	if q := quote(second); free(q) {
		t.Fatalf("second project: %v", q["free_previews"])
	}
	// delete the second: the first is the only one again, intro still unused
	s.Store.UpdateProject(ctx, second.ID, func(p *store.Project) error { p.Deleted = true; return nil })
	if q := quote(first); !free(q) {
		t.Fatalf("after deleting an unused project: %v", q["free_previews"])
	}
	// the intro used, the project deleted and a new upload: no second one
	day := time.Now().UTC().Format("2006-01-02")
	if ok, err := s.Store.ConsumeFreePreviews(ctx, uid, "intro", day, 1, 1, 5, true); !ok || err != nil {
		t.Fatalf("consume %v %v", ok, err)
	}
	s.Store.UpdateProject(ctx, first.ID, func(p *store.Project) error { p.Deleted = true; return nil })
	again := newProject()
	if q := quote(again); free(q) {
		t.Fatalf("re-upload after the intro: %v", q["free_previews"])
	}
}
